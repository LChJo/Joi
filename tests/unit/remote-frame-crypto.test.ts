import { describe, expect, it } from "vitest";

import {
  RemoteReplayGuard,
  decryptRemotePayload,
  deriveRemoteSessionKey,
  encryptRemotePayload,
  remoteHandshakeProof,
  verifyRemoteHandshakeProof,
} from "../../src/main/infrastructure/remote/remote-frame-crypto.js";

describe("remote frame crypto", () => {
  it("authenticates a device, derives the same session key and rejects replay", () => {
    const secret = Buffer.alloc(32, 7).toString("base64url");
    const context = {
      clientNonce: Buffer.alloc(24, 1).toString("base64url"),
      deviceId: "device-1",
      hostId: "host-1",
      mode: "resume" as const,
      pairingId: "",
    };
    const proof = remoteHandshakeProof(secret, context);
    expect(verifyRemoteHandshakeProof(secret, context, proof)).toBe(true);
    expect(verifyRemoteHandshakeProof(secret, { ...context, deviceId: "device-2" }, proof)).toBe(false);

    const hostNonce = Buffer.alloc(24, 2).toString("base64url");
    const left = deriveRemoteSessionKey(secret, context.clientNonce, hostNonce);
    const right = deriveRemoteSessionKey(secret, context.clientNonce, hostNonce);
    expect(left.equals(right)).toBe(true);

    const encrypted = encryptRemotePayload(left, 1, { kind: "feed.get", requestId: "request-1" }, "connection-1");
    expect(JSON.stringify(encrypted)).not.toContain("feed.get");
    expect(decryptRemotePayload(left, encrypted, "connection-1")).toEqual({ kind: "feed.get", requestId: "request-1" });

    const guard = new RemoteReplayGuard();
    expect(() => guard.accept(1)).not.toThrow();
    expect(() => guard.accept(1)).toThrow("remote_frame_replayed");
  });
});
