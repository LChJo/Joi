/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */

import { describe, expect, it, vi } from "vitest";

import type {
  RemoteAccessStoredState,
  RemoteAccessStore,
  RemotePeerTransport,
  RemotePeerTransportEvent,
} from "../../src/main/application/ports/remote-access.js";
import type { CredentialVault } from "../../src/main/application/ports/a2a-ports.js";
import { RemoteAccessHost } from "../../src/main/infrastructure/remote/remote-access-host.js";
import {
  decryptRemotePayload,
  deriveRemoteSessionKey,
  encryptRemotePayload,
  remoteHandshakeProof,
} from "../../src/main/infrastructure/remote/remote-frame-crypto.js";
import type { RemoteEncryptedFrame, RemoteHandshakeReady } from "../../src/shared/remote.js";

class MemoryRemoteStore implements RemoteAccessStore {
  state: RemoteAccessStoredState | null = null;
  async load() { return this.state; }
  async save(state: RemoteAccessStoredState) { this.state = structuredClone(state); }
}

class FakePeerTransport implements RemotePeerTransport {
  readonly sent: { connectionId: string; frame: unknown }[] = [];
  listener: ((event: RemotePeerTransportEvent) => void) | undefined;
  starts: unknown[] = [];

  close() { return Promise.resolve(); }
  async disconnect(connectionId: string) { this.listener?.({ connectionId, type: "peerClose" }); }
  emit(event: RemotePeerTransportEvent) { this.listener?.(event); }
  async send(connectionId: string, frame: unknown) { this.sent.push({ connectionId, frame }); }
  async start(input: { nodeSecret: string; relayAuthentication?: string; relayUrl: string }) {
    this.starts.push(input);
    return {
      directAddresses: ["192.0.2.10:49152"],
      endpointId: "ep_native_1",
      relayUrls: [`${input.relayUrl}/`],
      version: 1 as const,
    };
  }
  subscribe(listener: (event: RemotePeerTransportEvent) => void) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
}

const vault: CredentialVault = {
  decrypt: (ciphertext) => Promise.resolve(Buffer.from(ciphertext).toString("utf8")),
  encrypt: (plaintext) => Promise.resolve(Buffer.from(plaintext, "utf8")),
  isAvailable: () => true,
};

function pairingFields(value: string): Record<string, string> {
  const url = new URL(value);
  return Object.fromEntries(url.searchParams);
}

describe("native RemoteAccessHost", () => {
  it("keeps bounded safe evidence of incoming peers and rejected handshakes", async () => {
    const transport = new FakePeerTransport();
    const emit = vi.fn();
    const host = new RemoteAccessHost({ clock: { now: () => new Date("2026-09-08T00:00:00Z") },
      commands: { handle: vi.fn() }, store: new MemoryRemoteStore(), transport, vault, diagnostics: { emit } });
    await host.start();
    await host.update({ enabled: true });
    transport.emit({ type: "peerOpen", connectionId: "private-peer" });
    transport.emit({ type: "peerFrame", connectionId: "private-peer", frame: { secret: "never-log-this" } });
    await vi.waitFor(async () => {
      const status = await host.status();
      expect(status).toHaveProperty("diagnostics");
      expect(JSON.stringify(status.diagnostics)).toContain("handshakeInvalid");
    });
    const diagnostics = (await host.status()).diagnostics;
    expect(JSON.stringify(diagnostics)).toContain("peerOpened");
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-peer|never-log-this|secret/u);
    expect(emit).toHaveBeenCalledWith("joi.remote.connection", expect.objectContaining({ code: "handshakeInvalid" }));
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(/private-peer|never-log-this|secret/u);
    for (let i = 0; i < 70; i++) transport.emit({ type: "diagnostic", code: "quicAccepted" });
    transport.emit({ type: "diagnostic", code: "secret=private-diagnostic" });
    await vi.waitFor(async () => expect((await host.status()).diagnostics).toHaveLength(50));
    expect(JSON.stringify((await host.status()).diagnostics)).not.toContain("private-diagnostic");
    await host.close();
  });
  it("uses the Joi-owned relay by default while keeping the relay editable", async () => {
    const store = new MemoryRemoteStore();
    const host = new RemoteAccessHost({
      clock: { now: () => new Date("2026-08-27T00:00:00.000Z") },
      commands: { handle: vi.fn() },
      store,
      transport: new FakePeerTransport(),
      vault,
    });

    await host.start();

    await expect(host.status()).resolves.toEqual(expect.objectContaining({
      enabled: false,
      relayUrl: "https://remote.joilab.top",
    }));
    expect(store.state).toEqual(expect.objectContaining({ version: 3 }));
    await host.close();
  });

  it("publishes an iroh ticket and keeps independent encrypted sessions for multiple devices", async () => {
    const transport = new FakePeerTransport();
    const store = new MemoryRemoteStore();
    const handle = vi.fn().mockImplementation((command: { requestId: string }) => Promise.resolve({
      kind: "response",
      requestId: command.requestId,
      result: { goals: [], thinking: [], unassignedActions: [] },
    }));
    const host = new RemoteAccessHost({
      clock: { now: () => new Date("2026-08-27T00:00:00.000Z") },
      commands: { handle },
      store,
      transport,
      vault,
    });
    await host.start();
    await host.update({ enabled: true, relayUrl: "https://cudex.joilab.top" });
    expect((await host.status()).status).toBe("connected");

    for (const [connectionId, deviceName] of [["connection-a", "手机 A"], ["connection-b", "手机 B"]] as const) {
      const pairing = await host.createPairing();
      const fields = pairingFields(pairing.qrUrl);
      expect(pairing.qrUrl).toMatch(/^joi:\/\/pair\?/u);
      expect(JSON.parse(Buffer.from(fields.ticket!, "base64url").toString("utf8"))).toEqual(expect.objectContaining({
        endpointId: "ep_native_1",
      }));
      transport.emit({ connectionId, type: "peerOpen" });
      const clientNonce = Buffer.alloc(24, connectionId === "connection-a" ? 3 : 4).toString("base64url");
      const context = {
        clientNonce,
        deviceId: fields.device!,
        hostId: fields.host!,
        mode: "pair" as const,
        pairingId: fields.pairing!,
      };
      transport.emit({
        connectionId,
        frame: {
          ...context,
          deviceName,
          kind: "handshake.hello",
          proof: remoteHandshakeProof(fields.secret!, context),
          version: 1,
        },
        type: "peerFrame",
      });
      await vi.waitFor(() => expect(transport.sent.some((item) => item.connectionId === connectionId)).toBe(true));
      const ready = transport.sent.findLast((item) => item.connectionId === connectionId)!.frame as RemoteHandshakeReady;
      const key = deriveRemoteSessionKey(fields.secret!, clientNonce, ready.hostNonce);
      transport.emit({
        connectionId,
        frame: encryptRemotePayload(key, 1, { kind: "feed.get", requestId: `feed-${connectionId}` }, connectionId),
        type: "peerFrame",
      });
      await vi.waitFor(() => expect(transport.sent.filter((item) => item.connectionId === connectionId).length).toBe(2));
      const encrypted = transport.sent.findLast((item) => item.connectionId === connectionId)!.frame as RemoteEncryptedFrame;
      expect(decryptRemotePayload(key, encrypted, connectionId)).toEqual(expect.objectContaining({ requestId: `feed-${connectionId}` }));
    }

    expect((await host.status()).devices.map((device) => device.name)).toEqual(["手机 A", "手机 B"]);
    expect(JSON.stringify(store.state)).not.toContain("secret");
    expect(transport.starts).toEqual([expect.objectContaining({ relayUrl: "https://cudex.joilab.top" })]);
    await host.close();
  });
});
