import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { RemoteEncryptedFrame } from "../../../shared/remote.js";

export interface RemoteHandshakeProofContext {
  clientNonce: string;
  deviceId: string;
  hostId: string;
  mode: "pair" | "resume";
  pairingId: string;
}

function decodeSecret(secret: string): Buffer {
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length !== 32) throw new Error("remote_secret_invalid");
  return bytes;
}

function proofBody(context: RemoteHandshakeProofContext): string {
  return ["joi-remote-v1", context.mode, context.hostId, context.deviceId, context.pairingId, context.clientNonce].join("\n");
}

export function remoteHandshakeProof(secret: string, context: RemoteHandshakeProofContext): string {
  return createHmac("sha256", decodeSecret(secret)).update(proofBody(context), "utf8").digest("base64url");
}

export function verifyRemoteHandshakeProof(secret: string, context: RemoteHandshakeProofContext, proof: string): boolean {
  const expected = Buffer.from(remoteHandshakeProof(secret, context), "base64url");
  const actual = Buffer.from(proof, "base64url");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function remoteReadyProof(secret: string, context: RemoteHandshakeProofContext, hostNonce: string): string {
  return createHmac("sha256", decodeSecret(secret))
    .update(`${proofBody(context)}\n${hostNonce}\nready`, "utf8")
    .digest("base64url");
}

export function deriveRemoteSessionKey(secret: string, clientNonce: string, hostNonce: string): Buffer {
  const salt = Buffer.concat([Buffer.from(clientNonce, "base64url"), Buffer.from(hostNonce, "base64url")]);
  return Buffer.from(hkdfSync("sha256", decodeSecret(secret), salt, Buffer.from("joi-browser-remote-session-v1"), 32));
}

function aad(connectionId: string, seq: number): Buffer {
  return Buffer.from(`joi-remote-v1\n${connectionId}\n${String(seq)}`, "utf8");
}

export function encryptRemotePayload(key: Uint8Array, seq: number, payload: unknown, connectionId: string): RemoteEncryptedFrame {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("remote_frame_sequence_invalid");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(connectionId, seq));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    kind: "encrypted",
    seq,
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptRemotePayload(key: Uint8Array, frame: RemoteEncryptedFrame, connectionId: string): unknown {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(frame.iv, "base64url"));
  decipher.setAAD(aad(connectionId, frame.seq));
  decipher.setAuthTag(Buffer.from(frame.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(frame.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as unknown;
}

export function createRemoteSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function createRemoteNonce(): string {
  return randomBytes(24).toString("base64url");
}

export class RemoteReplayGuard {
  #lastSequence = 0;

  accept(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence <= this.#lastSequence) throw new Error("remote_frame_replayed");
    this.#lastSequence = sequence;
  }
}
