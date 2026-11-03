// @vitest-environment jsdom
import { webcrypto } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  decryptRemotePayload,
  deriveRemoteSessionKey,
  encryptRemotePayload,
  remoteHandshakeProof,
} from "../../src/main/infrastructure/remote/remote-frame-crypto.js";
import {
  browserRemoteHandshakeProof,
  decryptBrowserRemotePayload,
  deriveBrowserRemoteSessionKey,
  encryptBrowserRemotePayload,
} from "../../src/renderer/remote-connection.js";

describe("browser and host remote crypto", () => {
  beforeAll(() => Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto }));

  it("uses an interoperable proof, HKDF session key and AES-GCM frame format", async () => {
    const secret = Buffer.alloc(32, 9).toString("base64url");
    const clientNonce = Buffer.alloc(24, 4).toString("base64url");
    const hostNonce = Buffer.alloc(24, 5).toString("base64url");
    const context = { clientNonce, deviceId: "device-1", hostId: "host-1", mode: "pair" as const, pairingId: "pair-1" };
    expect(await browserRemoteHandshakeProof(secret, context)).toBe(remoteHandshakeProof(secret, context));

    const browserKey = await deriveBrowserRemoteSessionKey(secret, clientNonce, hostNonce);
    const hostKey = deriveRemoteSessionKey(secret, clientNonce, hostNonce);
    const browserFrame = await encryptBrowserRemotePayload(browserKey, 1, { kind: "feed.get", requestId: "request-1" }, "connection-1");
    expect(decryptRemotePayload(hostKey, browserFrame, "connection-1")).toEqual({ kind: "feed.get", requestId: "request-1" });
    const hostFrame = encryptRemotePayload(hostKey, 1, { kind: "response", requestId: "request-1" }, "connection-1");
    await expect(decryptBrowserRemotePayload(browserKey, hostFrame, "connection-1")).resolves.toEqual({ kind: "response", requestId: "request-1" });
  });
});
