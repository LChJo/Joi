import { t } from "./i18n";
import type { JoiAcceptedMessageDto, JoiHomeFeedDto } from "../shared/joi.js";
import { REMOTE_PROTOCOL_VERSION, type RemoteCommand, type RemoteCommandResponse, type RemoteEncryptedFrame, type RemoteHandshakeReady } from "../shared/remote.js";
import { ApiError } from "./api";
import { randomUuid } from "./random-uuid.js";
import type { RemoteJoiConnection } from "./RemoteJoiApp.js";

interface RemoteBrowserCredential { deviceId: string; hostId: string; secret: string }
interface PairingTicket extends RemoteBrowserCredential { pairingId: string }
interface PendingRequest { reject(error: Error): void; resolve(response: RemoteCommandResponse): void }
interface HandshakeContext { clientNonce: string; deviceId: string; hostId: string; mode: "pair" | "resume"; pairingId: string }

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(`${normalized}${"=".repeat((4 - normalized.length % 4) % 4)}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function utf8(value: string): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(value); }

function concatenate(...values: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}

function proofBody(input: HandshakeContext): string {
  return ["joi-remote-v1", input.mode, input.hostId, input.deviceId, input.pairingId, input.clientNonce].join("\n");
}

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(body))));
}

export function browserRemoteHandshakeProof(secret: string, input: HandshakeContext): Promise<string> {
  return hmac(secret, proofBody(input));
}

async function verifyReadyProof(secret: string, input: HandshakeContext, ready: RemoteHandshakeReady): Promise<boolean> {
  return (await hmac(secret, `${proofBody(input)}\n${ready.hostNonce}\nready`)) === ready.proof;
}

export async function deriveBrowserRemoteSessionKey(secret: string, clientNonce: string, hostNonce: string): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey("raw", decodeBase64Url(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({
    hash: "SHA-256", info: utf8("joi-browser-remote-session-v1"), name: "HKDF",
    salt: concatenate(decodeBase64Url(clientNonce), decodeBase64Url(hostNonce)),
  }, key, { length: 256, name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
}

function frameAad(connectionId: string, sequence: number): Uint8Array<ArrayBuffer> {
  return utf8(`joi-remote-v1\n${connectionId}\n${String(sequence)}`);
}

export async function encryptBrowserRemotePayload(key: CryptoKey, sequence: number, payload: unknown, connectionId: string): Promise<RemoteEncryptedFrame> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ additionalData: frameAad(connectionId, sequence), iv, name: "AES-GCM", tagLength: 128 }, key, utf8(JSON.stringify(payload))));
  const tagOffset = encrypted.length - 16;
  return { ciphertext: encodeBase64Url(encrypted.slice(0, tagOffset)), iv: encodeBase64Url(iv), kind: "encrypted", seq: sequence, tag: encodeBase64Url(encrypted.slice(tagOffset)) };
}

export async function decryptBrowserRemotePayload<T>(key: CryptoKey, frame: RemoteEncryptedFrame, connectionId: string): Promise<T> {
  const plaintext = await crypto.subtle.decrypt({
    additionalData: frameAad(connectionId, frame.seq), iv: decodeBase64Url(frame.iv), name: "AES-GCM", tagLength: 128,
  }, key, concatenate(decodeBase64Url(frame.ciphertext), decodeBase64Url(frame.tag)));
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

function ticketFromLocation(location: Location): PairingTicket | null {
  const params = new URLSearchParams(location.hash.replace(/^#/u, ""));
  if (params.get("v") !== String(REMOTE_PROTOCOL_VERSION)) return null;
  const deviceId = params.get("device"); const hostId = params.get("host");
  const pairingId = params.get("pairing"); const secret = params.get("secret");
  return deviceId === null || hostId === null || pairingId === null || secret === null ? null : { deviceId, hostId, pairingId, secret };
}

function storageKey(hostId: string): string { return `joi.remote.device.${hostId}`; }

function storedCredential(storage: Storage): RemoteBrowserCredential | null {
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith("joi.remote.device.") !== true) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as Partial<RemoteBrowserCredential> | null;
      if (value !== null && typeof value.deviceId === "string" && typeof value.hostId === "string" && typeof value.secret === "string") return value as RemoteBrowserCredential;
    } catch { /* Ignore damaged local browser state. */ }
  }
  return null;
}

function isEncryptedFrame(value: unknown): value is RemoteEncryptedFrame {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Partial<RemoteEncryptedFrame>;
  return item.kind === "encrypted" && typeof item.seq === "number" && typeof item.iv === "string" && typeof item.ciphertext === "string" && typeof item.tag === "string";
}

export class BrowserRemoteJoiConnection implements RemoteJoiConnection {
  readonly #location: Location;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #storage: Storage;
  #connectionId: string | undefined;
  #credential: RemoteBrowserCredential | undefined;
  #inboundSequence = 0;
  #key: CryptoKey | undefined;
  #lastHello: HandshakeContext | undefined;
  #outboundSequence = 0;
  #sendQueue: Promise<void> = Promise.resolve();
  #ready: Promise<void> | undefined;
  #readyReject: ((error: Error) => void) | undefined;
  #readyResolve: (() => void) | undefined;
  #reconnectTimer: number | undefined;
  #socket: WebSocket | undefined;
  #status: ReturnType<RemoteJoiConnection["status"]> = "disconnected";
  #ticket: PairingTicket | undefined;

  constructor(input: { location?: Location; storage?: Storage } = {}) {
    this.#location = input.location ?? window.location;
    this.#storage = input.storage ?? window.localStorage;
    this.#ticket = ticketFromLocation(this.#location) ?? undefined;
    this.#credential = this.#ticket ?? storedCredential(this.#storage) ?? undefined;
    if (this.#credential !== undefined) this.#connect();
  }

  status() { return this.#status; }
  dispose(): void {
    this.#credential = undefined;
    window.clearTimeout(this.#reconnectTimer);this.#reconnectTimer = undefined;
    this.#disconnect();
  }
  async command<T>(command: RemoteCommand,signal?: AbortSignal): Promise<T> {
    let response = await this.#request(command,signal),body = "";
    for (let pages = 0;pages < 2048;pages += 1) {
      if (response.error !== undefined) throw new ApiError(response.error.code,"Remote operation failed.",response.error.code === "remote_operation_forbidden" ? 403 : 409);
      const result = response.result;
      if (result === undefined) throw new ApiError("remote_response_invalid","Remote response is invalid.",502);
      const page = result as { encoding?: unknown;chunk?: unknown;nextCursor?: unknown };
      if (page.encoding !== "json") return result as T;
      if (typeof page.chunk !== "string" || (page.nextCursor !== undefined && typeof page.nextCursor !== "string")) throw new ApiError("remote_response_invalid","Remote response is invalid.",502);
      body += page.chunk;
      if (body.length > 16 * 1024 * 1024) throw new ApiError("remote_read_too_large","Remote response is too large.",502);
      if (page.nextCursor === undefined) return JSON.parse(body) as T;
      response = await this.#request({ kind: "read.next",requestId: randomUuid(),cursor: page.nextCursor },signal);
    }
    throw new ApiError("remote_read_too_large","Remote response has too many pages.",502);
  }
  async feed(): Promise<JoiHomeFeedDto> {
    const response = await this.#request({ kind: "feed.get", requestId: randomUuid() });
    if (response.error !== undefined || response.result === undefined) throw new Error(response.error?.code ?? "remote_response_invalid");
    return response.result as JoiHomeFeedDto;
  }
  async sendMessage(text: string, idempotencyKey: string): Promise<JoiAcceptedMessageDto> {
    const response = await this.#request({ idempotencyKey, kind: "message.send", requestId: randomUuid(), text });
    if (response.error !== undefined || response.result === undefined) throw new Error(response.error?.code ?? "remote_response_invalid");
    return response.result as JoiAcceptedMessageDto;
  }

  #connect(): void {
    const credential = this.#credential;
    if (credential === undefined) return;
    if (this.#reconnectTimer !== undefined) window.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#status = "connecting";
    this.#ready = new Promise((resolve, reject) => { this.#readyResolve = resolve; this.#readyReject = reject; });
    void this.#ready.catch(() => undefined);
    const relay = new URL(this.#location.origin);
    relay.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
    relay.pathname = "/connect"; relay.search = new URLSearchParams({ host: credential.hostId }).toString(); relay.hash = "";
    const socket = new WebSocket(relay);
    this.#socket = socket;
    socket.addEventListener("message", (event) => { void this.#handleMessage(String(event.data)).catch(() => this.#disconnect()); });
    socket.addEventListener("close", () => this.#disconnect());
    socket.addEventListener("error", () => this.#disconnect());
  }

  #disconnect(): void {
    this.#status = "disconnected"; this.#key = undefined; this.#connectionId = undefined;
    this.#readyReject?.(new Error("remote_disconnected"));
    for (const pending of this.#pending.values()) pending.reject(new Error("remote_disconnected"));
    this.#pending.clear();
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.close();
    this.#socket = undefined;
    if (this.#credential !== undefined && this.#reconnectTimer === undefined) {
      this.#reconnectTimer = window.setTimeout(() => this.#connect(), 2_000);
    }
  }

  async #handleMessage(serialized: string): Promise<void> {
    const message = JSON.parse(serialized) as unknown;
    if (message !== null && typeof message === "object" && (message as { kind?: unknown }).kind === "relay.connected") {
      const connectionId = (message as { connectionId?: unknown }).connectionId;
      if (typeof connectionId !== "string") throw new Error("remote_connection_invalid");
      this.#connectionId = connectionId; await this.#sendHandshake(); return;
    }
    if (message !== null && typeof message === "object" && (message as { kind?: unknown }).kind === "handshake.ready") {
      await this.#finishHandshake(message as RemoteHandshakeReady); return;
    }
    if (!isEncryptedFrame(message) || this.#key === undefined || this.#connectionId === undefined || message.seq <= this.#inboundSequence) throw new Error("remote_frame_invalid");
    this.#inboundSequence = message.seq;
    const response = await decryptBrowserRemotePayload<RemoteCommandResponse>(this.#key, message, this.#connectionId);
    const pending = this.#pending.get(response.requestId);
    if (pending !== undefined) { this.#pending.delete(response.requestId); pending.resolve(response); }
  }

  async #sendHandshake(): Promise<void> {
    const credential = this.#credential;
    if (credential === undefined || this.#connectionId === undefined || this.#socket?.readyState !== WebSocket.OPEN) throw new Error("remote_not_connected");
    const mode = this.#ticket === undefined ? "resume" : "pair";
    const context: HandshakeContext = {
      clientNonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(24))), deviceId: credential.deviceId,
      hostId: credential.hostId, mode, pairingId: this.#ticket?.pairingId ?? "",
    };
    this.#lastHello = context;
    this.#socket.send(JSON.stringify({ ...context, deviceName: navigator.userAgent.includes("Mobile") ? t("common.mobileBrowser") : t("common.browser"), kind: "handshake.hello", proof: await browserRemoteHandshakeProof(credential.secret, context), version: REMOTE_PROTOCOL_VERSION }));
  }

  async #finishHandshake(ready: RemoteHandshakeReady): Promise<void> {
    const credential = this.#credential; const hello = this.#lastHello;
    if (credential === undefined || hello === undefined || !await verifyReadyProof(credential.secret, hello, ready)) throw new Error("remote_host_proof_invalid");
    this.#key = await deriveBrowserRemoteSessionKey(credential.secret, hello.clientNonce, ready.hostNonce);
    this.#status = "connected";
    if (this.#ticket !== undefined) {
      this.#storage.setItem(storageKey(credential.hostId), JSON.stringify(credential));
      history.replaceState(null, "", `${this.#location.pathname}${this.#location.search}`);
      this.#ticket = undefined;
    }
    this.#readyResolve?.();
  }

  async #request(command: RemoteCommand,signal?: AbortSignal): Promise<RemoteCommandResponse> {
    if (this.#ready === undefined) throw new Error("remote_not_paired");
    const ready = this.#ready;
    return new Promise((resolve,reject) => {
      let settled = false;
      const cleanup = () => { settled = true;window.clearTimeout(timer);signal?.removeEventListener("abort",abort);this.#pending.delete(command.requestId); };
      const fail = (error: Error) => { if (settled) return;cleanup();reject(error); };
      const abort = () => fail(new DOMException("Request aborted.","AbortError"));
      const timer = window.setTimeout(() => fail(new ApiError("request_timeout","Remote request timed out.",504)),15_000);
      this.#pending.set(command.requestId,{ reject: fail,resolve: value => { if (settled) return;cleanup();resolve(value); } });
      signal?.addEventListener("abort",abort,{ once: true });
      if (signal?.aborted === true) { abort();return; }
      void ready.then(() => {
        this.#sendQueue = this.#sendQueue.catch(() => undefined).then(async () => {
          if (settled) return;
          if (this.#key === undefined || this.#connectionId === undefined || this.#socket?.readyState !== WebSocket.OPEN) throw new Error("remote_not_connected");
          const socket = this.#socket,active = () => !settled;
          this.#outboundSequence += 1;
          const frame = await encryptBrowserRemotePayload(this.#key,this.#outboundSequence,command,this.#connectionId);
          if (active()) socket.send(JSON.stringify(frame));
        });
        return this.#sendQueue;
      }).catch((error: unknown) => fail(error instanceof Error ? error : new Error("remote_request_failed")));
    });
  }
}
