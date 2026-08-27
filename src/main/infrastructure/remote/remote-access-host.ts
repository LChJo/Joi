import { randomBytes, randomUUID } from "node:crypto";

import type { CredentialVault } from "../../application/ports/a2a-ports.js";
import type {
  RemoteAccessControl,
  RemoteAccessStoredDevice,
  RemoteAccessStoredState,
  RemoteAccessStore,
  RemoteCommandHandler,
  RemotePeerTransport,
  RemotePeerTransportEvent,
  RemoteTransportTicket,
} from "../../application/ports/remote-access.js";
import type { Clock } from "../../application/ports/runtime-store.js";
import {
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

interface PeerSession {
  connectionId: string;
  deviceId?: string;
  inbound: RemoteReplayGuard;
  key?: Buffer;
  outboundSequence: number;
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
  readonly #sessions = new Map<string, PeerSession>();
  readonly #store: RemoteAccessStore;
  readonly #transport: RemotePeerTransport;
  readonly #vault: CredentialVault;
  #pairing: ActivePairing | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #state: RemoteAccessStoredState | undefined;
  #status: RemoteAccessStatusDto["status"] = "disabled";
  #stopped = false;
  #ticket: RemoteTransportTicket | undefined;
  #transportStarted = false;
  #transportGeneration = 0;
  #unsubscribe: (() => void) | undefined;

  constructor(input: { clock: Clock; commands: RemoteCommandHandler; store: RemoteAccessStore; transport: RemotePeerTransport; vault: CredentialVault }) {
    this.#clock = input.clock;
    this.#commands = input.commands;
    this.#store = input.store;
    this.#transport = input.transport;
    this.#vault = input.vault;
  }

  async start(): Promise<void> {
    const loaded = await this.#store.load();
    this.#state = loaded ?? {
      devices: [],
      enabled: false,
      hostId: `host_${randomUUID()}`,
      relayUrl: "https://remote.joilab.top",
      version: 3,
    };
    if (loaded === null) await this.#store.save(this.#state);
    this.#stopped = false;
    this.#unsubscribe = this.#transport.subscribe((event) => {
      void this.#handleTransportEvent(event).catch(() => undefined);
    });
    if (this.#state.enabled) await this.#connect();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    this.#transportGeneration += 1;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.#transport.close();
    this.#transportStarted = false;
    this.#ticket = undefined;
    this.#sessions.clear();
    this.#status = this.#state?.enabled === true ? "error" : "disabled";
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
    if (enabled && relayUrl === "") throw new Error("remote_relay_configuration_incomplete");
    this.#state = {
      ...current,
      enabled,
      ...(encryptedRelayAuthentication === undefined ? {} : { encryptedRelayAuthentication }),
      relayUrl,
    };
    if (encryptedRelayAuthentication === undefined) delete this.#state.encryptedRelayAuthentication;
    await this.#store.save(this.#state);
    this.#transportGeneration += 1;
    if (this.#transportStarted) await this.#transport.close();
    this.#transportStarted = false;
    this.#ticket = undefined;
    this.#sessions.clear();
    if (enabled) await this.#connect();
    else this.#status = "disabled";
    return this.status();
  }

  createPairing(): Promise<RemotePairingDto> {
    const state = this.#requireState();
    if (!state.enabled || this.#ticket === undefined) throw new Error("remote_access_disabled");
    const pairingId = `pair_${randomUUID()}`;
    const deviceId = `device_${randomUUID()}`;
    const secret = createRemoteSecret();
    const expiresAt = new Date(this.#clock.now().getTime() + REMOTE_PAIRING_TTL_MS).toISOString();
    const qrUrl = new URL("joi://pair");
    qrUrl.search = new URLSearchParams({
      device: deviceId,
      host: state.hostId,
      pairing: pairingId,
      secret,
      ticket: Buffer.from(JSON.stringify(this.#ticket), "utf8").toString("base64url"),
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

  async #connect(): Promise<void> {
    if (this.#stopped || this.#transportStarted) return;
    const generation = this.#transportGeneration;
    const state = this.#requireState();
    if (!state.enabled || state.relayUrl === "") return;
    this.#status = "connecting";
    try {
      if (!this.#vault.isAvailable()) throw new Error("remote_credential_encryption_unavailable");
      let nodeSecret: string;
      if (state.encryptedNodeSecret === undefined) {
        nodeSecret = randomBytes(32).toString("base64");
        this.#state = { ...state, encryptedNodeSecret: await this.#vault.encrypt(nodeSecret) };
        await this.#store.save(this.#state);
      } else {
        nodeSecret = await this.#vault.decrypt(state.encryptedNodeSecret);
      }
      const relayAuthentication = state.encryptedRelayAuthentication === undefined
        ? undefined
        : await this.#vault.decrypt(state.encryptedRelayAuthentication);
      if (generation !== this.#transportGeneration) return;
      this.#ticket = await this.#transport.start({
        nodeSecret,
        ...(relayAuthentication === undefined ? {} : { relayAuthentication }),
        relayUrl: state.relayUrl,
      });
      this.#transportStarted = true;
      this.#status = "connected";
    } catch {
      this.#transportStarted = false;
      this.#ticket = undefined;
      this.#status = "error";
      this.#scheduleReconnect();
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#state?.enabled !== true || this.#reconnectTimer !== undefined) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, 2_000);
    this.#reconnectTimer.unref();
  }

  async #handleTransportEvent(event: RemotePeerTransportEvent): Promise<void> {
    if (event.type === "error") {
      this.#status = "error";
      this.#sessions.clear();
      await this.#transport.close();
      this.#transportStarted = false;
      this.#ticket = undefined;
      this.#scheduleReconnect();
      return;
    }
    if (event.type === "peerOpen") {
      this.#sessions.set(event.connectionId, {
        connectionId: event.connectionId,
        inbound: new RemoteReplayGuard(),
        outboundSequence: 0,
      });
      return;
    }
    if (event.type === "peerClose") {
      this.#sessions.delete(event.connectionId);
      return;
    }
    const session = this.#sessions.get(event.connectionId);
    if (session === undefined) return;
    if (session.key === undefined) await this.#handleHandshake(session, event.frame);
    else await this.#handleEncryptedCommand(session, event.frame);
  }

  async #handleHandshake(session: PeerSession, value: unknown): Promise<void> {
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
        name: value.deviceName.trim() || "Android 设备",
      };
      this.#state = { ...state, devices: [...state.devices.filter((item) => item.deviceId !== device.deviceId), device] };
      await this.#store.save(this.#state);
      this.#pairing = undefined;
    } else {
      await this.#touchDevice(value.deviceId);
    }
    this.#send(session.connectionId, {
      hostNonce,
      kind: "handshake.ready",
      proof: remoteReadyProof(secret, context, hostNonce),
      version: REMOTE_PROTOCOL_VERSION,
    });
  }

  async #handleEncryptedCommand(session: PeerSession, value: unknown): Promise<void> {
    if (!isEncryptedFrame(value) || session.key === undefined) { this.#reject(session.connectionId); return; }
    try {
      session.inbound.accept(value.seq);
      const command = decryptRemotePayload(session.key, value, session.connectionId);
      if (!isRemoteCommand(command)) { this.#reject(session.connectionId); return; }
      const response = await this.#commands.handle(command);
      session.outboundSequence += 1;
      this.#send(
        session.connectionId,
        encryptRemotePayload(session.key, session.outboundSequence, response, session.connectionId),
      );
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

  #send(connectionId: string, frame: unknown): void {
    void this.#transport.send(connectionId, frame).catch(() => this.#reject(connectionId));
  }

  #reject(connectionId: string): void {
    this.#sessions.delete(connectionId);
    void this.#transport.disconnect(connectionId).catch(() => undefined);
  }
}
