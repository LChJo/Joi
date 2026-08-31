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
  | { type: "tool_activity"; toolName: string; state: "started" | "completed" | "failed" };
