import { DomainError } from "../../domain/errors.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../../application/ports/runtime-diagnostics.js";

export type NativeCliProbePhase = "create" | "invoke" | "resolve";
export type NativeCliProbeReasonCode =
  | "partner_cli_auth_required"
  | "partner_cli_model_unsupported"
  | "partner_cli_process_failed"
  | "partner_cli_probe_failed"
  | "partner_cli_provider_unavailable"
  | "partner_cli_rate_limited";

export class NativeCliRunError extends DomainError {
  constructor(readonly probeReasonCode: NativeCliProbeReasonCode) {
    super("local_cli_run_failed", "Local CLI run failed.");
  }
}

export function settleNativeProbe(
  diagnostics: RuntimeDiagnostics | undefined,
  input: { engine: "claude-code" | "codex"; phase: NativeCliProbePhase; startedAt: number },
  result: { available: boolean; reasonCode?: string },
): { available: boolean; reasonCode?: string } {
  emitRuntimeDiagnostic(diagnostics, "joi.partner.cli_probe.settled", {
    durationMs: Math.max(0, Date.now() - input.startedAt),
    engine: input.engine,
    outcome: result.available ? "ready" : "failed",
    phase: input.phase,
    ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
  });
  return result;
}

export function classifyNativeCliFailure(error: unknown): NativeCliProbeReasonCode {
  const signal = collectFailureSignal(error).toLowerCase();
  if (/model[^\n]{0,80}(?:does not exist|invalid|not found|not supported|unknown|unsupported)|(?:does not exist|invalid|not found|not supported|unknown|unsupported)[^\n]{0,80}model|model_not_found/u.test(signal)) return "partner_cli_model_unsupported";
  if (/not logged in|login required|authentication|authentication_failed|unauthenticated|unauthorized|invalid[^\n]{0,40}credential|\b401\b/u.test(signal)) return "partner_cli_auth_required";
  if (/rate.?limit|too many requests|\b429\b/u.test(signal)) return "partner_cli_rate_limited";
  if (/\b(?:eacces|enoent|eperm)\b|child process|exited with code|no std(?:in|out)|spawn/u.test(signal)) return "partner_cli_process_failed";
  if (/\b5\d\d\b|econn|fetch failed|network|overloaded|service unavailable|socket hang up/u.test(signal)) return "partner_cli_provider_unavailable";
  return "partner_cli_probe_failed";
}

function collectFailureSignal(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (parts.join(" ").length >= 4_000 || depth > 3) return;
    if (typeof candidate === "string" || typeof candidate === "number") { parts.push(String(candidate).slice(0, 1_000)); return; }
    if (candidate === null || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) { for (const item of candidate.slice(0, 20)) visit(item, depth + 1); return; }
    const row = candidate as Record<string, unknown>;
    for (const key of ["name", "code", "status", "statusCode", "message", "error", "cause", "errors"] as const) {
      if (row[key] !== undefined) visit(row[key], depth + 1);
    }
  };
  visit(error, 0);
  return parts.join(" ");
}
