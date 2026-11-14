import type { JoiAcceptedMessageDto, JoiHomeFeedDto } from "./joi.js";
import type { SendConversationInput } from "./conversations.js";
import { isConversationPiExtensions } from "./conversations.js";

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

export type RemoteConversationCommand =
  | { kind: "conversation.catalog"; requestId: string }
  | { kind: "conversation.skills"; requestId: string; engine: string }
  | { kind: "conversation.list"; requestId: string; archived?: boolean }
  | { kind: "conversation.inheritance"; requestId: string; workbenchId: string; partnerId: string; networkId: string }
  | { kind: "conversation.send"; requestId: string; input: SendConversationInput }
  | { kind: "conversation.get" | "conversation.stop" | "conversation.archive" | "conversation.restore" | "conversation.delete"; requestId: string; conversationId: string }
  | { kind: "conversation.history" | "conversation.events"; requestId: string; conversationId: string; cursor?: string }
  | { kind: "conversation.rename"; requestId: string; conversationId: string; title: string }
  | { kind: "conversation.cancelChild"; requestId: string; conversationId: string; childId: string };

export type RemoteCommand = RemoteConversationCommand
  | { kind: "feed.get"; requestId: string; paged?: boolean; preview?: boolean }
  | { kind: "catalog.get"; requestId: string }
  | { kind: "goal.get" | "goal.agents"; requestId: string; goalId: string; cursor?: string }
  | { kind: "goal.results"; requestId: string; goalId: string; cursor?: string }
  | { kind: "goal.artifacts"; requestId: string; goalId: string; cursor?: string }
  | { kind: "goal.result"; requestId: string; goalId: string; resultId: string }
  | { kind: "agent.conversation"; requestId: string; goalId: string; agentId: string; cursor?: string }
  | { kind: "read.next"; requestId: string; cursor: string }
  | { kind: "workbench.create"; requestId: string; inputId: string; name: string; personaSummary: string; projectLabel: string; scopeSummary: string; bindInputId?: string; questionId?: string; questionVersion?: number; idempotencyKey?: string }
  | { idempotencyKey: string; kind: "message.send"; requestId: string; text: string; workbenchId?: string }
  | { kind: "message.retry"; requestId: string; inputId: string; text?: string }
  | { kind: "message.clarify"; requestId: string; inputId: string; text?: string; workbenchId?: string; partnerId?: string; questionId?: string; questionVersion?: number; actionChoice?: "RESUME" | "CONTINUE" | "ACCEPT_CURRENT" }
  | { kind: "message.cancel" | "message.dismiss" | "message.archive" | "message.unarchive" | "message.closeHistoricalReview"; requestId: string; inputId: string };

export function isRemoteConversationCommand(value: unknown): value is RemoteConversationCommand {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const item = value as Record<string,unknown>;
  const string = (key: string,max = 160,empty = false) => typeof item[key] === "string" && (empty || item[key].length > 0) && item[key].length <= max;
  if (!string("requestId")) return false;
  switch (item.kind) {
    case "conversation.catalog": return true;
    case "conversation.skills": return ["pi-core","codex","claude-code"].includes(String(item.engine));
    case "conversation.list": return item.archived === undefined || typeof item.archived === "boolean";
    case "conversation.inheritance": return string("workbenchId") && string("partnerId") && string("networkId",160,true);
    case "conversation.send": {
      if (item.input === null || Array.isArray(item.input) || typeof item.input !== "object") return false;
      const input = item.input as Record<string,unknown>;
      const selection = (values: unknown,max: number) => Array.isArray(values) && values.length <= max && values.every((value: unknown) => typeof value === "string" && value.length <= 240);
      if (Object.keys(input).some(key => !["conversationId","workbenchId","requestId","text","partnerId","networkId","skills","attachmentIds","subagentsEnabled","piExtensions"].includes(key))) return false;
      if (!["conversationId","workbenchId","requestId","partnerId"].every(key => typeof input[key] === "string" && input[key].length > 0 && input[key].length <= 160)) return false;
      return typeof input.text === "string" && input.text.trim().length > 0 && input.text.length <= 64_000
        && typeof input.networkId === "string" && input.networkId.length <= 160
        && selection(input.skills,64) && selection(input.attachmentIds,16)
        && (input.subagentsEnabled === undefined || typeof input.subagentsEnabled === "boolean")
        && (input.piExtensions === undefined || isConversationPiExtensions(input.piExtensions));
    }
    case "conversation.get": case "conversation.stop": case "conversation.archive": case "conversation.restore": case "conversation.delete": return string("conversationId");
    case "conversation.history": case "conversation.events": return string("conversationId") && (item.cursor === undefined || string("cursor",240));
    case "conversation.rename": return string("conversationId") && string("title",80);
    case "conversation.cancelChild": return string("conversationId") && string("childId");
    default: return false;
  }
}

export interface RemoteReadPage {
  encoding: "json";
  chunk: string;
  nextCursor?: string;
}

export interface RemoteWorkbenchDto {
  /** Whether the host also bound this workbench to the input that asked for it. */
  bound?: boolean;
  name: string;
  scopeSummary: string;
  updatedAt: string;
  workbenchId: string;
}

export interface RemoteCommandResponse {
  error?: { code: string; message: string };
  kind: "response";
  requestId: string;
  result?: JoiAcceptedMessageDto | JoiHomeFeedDto | RemoteReadPage | RemoteWorkbenchDto;
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
