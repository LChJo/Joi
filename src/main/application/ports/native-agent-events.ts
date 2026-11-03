export type NativeAgentStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown";

export type NativeAgentPart =
  | { type: "text"; text: string }
  | { type: "file"; mimeType: string; name: string; size: number }
  | { type: "data"; mimeType: string; name: string; size: number };

/**
 * Joi-owned, A2A-shaped runtime surface. Vendor payloads must be reduced to
 * these safe fields inside infrastructure before crossing into application.
 */
export type NativeAgentEvent =
  | { type: "message"; role: "agent" | "user"; parts: NativeAgentPart[] }
  | { type: "status"; state: NativeAgentStatus }
  | { type: "artifact"; artifact: { artifactRef?: string; mimeType: string; name: string; size: number } }
  /**
   * `toolCallId` is an opaque engine id, in the same class as `entryId`/`artifactRef`: it is a
   * correlation key, not a payload, so it is safe on this surface. `summary` is a bounded,
   * already-masked one-line hint produced inside infrastructure; raw arguments and results
   * still never cross this port.
   */
  | { type: "tool_activity"; toolCallId: string; toolName: string; state: "started" | "completed" | "failed"; summary?: string };
