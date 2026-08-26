import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import type { CredentialVault } from "../../application/ports/a2a-ports.js";
import type {
  RemoteAccessControl,
  RemoteAccessStoredDevice,
  RemoteAccessStoredState,
  RemoteAccessStore,
  RemoteCommandHandler,
} from "../../application/ports/remote-access.js";
import type { Clock } from "../../application/ports/runtime-store.js";
import {
  REMOTE_MAX_FRAME_BYTES,
  REMOTE_PAIRING_TTL_MS,
  REMOTE_PROTOCOL_VERSION,
  type RemoteAccessStatusDto,
  type RemoteCommand,
  type RemoteEncryptedFrame,
  type RemoteHandshakeHello,
  type RemotePairingDto,
} from "../../../shared/remote.js";
import {
  createRemoteNonce,
  createRemoteSecret,
  decryptRemotePayload,
  deriveRemoteSessionKey,
  encryptRemotePayload,
  remoteReadyProof,
  RemoteReplayGuard,
  verifyRemoteHandshakeProof,
} from "./remote-frame-crypto.js";

interface ActivePairing {
  deviceId: string;
  expiresAt: string;
  pairingId: string;
  qrUrl: string;
  secret: string;
}

interface BrowserSession {
  connectionId: string;
  deviceId?: string;
  inbound: RemoteReplayGuard;
  key?: Buffer;
  outboundSequence: number;
}

function relayWebSocketUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else throw new Error("remote_relay_url_invalid");
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/host`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function assertRelayUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("remote_relay_url_invalid");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function isHandshake(value: unknown): value is RemoteHandshakeHello {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Partial<RemoteHandshakeHello>;
  return item.kind === "handshake.hello" && item.version === REMOTE_PROTOCOL_VERSION
    && (item.mode === "pair" || item.mode === "resume") && typeof item.hostId === "string"
    && typeof item.deviceId === "string" && typeof item.deviceName === "string"
    && typeof item.clientNonce === "string" && typeof item.proof === "string";
}

function isEncryptedFrame(value: unknown): value is RemoteEncryptedFrame {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Partial<RemoteEncryptedFrame>;
  return item.kind === "encrypted" && Number.isSafeInteger(item.seq) && typeof item.ciphertext === "string"
    && typeof item.iv === "string" && typeof item.tag === "string";
}

function isRemoteCommand(value: unknown): value is RemoteCommand {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Partial<RemoteCommand>;
  if (item.kind === "feed.get") return typeof item.requestId === "string" && item.requestId.length <= 160;
  return item.kind === "message.send" && typeof item.requestId === "string" && item.requestId.length <= 160
    && typeof item.idempotencyKey === "string" && item.idempotencyKey.length <= 240
    && typeof item.text === "string" && item.text.length <= 32_000;
}

export class RemoteAccessHost implements RemoteAccessControl {
  readonly #clock: Clock;
  readonly #commands: RemoteCommandHandler;
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #store: RemoteAccessStore;
  readonly #vault: CredentialVault;
  #pairing: ActivePairing | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #socket: WebSocket | undefined;
  #state: RemoteAccessStoredState | undefined;
  #status: RemoteAccessStatusDto["status"] = "disabled";
  #stopped = false;

  constructor(input: { clock: Clock; commands: RemoteCommandHandler; store: RemoteAccessStore; vault: CredentialVault }) {
    this.#clock = input.clock;
    this.#commands = input.commands;
    this.#store = input.store;
    this.#vault = input.vault;
  }

  async start(): Promise<void> {
    const loaded = await this.#store.load();
    this.#state = loaded ?? { devices: [], enabled: false, hostId: `host_${randomUUID()}`, relayUrl: "", version: 1 };
    if (loaded === null) await this.#store.save(this.#state);
    this.#stopped = false;
    if (this.#state.enabled) this.#connect();
  }

  close(): Promise<void> {
    this.#stopped = true;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#socket?.terminate();
    this.#socket = undefined;
    this.#sessions.clear();
    this.#status = this.#state?.enabled === true ? "error" : "disabled";
    return Promise.resolve();
  }

  status(): Promise<RemoteAccessStatusDto> {
    const state = this.#requireState();
    if (this.#pairing !== undefined && Date.parse(this.#pairing.expiresAt) <= this.#clock.now().getTime()) this.#pairing = undefined;
    return Promise.resolve({
      devices: state.devices.map(({ createdAt, deviceId, lastSeenAt, name }) => ({ createdAt, deviceId, lastSeenAt, name })),
      enabled: state.enabled,
      hostId: state.hostId,
      relayAuthenticationConfigured: state.encryptedRelayAuthentication !== undefined,
      relayUrl: state.relayUrl,
      status: state.enabled ? this.#status : "disabled",
      ...(this.#pairing === undefined ? {} : { pairing: {
        expiresAt: this.#pairing.expiresAt,
        pairingId: this.#pairing.pairingId,
        qrUrl: this.#pairing.qrUrl,
      } }),
    });
  }

  async update(input: { enabled?: boolean; relayAuthentication?: string | null; relayUrl?: string }): Promise<RemoteAccessStatusDto> {
    const current = this.#requireState();
    const relayUrl = input.relayUrl === undefined ? current.relayUrl : assertRelayUrl(input.relayUrl);
    let encryptedRelayAuthentication = current.encryptedRelayAuthentication;
    if (input.relayAuthentication === null) encryptedRelayAuthentication = undefined;
    else if (input.relayAuthentication !== undefined) {
      const clean = input.relayAuthentication.trim();
      if (clean.length < 16 || clean.length > 512) throw new Error("remote_relay_authentication_invalid");
      if (!this.#vault.isAvailable()) throw new Error("remote_credential_encryption_unavailable");
      encryptedRelayAuthentication = await this.#vault.encrypt(clean);
    }
    const enabled = input.enabled ?? current.enabled;
    if (enabled && (relayUrl === "" || encryptedRelayAuthentication === undefined)) throw new Error("remote_relay_configuration_incomplete");
    this.#state = {
      ...current,
      enabled,
      ...(encryptedRelayAuthentication === undefined ? {} : { encryptedRelayAuthentication }),
      relayUrl,
    };
    if (encryptedRelayAuthentication === undefined) delete this.#state.encryptedRelayAuthentication;
    await this.#store.save(this.#state);
    this.#socket?.terminate();
    this.#socket = undefined;
    if (enabled) this.#connect();
    else this.#status = "disabled";
    return this.status();
  }

  createPairing(): Promise<RemotePairingDto> {
    const state = this.#requireState();
    if (!state.enabled || state.relayUrl === "") throw new Error("remote_access_disabled");
    const pairingId = `pair_${randomUUID()}`;
    const deviceId = `device_${randomUUID()}`;
    const secret = createRemoteSecret();
    const expiresAt = new Date(this.#clock.now().getTime() + REMOTE_PAIRING_TTL_MS).toISOString();
    const qrUrl = new URL("/remote/", state.relayUrl);
    qrUrl.hash = new URLSearchParams({
      device: deviceId,
      host: state.hostId,
      pairing: pairingId,
      secret,
      v: String(REMOTE_PROTOCOL_VERSION),
    }).toString();
    this.#pairing = { deviceId, expiresAt, pairingId, qrUrl: qrUrl.toString(), secret };
    return Promise.resolve({ expiresAt, pairingId, qrUrl: qrUrl.toString() });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const state = this.#requireState();
    const devices = state.devices.filter((device) => device.deviceId !== deviceId);
    if (devices.length === state.devices.length) throw new Error("remote_device_not_found");
    this.#state = { ...state, devices };
    await this.#store.save(this.#state);
    for (const [connectionId, session] of this.#sessions) {
      if (session.deviceId === deviceId) this.#reject(connectionId);
    }
  }

  #requireState(): RemoteAccessStoredState {
    if (this.#state === undefined) throw new Error("remote_access_not_started");
    return this.#state;
  }

  #connect(): void {
    if (this.#stopped || this.#socket !== undefined) return;
    const state = this.#requireState();
    if (!state.enabled || state.encryptedRelayAuthentication === undefined) return;
    this.#status = "connecting";
    void this.#vault.decrypt(state.encryptedRelayAuthentication).then((relayAuthentication) => {
      if (this.#stopped || this.#socket !== undefined) return;
      const socket = new WebSocket(relayWebSocketUrl(state.relayUrl), {
        headers: { authorization: `Bearer ${relayAuthentication}` },
        maxPayload: REMOTE_MAX_FRAME_BYTES,
      });
      this.#socket = socket;
      socket.on("open", () => socket.send(JSON.stringify({ hostId: state.hostId, kind: "host.register" })));
      socket.on("message", (data) => {
        void this.#handleRelayMessage(data).catch(() => undefined);
      });
      socket.on("error", () => undefined);
      socket.on("close", () => {
        if (this.#socket === socket) this.#socket = undefined;
        this.#sessions.clear();
        this.#status = "error";
        this.#scheduleReconnect();
      });
    }).catch(() => {
      this.#status = "error";
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#state?.enabled !== true || this.#reconnectTimer !== undefined) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, 2_000);
    this.#reconnectTimer.unref();
  }

  async #handleRelayMessage(data: WebSocket.RawData): Promise<void> {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
    const message = JSON.parse(text) as Record<string, unknown>;
    if (message.kind === "host.registered") {
      this.#status = "connected";
      return;
    }
    if (typeof message.connectionId !== "string") return;
    if (message.kind === "browser.open") {
      this.#sessions.set(message.connectionId, {
        connectionId: message.connectionId,
        inbound: new RemoteReplayGuard(),
        outboundSequence: 0,
      });
      return;
    }
    if (message.kind === "browser.close") {
      this.#sessions.delete(message.connectionId);
      return;
    }
    if (message.kind !== "browser.frame") return;
    const session = this.#sessions.get(message.connectionId);
    if (session === undefined) return;
    if (session.key === undefined) await this.#handleHandshake(session, message.frame);
    else await this.#handleEncryptedCommand(session, message.frame);
  }

  async #handleHandshake(session: BrowserSession, value: unknown): Promise<void> {
    if (!isHandshake(value)) { this.#reject(session.connectionId); return; }
    const state = this.#requireState();
    if (value.hostId !== state.hostId || value.deviceId.length > 160 || value.deviceName.length > 80) {
      this.#reject(session.connectionId); return;
    }
    let secret: string;
    let pairing: ActivePairing | undefined;
    if (value.mode === "pair") {
      pairing = this.#pairing;
      if (pairing === undefined || value.pairingId !== pairing.pairingId || value.deviceId !== pairing.deviceId
        || Date.parse(pairing.expiresAt) <= this.#clock.now().getTime()) { this.#reject(session.connectionId); return; }
      secret = pairing.secret;
    } else {
      const device = state.devices.find((item) => item.deviceId === value.deviceId);
      if (device === undefined || !this.#vault.isAvailable()) { this.#reject(session.connectionId); return; }
      secret = await this.#vault.decrypt(device.encryptedSecret);
    }
    const context = {
      clientNonce: value.clientNonce,
      deviceId: value.deviceId,
      hostId: value.hostId,
      mode: value.mode,
      pairingId: value.pairingId ?? "",
    };
    if (!verifyRemoteHandshakeProof(secret, context, value.proof)) { this.#reject(session.connectionId); return; }
    const hostNonce = createRemoteNonce();
    session.deviceId = value.deviceId;
    session.key = deriveRemoteSessionKey(secret, value.clientNonce, hostNonce);
    if (pairing !== undefined) {
      const now = this.#clock.now().toISOString();
      const device: RemoteAccessStoredDevice = {
        createdAt: now,
        deviceId: value.deviceId,
        encryptedSecret: await this.#vault.encrypt(secret),
        lastSeenAt: now,
        name: value.deviceName.trim() || "浏览器设备",
      };
      this.#state = { ...state, devices: [...state.devices.filter((item) => item.deviceId !== device.deviceId), device] };
      await this.#store.save(this.#state);
      this.#pairing = undefined;
    } else {
      await this.#touchDevice(value.deviceId);
    }
    this.#send({
      connectionId: session.connectionId,
      frame: {
        hostNonce,
        kind: "handshake.ready",
        proof: remoteReadyProof(secret, context, hostNonce),
        version: REMOTE_PROTOCOL_VERSION,
      },
      kind: "host.frame",
    });
  }

  async #handleEncryptedCommand(session: BrowserSession, value: unknown): Promise<void> {
    if (!isEncryptedFrame(value) || session.key === undefined) { this.#reject(session.connectionId); return; }
    try {
      session.inbound.accept(value.seq);
      const command = decryptRemotePayload(session.key, value, session.connectionId);
      if (!isRemoteCommand(command)) { this.#reject(session.connectionId); return; }
      const response = await this.#commands.handle(command);
      session.outboundSequence += 1;
      this.#send({
        connectionId: session.connectionId,
        frame: encryptRemotePayload(session.key, session.outboundSequence, response, session.connectionId),
        kind: "host.frame",
      });
    } catch {
      this.#reject(session.connectionId);
    }
  }

  async #touchDevice(deviceId: string): Promise<void> {
    const state = this.#requireState();
    const now = this.#clock.now().toISOString();
    this.#state = { ...state, devices: state.devices.map((device) => device.deviceId === deviceId ? { ...device, lastSeenAt: now } : device) };
    await this.#store.save(this.#state);
  }

  #send(message: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  #reject(connectionId: string): void {
    this.#send({ connectionId, kind: "host.close" });
    this.#sessions.delete(connectionId);
  }
}
