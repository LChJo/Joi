import { randomBytes, randomUUID } from "node:crypto";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";

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
  REMOTE_DIAGNOSTIC_CODES,
  type RemoteDiagnosticCode,
  type RemoteDiagnosticDto,
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
  commandSeen?: boolean;
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

export function isRemoteCommand(value: unknown): value is RemoteCommand {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const string = (key: string, max = 160, optional = false) => item[key] === undefined ? optional
    : typeof item[key] === "string" && item[key].length > 0 && item[key].length <= max;
  if (!string("requestId")) return false;
  if (item.kind === "feed.get") return item.paged === undefined || typeof item.paged === "boolean";
  if (item.kind === "catalog.get") return true;
  if (item.kind === "workbench.create") return string("inputId") && string("name", 80) && string("personaSummary", 4_000)
    && string("projectLabel", 160) && string("scopeSummary", 1_000) && string("bindInputId", 160, true)
    && string("questionId", 240, true) && string("idempotencyKey", 240, true)
    && (item.bindInputId === undefined || item.bindInputId === item.inputId)
    && (item.questionVersion === undefined || typeof item.questionVersion === "number" && Number.isInteger(item.questionVersion) && item.questionVersion >= 1);
  if (item.kind === "read.next") return string("cursor", 240);
  if (item.kind === "goal.get" || item.kind === "goal.agents" || item.kind === "agent.conversation") {
    return string("goalId") && string("cursor", 240, true) && (item.kind !== "agent.conversation" || string("agentId"));
  }
  if (item.kind === "message.send") return string("idempotencyKey", 240) && string("text", 32_000) && string("workbenchId", 160, true);
  if (!string("inputId")) return false;
  if (["message.cancel", "message.dismiss", "message.closeHistoricalReview"].includes(String(item.kind))) return true;
  if (item.kind === "message.retry") return item.text === undefined || typeof item.text === "string" && item.text.length <= 8_000;
  if (item.kind === "message.clarify") return string("text", 8_000, true) && string("workbenchId", 160, true)
    && string("partnerId", 160, true) && string("questionId", 160, true)
    // The pair is what lets a gate-backed card be answered at all: the repository refuses a
    // resolution whose question does not match the one the gate is waiting on, so a clarification
    // that travels without them can only come back unavailable. Whether they arrive together is
    // the service's rule to state, and it states it with its own error code.
    && (item.questionVersion === undefined || typeof item.questionVersion === "number" && Number.isInteger(item.questionVersion) && item.questionVersion >= 1)
    && (item.actionChoice === undefined || typeof item.actionChoice === "string" && ["RESUME", "CONTINUE", "ACCEPT_CURRENT"].includes(item.actionChoice));
  return false;
}

export class RemoteAccessHost implements RemoteAccessControl {
  readonly #clock: Clock;
  readonly #commands: RemoteCommandHandler;
  readonly #sessions = new Map<string, PeerSession>();
  readonly #peerQueues = new Map<string, Promise<void>>();
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
  readonly #diagnostics: RuntimeDiagnostics | undefined;
  readonly #recentDiagnostics: RemoteDiagnosticDto[] = [];
  #diagnosticSequence = 0;

  constructor(input: { clock: Clock; commands: RemoteCommandHandler; store: RemoteAccessStore; transport: RemotePeerTransport; vault: CredentialVault; diagnostics?: RuntimeDiagnostics }) {
    this.#diagnostics = input.diagnostics;
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
      const key = "connectionId" in event ? event.connectionId : "transport";
      const queued = (this.#peerQueues.get(key) ?? Promise.resolve()).then(() => this.#handleTransportEvent(event)).catch(() => { this.#record("handlerFailed"); });
      this.#peerQueues.set(key, queued);
      void queued.finally(() => { if (this.#peerQueues.get(key) === queued) this.#peerQueues.delete(key); });
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
    for (const connectionId of this.#sessions.keys()) this.#commands.release?.(connectionId);
    this.#sessions.clear();
    this.#status = this.#state?.enabled === true ? "error" : "disabled";
  }

  status(): Promise<RemoteAccessStatusDto> {
    const state = this.#requireState();
    if (this.#pairing !== undefined && Date.parse(this.#pairing.expiresAt) <= this.#clock.now().getTime()) this.#pairing = undefined;
    return Promise.resolve({
      diagnostics: this.#recentDiagnostics.map((entry) => ({ ...entry })),
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
    for (const connectionId of this.#sessions.keys()) this.#commands.release?.(connectionId);
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
    this.#record("transportStarting");
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
      this.#record("transportReady");
    } catch {
      this.#transportStarted = false;
      this.#ticket = undefined;
      this.#status = "error";
      this.#record("transportFailed");
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
    if (this.#stopped || this.#state?.enabled !== true) return;
    if (event.type === "diagnostic") {
      if (REMOTE_DIAGNOSTIC_CODES.some((code) => code === event.code)) this.#record(event.code as RemoteDiagnosticCode);
      return;
    }
    if (event.type === "error") {
      this.#record("transportFailed");
      this.#status = "error";
      for (const connectionId of this.#sessions.keys()) this.#commands.release?.(connectionId);
      this.#sessions.clear();
      await this.#transport.close();
      this.#transportStarted = false;
      this.#ticket = undefined;
      this.#scheduleReconnect();
      return;
    }
    if (event.type === "peerOpen") {
      this.#record("peerOpened");
      this.#commands.release?.(event.connectionId);
      this.#sessions.set(event.connectionId, {
        connectionId: event.connectionId,
        inbound: new RemoteReplayGuard(),
        outboundSequence: 0,
      });
      return;
    }
    if (event.type === "peerClose") {
      this.#record("peerClosed");
      this.#commands.release?.(event.connectionId);
      this.#sessions.delete(event.connectionId);
      return;
    }
    const session = this.#sessions.get(event.connectionId);
    if (session === undefined) return;
    if (session.key === undefined) await this.#handleHandshake(session, event.frame);
    else await this.#handleEncryptedCommand(session, event.frame);
  }

  async #handleHandshake(session: PeerSession, value: unknown): Promise<void> {
    this.#record("handshakeReceived");
    if (!isHandshake(value)) { this.#reject(session.connectionId, "handshakeInvalid"); return; }
    const state = this.#requireState();
    if (value.hostId !== state.hostId || value.deviceId.length > 160 || value.deviceName.length > 80) {
      this.#reject(session.connectionId, "hostMismatch"); return;
    }
    let secret: string;
    let pairing: ActivePairing | undefined;
    if (value.mode === "pair") {
      pairing = this.#pairing;
      if (pairing === undefined || value.pairingId !== pairing.pairingId || value.deviceId !== pairing.deviceId
        || Date.parse(pairing.expiresAt) <= this.#clock.now().getTime()) { this.#reject(session.connectionId, "pairingUnavailable"); return; }
      secret = pairing.secret;
    } else {
      const device = state.devices.find((item) => item.deviceId === value.deviceId);
      if (device === undefined || !this.#vault.isAvailable()) { this.#reject(session.connectionId, "deviceUnavailable"); return; }
      secret = await this.#vault.decrypt(device.encryptedSecret);
    }
    const context = {
      clientNonce: value.clientNonce,
      deviceId: value.deviceId,
      hostId: value.hostId,
      mode: value.mode,
      pairingId: value.pairingId ?? "",
    };
    if (!verifyRemoteHandshakeProof(secret, context, value.proof)) { this.#reject(session.connectionId, "proofInvalid"); return; }
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
    await this.#send(session.connectionId, {
      capabilities: ["home.v2", "workbench.create", "workbench.choice.v1"],
      hostNonce,
      kind: "handshake.ready",
      proof: remoteReadyProof(secret, context, hostNonce),
      version: REMOTE_PROTOCOL_VERSION,
    });
    if (this.#sessions.get(session.connectionId) === session) this.#record("handshakeReady");
  }

  async #handleEncryptedCommand(session: PeerSession, value: unknown): Promise<void> {
    if (!isEncryptedFrame(value) || session.key === undefined) { this.#reject(session.connectionId); return; }
    try {
      session.inbound.accept(value.seq);
      const command = decryptRemotePayload(session.key, value, session.connectionId);
      if (!isRemoteCommand(command)) { this.#reject(session.connectionId); return; }
      if (!session.commandSeen) {
        session.commandSeen = true;
        this.#record("firstCommandReceived");
      }
      const response = await this.#commands.handle(command, session.connectionId);
      if (this.#sessions.get(session.connectionId) !== session) {
        this.#commands.release?.(session.connectionId);
        return;
      }
      session.outboundSequence += 1;
      await this.#send(
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

  async #send(connectionId: string, frame: unknown): Promise<void> {
    await this.#transport.send(connectionId, frame).catch(() => this.#reject(connectionId, "hostSendFailed"));
  }

  #reject(connectionId: string, code: RemoteDiagnosticCode = "sessionRejected"): void {
    this.#record(code);
    this.#commands.release?.(connectionId);
    this.#sessions.delete(connectionId);
    void this.#transport.disconnect(connectionId).catch(() => undefined);
  }

  #record(code: RemoteDiagnosticCode): void {
    const entry = { at: this.#clock.now().toISOString(), code, sequence: ++this.#diagnosticSequence };
    this.#recentDiagnostics.push(entry);
    if (this.#recentDiagnostics.length > 50) this.#recentDiagnostics.shift();
    emitRuntimeDiagnostic(this.#diagnostics, "joi.remote.connection", { code, sequence: entry.sequence });
  }
}
