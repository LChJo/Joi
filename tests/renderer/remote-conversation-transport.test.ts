// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { BrowserRemoteJoiConnection } from "../../src/renderer/remote-connection";
import { decryptRemotePayload,deriveRemoteSessionKey,encryptRemotePayload,remoteReadyProof } from "../../src/main/infrastructure/remote/remote-frame-crypto";
import type { RemoteCommand,RemoteCommandResponse,RemoteEncryptedFrame,RemoteHandshakeHello } from "../../src/shared/remote";

const secret = Buffer.alloc(32,7).toString("base64url");
const hostNonce = Buffer.alloc(24,9).toString("base64url");
class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  static respond: (command: RemoteCommand) => unknown = () => ({ items: [] });
  readyState = 1;
  key: Uint8Array = new Uint8Array();
  sequence = 0;
  requests: RemoteCommand[] = [];
  constructor() {
    super();Socket.instances.push(this);
    queueMicrotask(() => this.frame({ kind: "relay.connected",connectionId: "connection" }));
  }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent("message",{ data: JSON.stringify(value) })); }
  send(serialized: string) {
    const value = JSON.parse(serialized) as RemoteHandshakeHello | RemoteEncryptedFrame;
    if (value.kind === "handshake.hello") {
      this.key = deriveRemoteSessionKey(secret,value.clientNonce,hostNonce);
      this.frame({ kind: "handshake.ready",version: 1,hostNonce,proof: remoteReadyProof(secret,{ ...value,pairingId: value.pairingId ?? "" },hostNonce) });
      return;
    }
    expect(value.seq).toBeGreaterThan(this.sequence);
    this.sequence = value.seq;
    const command = decryptRemotePayload(this.key,value,"connection") as RemoteCommand;
    this.requests.push(command);
    const result = Socket.respond(command);
    if (result === undefined) return;
    const response: RemoteCommandResponse = { kind: "response",requestId: command.requestId,...result as object };
    this.frame(encryptRemotePayload(this.key,this.sequence,response,"connection"));
  }
  close() { this.readyState = 3;this.dispatchEvent(new Event("close")); }
}
let connection: BrowserRemoteJoiConnection;
beforeEach(() => {
  vi.stubGlobal("crypto",webcrypto);vi.stubGlobal("WebSocket",Socket);
  Socket.instances = [];Socket.respond = () => ({ result: { items: [] } });
  localStorage.clear();localStorage.setItem("joi.remote.device.host",JSON.stringify({ hostId: "host",deviceId: "device",secret }));
  connection = new BrowserRemoteJoiConnection({ location: { origin: "https://relay.invalid",hash: "" } as Location });
});
afterEach(() => { connection.dispose();vi.useRealTimers();vi.unstubAllGlobals();localStorage.clear(); });

it("reassembles encrypted conversation history and serializes concurrent request frames", async () => {
  const body = JSON.stringify({ conversationId: "chat",text: "中文😀".repeat(10_000) });
  Socket.respond = command => ({ result: command.kind === "read.next" ? { encoding: "json",chunk: body.slice(12_000) } : { encoding: "json",chunk: body.slice(0,12_000),nextCursor: "next" } });
  await expect(connection.command({ kind: "conversation.get",requestId: "get",conversationId: "chat" })).resolves.toEqual(JSON.parse(body));
  Socket.respond = () => ({ result: { items: [] } });
  await Promise.all(["one","two","three"].map(requestId => connection.command({ kind: "conversation.catalog",requestId })));
  expect(Socket.instances[0]?.requests.map(command => command.kind)).toEqual(["conversation.get","read.next","conversation.catalog","conversation.catalog","conversation.catalog"]);
});

it("retains host refusal codes and rejects malformed or absent result pages", async () => {
  await connection.command({ kind: "conversation.catalog",requestId: "ready" });
  Socket.respond = () => ({ error: { code: "conversation_busy",message: "Unavailable" } });
  await expect(connection.command({ kind: "conversation.archive",requestId: "archive",conversationId: "chat" })).rejects.toMatchObject({ code: "conversation_busy" });
  Socket.respond = () => ({ error: { code: "remote_operation_forbidden",message: "Unavailable" } });
  await expect(connection.command({ kind: "conversation.catalog",requestId: "old-host" })).rejects.toMatchObject({ status: 403 });
  Socket.respond = () => ({});
  await expect(connection.command({ kind: "conversation.catalog",requestId: "absent" })).rejects.toMatchObject({ code: "remote_response_invalid" });
  Socket.respond = () => ({ result: { encoding: "json",chunk: 4 } });
  await expect(connection.command({ kind: "conversation.catalog",requestId: "bad" })).rejects.toMatchObject({ code: "remote_response_invalid" });
});

it("bounds pending commands, honors cancellation and releases them on disconnect", async () => {
  await connection.command({ kind: "conversation.catalog",requestId: "ready" });
  Socket.respond = () => undefined;
  const controller = new AbortController();
  const pending = connection.command({ kind: "conversation.catalog",requestId: "cancel" },controller.signal);
  const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();await canceled;
  vi.useFakeTimers();
  const timeout = expect(connection.command({ kind: "conversation.catalog",requestId: "timeout" })).rejects.toMatchObject({ code: "request_timeout" });
  await vi.advanceTimersByTimeAsync(15_001);await timeout;
  const disconnected = expect(connection.command({ kind: "conversation.catalog",requestId: "disconnect" })).rejects.toThrow("remote_disconnected");
  connection.dispose();await disconnected;
});
