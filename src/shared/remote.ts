import type { JoiAcceptedMessageDto, JoiHomeFeedDto } from "./joi.js";

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_PAIRING_TTL_MS = 10 * 60 * 1_000;
export const REMOTE_MAX_FRAME_BYTES = 256 * 1_024;

export type RemoteConnectionStatus = "connected" | "connecting" | "disabled" | "error";

export interface RemoteDeviceDto {
  createdAt: string;
  deviceId: string;
  lastSeenAt: string;
  name: string;
}

export interface RemotePairingDto {
  expiresAt: string;
  pairingId: string;
  qrUrl: string;
}

export interface RemoteAccessStatusDto {
  devices: RemoteDeviceDto[];
  enabled: boolean;
  hostId: string;
  relayAuthenticationConfigured: boolean;
  relayUrl: string;
  status: RemoteConnectionStatus;
  pairing?: RemotePairingDto;
}

export type RemoteCommand =
  | { kind: "feed.get"; requestId: string }
  | { idempotencyKey: string; kind: "message.send"; requestId: string; text: string };

export interface RemoteCommandResponse {
  error?: { code: string; message: string };
  kind: "response";
  requestId: string;
  result?: JoiAcceptedMessageDto | JoiHomeFeedDto;
}

export interface RemoteEncryptedFrame {
  ciphertext: string;
  iv: string;
  kind: "encrypted";
  seq: number;
  tag: string;
}

export interface RemoteHandshakeHello {
  clientNonce: string;
  deviceId: string;
  deviceName: string;
  hostId: string;
  kind: "handshake.hello";
  mode: "pair" | "resume";
  pairingId?: string;
  proof: string;
  version: typeof REMOTE_PROTOCOL_VERSION;
}

export interface RemoteHandshakeReady {
  hostNonce: string;
  kind: "handshake.ready";
  proof: string;
  version: typeof REMOTE_PROTOCOL_VERSION;
}
