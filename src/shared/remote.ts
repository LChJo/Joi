import type { JoiAcceptedMessageDto, JoiHomeFeedDto } from "./joi.js";

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_PAIRING_TTL_MS = 10 * 60 * 1_000;
export const REMOTE_MAX_FRAME_BYTES = 256 * 1_024;

export type RemoteConnectionStatus = "connected" | "connecting" | "disabled" | "error";

export const REMOTE_DIAGNOSTIC_CODES = [
  "transportStarting", "transportReady", "transportFailed", "peerOpened", "peerClosed",
  "handshakeReceived", "handshakeInvalid", "hostMismatch", "pairingUnavailable",
  "deviceUnavailable", "proofInvalid", "handshakeReady", "firstCommandReceived",
  "sessionRejected", "hostSendFailed", "handlerFailed",
  "quicAccepted", "quicFailed", "streamAccepted", "streamFailed", "helloAccepted", "helloInvalid", "streamClosed",
  "quicIncoming", "quicTimedOut", "quicReset", "quicLocallyClosed", "quicVersionMismatch",
  "quicCidsExhausted", "quicPeerApplicationClosed", "quicPeerTransportClosed", "quicTransportError",
  "quicAuthenticationFailed", "quicLocallyRejected", "quicUnknownError",
  "quicTlsNoApplicationProtocol", "quicTlsHandshakeFailure", "quicTlsProtocolVersion",
  "quicTlsCertificateRejected", "quicTlsAlert",
] as const;
export type RemoteDiagnosticCode = typeof REMOTE_DIAGNOSTIC_CODES[number];
export interface RemoteDiagnosticDto { at: string; code: RemoteDiagnosticCode; sequence: number }

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
  diagnostics?: RemoteDiagnosticDto[];
}

export type RemoteCommand =
  | { kind: "feed.get"; requestId: string; paged?: boolean }
  | { kind: "catalog.get"; requestId: string }
  | { kind: "goal.get" | "goal.agents"; requestId: string; goalId: string; cursor?: string }
  | { kind: "agent.conversation"; requestId: string; goalId: string; agentId: string; cursor?: string }
  | { kind: "read.next"; requestId: string; cursor: string }
  | { idempotencyKey: string; kind: "message.send"; requestId: string; text: string; workbenchId?: string }
  | { kind: "message.retry"; requestId: string; inputId: string; text?: string }
  | { kind: "message.clarify"; requestId: string; inputId: string; text?: string; workbenchId?: string; partnerId?: string; questionId?: string; questionVersion?: number; actionChoice?: "RESUME" | "CONTINUE" | "ACCEPT_CURRENT" }
  | { kind: "message.cancel" | "message.dismiss" | "message.closeHistoricalReview"; requestId: string; inputId: string };

export interface RemoteReadPage {
  encoding: "json";
  chunk: string;
  nextCursor?: string;
}

export interface RemoteCommandResponse {
  error?: { code: string; message: string };
  kind: "response";
  requestId: string;
  result?: JoiAcceptedMessageDto | JoiHomeFeedDto | RemoteReadPage;
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
  capabilities?: string[];
  hostNonce: string;
  kind: "handshake.ready";
  proof: string;
  version: typeof REMOTE_PROTOCOL_VERSION;
}
