import { once } from "node:events";

/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/require-await */

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteAccessHost } from "../../src/main/infrastructure/remote/remote-access-host.js";
import {
  decryptRemotePayload,
  deriveRemoteSessionKey,
  encryptRemotePayload,
  remoteHandshakeProof,
} from "../../src/main/infrastructure/remote/remote-frame-crypto.js";
import { createRemoteRelayServer, type RunningRemoteRelayServer } from "../../src/relay/remote-relay-server.js";
import type { RemoteAccessStoredState, RemoteAccessStore } from "../../src/main/application/ports/remote-access.js";
import type { CredentialVault } from "../../src/main/application/ports/a2a-ports.js";
import type { RemoteHandshakeReady } from "../../src/shared/remote.js";

class MemoryRemoteStore implements RemoteAccessStore {
  state: RemoteAccessStoredState | null = null;
  async load() { return this.state; }
  async save(state: RemoteAccessStoredState) { this.state = structuredClone(state); }
}

const vault: CredentialVault = {
  decrypt: (ciphertext) => Promise.resolve(Buffer.from(ciphertext).toString("utf8")),
  encrypt: (plaintext) => Promise.resolve(Buffer.from(plaintext, "utf8")),
  isAvailable: () => true,
};

function fragment(url: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(new URL(url).hash.slice(1)));
}

describe("RemoteAccessHost", () => {
  let relay: RunningRemoteRelayServer | undefined;
  let host: RemoteAccessHost | undefined;
  afterEach(async () => {
    await host?.close();
    await relay?.close();
  });

  it("consumes a pairing once, encrypts commands and persists a resumable device", async () => {
    const relayToken = "relay-token-at-least-32-characters";
    relay = await createRemoteRelayServer({ hostToken: relayToken, maxFrameBytes: 256 * 1_024 }).listen(0, "127.0.0.1");
    const store = new MemoryRemoteStore();
    const handle = vi.fn().mockResolvedValue({ kind: "response", requestId: "feed-1", result: { goals: [], thinking: [], unassignedActions: [] } });
    host = new RemoteAccessHost({ clock: { now: () => new Date("2026-08-26T00:00:00.000Z") }, commands: { handle }, store, vault });
    await host.start();
    await host.update({ enabled: true, relayAuthentication: relayToken, relayUrl: relay.httpOrigin });
    await expect.poll(async () => (await host!.status()).status).toBe("connected");

    const pairing = await host!.createPairing();
    const ticket = fragment(pairing.qrUrl);
    expect(new URL(pairing.qrUrl).search).toBe("");
    const browser = new WebSocket(`${relay.webSocketOrigin}/connect?host=${encodeURIComponent(ticket.host ?? "")}`);
    const connectedPromise = once(browser, "message");
    await once(browser, "open");
    const connected = JSON.parse(String((await connectedPromise)[0])) as { connectionId: string };
    const clientNonce = Buffer.alloc(24, 3).toString("base64url");
    const context = {
      clientNonce,
      deviceId: ticket.device ?? "",
      hostId: ticket.host ?? "",
      mode: "pair" as const,
      pairingId: ticket.pairing ?? "",
    };
    const readyPromise = once(browser, "message");
    browser.send(JSON.stringify({
      ...context,
      deviceName: "手机浏览器",
      kind: "handshake.hello",
      proof: remoteHandshakeProof(ticket.secret ?? "", context),
      version: 1,
    }));
    const ready = JSON.parse(String((await readyPromise)[0])) as RemoteHandshakeReady;
    expect(ready.kind).toBe("handshake.ready");
    const key = deriveRemoteSessionKey(ticket.secret ?? "", clientNonce, ready.hostNonce);

    const responsePromise = once(browser, "message");
    browser.send(JSON.stringify(encryptRemotePayload(key, 1, { kind: "feed.get", requestId: "feed-1" }, connected.connectionId)));
    const encryptedResponse = JSON.parse(String((await responsePromise)[0]));
    expect(decryptRemotePayload(key, encryptedResponse, connected.connectionId)).toEqual({
      kind: "response", requestId: "feed-1", result: { goals: [], thinking: [], unassignedActions: [] },
    });
    await expect.poll(() => store.state?.devices.length).toBe(1);
    expect(JSON.stringify(store.state)).not.toContain(ticket.secret);
    expect(handle).toHaveBeenCalledWith({ kind: "feed.get", requestId: "feed-1" });

    const devices = (await host.status()).devices;
    expect(devices).toEqual([expect.objectContaining({ deviceId: ticket.device, name: "手机浏览器" })]);
    browser.close();
  });
});
