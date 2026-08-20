import type { JoiFailureSuggestedActionDto } from "../../../shared/joi.js";

export function normalizeJoiFailureReasonCode(value: unknown): string {
  return typeof value === "string" && value.length <= 80 && /^[A-Za-z0-9_.:-]+$/u.test(value)
    ? value
    : "unknown_error";
}

/** Maps a bounded machine reason to a safe user action; never presents raw error text. */
export function suggestedActionForJoiInputFailure(reasonCode: string): JoiFailureSuggestedActionDto {
  if (reasonCode === "unsafe_reasoning_tool" || reasonCode === "legacy_scheduler_failure") return "RESTART_OR_UPDATE";
  if (/^(?:auth_failed|bad_request|connection_error|credential_|http_error|model_|not_found|provider_|rate_limited|server_error|source_|timeout)/u.test(reasonCode)) {
    return "CHECK_MODEL_SOURCE";
  }
  return "RETRY_OR_EXPORT_DIAGNOSTICS";
}
