import type { ReasoningFailureClassifier } from "../../application/ports/joi-coordinator.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";
import { classifyHttp403Detail } from "../../application/partners/partner-run-failure.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

export class PiReasoningFailureClassifier implements ReasoningFailureClassifier {
  classify(error: unknown): SourceFailureKind | null {
    if (error instanceof Error && streamFailures.has(error)) return streamFailures.get(error) ?? null;
    const value = record(error);
    if (value === null) return null;
    const status = typeof value.status === "number" ? value.status
      : typeof value.statusCode === "number" ? value.statusCode
        : undefined;
    if (status === 401) return "auth";
    if (status === 403) {
      const detail = typeof value.detail === "string" ? value.detail : typeof value.message === "string" ? value.message : "";
      const reason = classifyHttp403Detail(detail);
      if (reason === "model_access_forbidden" || reason === "region_forbidden") return "access";
      if (reason === "request_policy_forbidden") return "safety_refusal";
      return "auth";
    }
    if (status === 402) return "balance";
    if (status === 408 || status === 504) return "timeout";
    if (status === 429) return "rate_limited";
    if (status !== undefined && status >= 500) return "server_error";
    if (status !== undefined && status >= 400) return "configuration";
    const code = value.code;
    // A model that renders tool calls as literal text (DSML-style markup) is a protocol
    // failure of the source, not of the request: another route can still answer it.
    if (code === "joi_model_toolcall_leak" || code === "custom_model_tool_capability_unverified") return "protocol";
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
    if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(String(code))) return "connect";
    return null;
  }
}

const streamFailures = new WeakMap<Error, SourceFailureKind>();

/** Provider text is classified locally and never becomes a public error or diagnostic field. */
export function reasoningStreamFailure(detail = ""): Error & { code: string } {
  const statusText = /\b(?:HTTP|status)(?:\s+code)?\s*[:=]?\s*([1-5]\d{2})\b/iu.exec(detail)?.[1]
    ?? /^\s*([1-5]\d{2})\b/u.exec(detail)?.[1];
  const code = /\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT)\b/iu.exec(detail)?.[0]?.toUpperCase();
  const failure = new PiReasoningFailureClassifier().classify({ status: statusText === undefined ? undefined : Number(statusText), code, detail });
  const error = Object.assign(new Error("The reasoning provider request failed."), { code: "reasoning_stream_error" });
  if (failure !== null) streamFailures.set(error, failure);
  return error;
}
