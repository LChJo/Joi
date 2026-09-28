import type { ReasoningFailureClassifier } from "../../application/ports/joi-coordinator.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

export class PiReasoningFailureClassifier implements ReasoningFailureClassifier {
  classify(error: unknown): SourceFailureKind | null {
    const value = record(error);
    if (value === null) return null;
    const status = typeof value.status === "number" ? value.status
      : typeof value.statusCode === "number" ? value.statusCode
        : undefined;
    if (status === 401 || status === 403) return "auth";
    if (status === 402) return "balance";
    if (status === 408 || status === 504) return "timeout";
    if (status === 429) return "rate_limited";
    if (status !== undefined && status >= 500) return "server_error";
    if (status !== undefined && status >= 400) return "configuration";
    const code = value.code;
    // A model that renders tool calls as literal text (DSML-style markup) is a protocol
    // failure of the source, not of the request: another route can still answer it.
    if (code === "joi_model_toolcall_leak") return "protocol";
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
    if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(String(code))) return "connect";
    return null;
  }
}
