import type { PartnerRunOutput } from "../ports/partner-execution.js";

export type PartnerRunFailurePhase = "CONFIGURATION" | "ENGINE" | "EXECUTION" | "MODEL" | "RECOVERY";
export type PartnerRunSideEffectState = "NONE" | "OBSERVED" | "UNKNOWN";

export interface PartnerRunFailure {
  phase: PartnerRunFailurePhase;
  reasonCode: string;
  retryable: boolean;
  sideEffectState: PartnerRunSideEffectState;
  /**
   * Set only by the engine that just learned this route's real limit from the refusal itself, which
   * makes a replay a different request. That is the single case where a capacity rejection may be
   * retried: without it the next attempt would be the identical one that was already refused.
   */
  routeLimitLearned?: boolean;
}

interface PartnerRunFailureCarrier {
  partialArtifacts?: unknown;
  partnerRunFailure?: unknown;
}

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "connect", "connection_error", "partner_run_idle_timed_out", "partner_run_timed_out",
  "partner_tool_timed_out", "rate_limited", "server_error", "timeout",
]);
const ALTERNATE_SOURCE_CODES = new Set(["auth_forbidden", "http_403", "model_access_forbidden", "region_forbidden"]);
const PHASES = new Set<PartnerRunFailurePhase>(["CONFIGURATION", "ENGINE", "EXECUTION", "MODEL", "RECOVERY"]);
const SIDE_EFFECT_STATES = new Set<PartnerRunSideEffectState>(["NONE", "OBSERVED", "UNKNOWN"]);
const STABLE_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;

export function classifyPartnerRunFailure(
  error: unknown,
  context: { phase: PartnerRunFailurePhase; sideEffectState: PartnerRunSideEffectState },
): PartnerRunFailure {
  const reasonCode = reasonCodeOf(error);
  return {
    phase: context.phase,
    reasonCode,
    retryable: context.sideEffectState === "NONE" && transientFailure(error, reasonCode),
    sideEffectState: context.sideEffectState,
  };
}

export function partnerRunFailureFromError(
  error: unknown,
  fallback: { phase: PartnerRunFailurePhase; sideEffectState: PartnerRunSideEffectState } = { phase: "EXECUTION", sideEffectState: "UNKNOWN" },
): PartnerRunFailure {
  const carried = failureCarrier(error);
  return carried ?? classifyPartnerRunFailure(error, fallback);
}

/** Wraps an engine exception without retaining its raw message, payload, stack or credentials. */
export function wrapPartnerRunFailure(
  error: unknown,
  context: { phase: PartnerRunFailurePhase; sideEffectState: PartnerRunSideEffectState },
): Error & { code: string; partnerRunFailure: PartnerRunFailure } {
  const partnerRunFailure = partnerRunFailureFromError(error, context);
  const partialArtifacts = partnerRunArtifactsFromError(error);
  return Object.assign(new Error("partner_run_failed"), {
    code: partnerRunFailure.reasonCode,
    ...(partialArtifacts.length === 0 ? {} : { partialArtifacts }),
    partnerRunFailure,
  });
}

/** Extracts only bounded artifact metadata from a failed run; raw model/provider output is never retained. */
export function partnerRunArtifactsFromError(error: unknown): PartnerRunOutput["artifacts"] {
  if (error === null || typeof error !== "object") return [];
  const candidates = (error as PartnerRunFailureCarrier).partialArtifacts;
  if (!Array.isArray(candidates)) return [];
  return candidates.slice(0, 64).flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.length === 0 || value.name.length > 240
      || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) return [];
    return [{
      ...(typeof value.artifactRef === "string" && value.artifactRef.length <= 1_000 ? { artifactRef: value.artifactRef } : {}),
      ...(typeof value.mimeType === "string" && value.mimeType.length <= 240 ? { mimeType: value.mimeType } : {}),
      name: value.name,
      size: value.size,
    }];
  });
}

export function safePartnerRunFailureBody(failure: PartnerRunFailure): string {
  const facts = `phase=${failure.phase}; reasonCode=${failure.reasonCode}; retryable=${String(failure.retryable)}; sideEffectState=${failure.sideEffectState}`;
  const next = failure.phase === "CONFIGURATION" && failure.sideEffectState === "NONE"
    ? "No partner model or tool was started, so it is safe to retry after correction. Open Partner settings, reselect an installed Skill, and enable the read tool when using a narrowed tool list."
    // A capacity refusal that named the limit it refused on is not the same request when it is
    // replayed: the next attempt is sized to what the provider said it accepts, so reassigning the
    // Work is safe. Without a stated limit the retry would be identical, hence the warning below.
    : (failure.reasonCode === "context_too_large" || failure.reasonCode === "model_context_budget_exhausted") && failure.routeLimitLearned === true
    ? "The model route refused this request for size and stated the limit it accepts. A fresh attempt on this route is sized to that limit, so reassigning this Work is safe."
    : failure.reasonCode === "context_too_large"
    ? "The request exceeded the model route's context window. Split the Work into smaller units or shrink its inputs; do not replay it unchanged."
    : failure.reasonCode === "invalid_model"
      ? "The selected model is incompatible with this route. Select a compatible READY model before creating a safe recovery attempt."
    : failure.reasonCode === "unsupported_parameter" || failure.reasonCode === "invalid_request"
      ? "The provider rejected this request shape. Use a valid model route before creating a safe recovery attempt."
    : failure.reasonCode === "model_context_budget_exhausted"
      ? "The model route had no safe completion budget left. Verify any produced artifacts, then create a smaller supplemental Work instead of replaying it unchanged."
    : failure.reasonCode === "model_refused"
      ? "The model refused this request. Restate the task or ask the user for guidance; do not replay it unchanged."
    : failure.reasonCode === "partner_run_timed_out" || failure.reasonCode === "partner_run_idle_timed_out" || failure.reasonCode === "dispatch_watchdog_timed_out"
      ? "The run exceeded its deadline and was terminated. Treat any produced artifacts as unverified until checked, then cover the remaining gap with a supplemental Work instead of replaying the run unchanged."
    // A stalled run was already warned before it was ended, so replaying it unchanged would repeat
    // the same shape. What it did produce is kept; what it did not is best covered by a Work small
    // enough to finish — the size is usually the reason it stalled.
    : failure.reasonCode === "partner_run_stalled"
      ? "The run kept calling tools without changing anything in its workspace, was told so, and was ended. Verify any produced artifacts, then split the remaining work into a smaller Work rather than replaying this one unchanged."
      : failure.retryable
    ? "Joi may reassign this Work to another suitable available partner, or select another READY model source and create a new immutable partner revision when no suitable alternative partner exists."
    : failure.sideEffectState === "NONE"
      ? "Joi must inspect configuration or request input before creating another attempt."
      : failure.sideEffectState === "OBSERVED"
        ? "Joi must not replay this Work automatically because a tool that may have side effects was called. Existing artifacts must be verified before a supplemental Work is created for any remaining gap."
        : "Joi must not replay this Work automatically because side effects cannot be determined. Existing artifacts must be verified before a supplemental Work is created for any remaining gap.";
  return `Partner run failed safely (${facts}). ${next}`;
}

function failureCarrier(error: unknown): PartnerRunFailure | null {
  if (error === null || typeof error !== "object") return null;
  const value = (error as PartnerRunFailureCarrier).partnerRunFailure;
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Partial<PartnerRunFailure>;
  const phase = candidate.phase;
  const sideEffectState = candidate.sideEffectState;
  if (phase === undefined || sideEffectState === undefined
    || !PHASES.has(phase)
    || !SIDE_EFFECT_STATES.has(sideEffectState)
    || typeof candidate.reasonCode !== "string" || !STABLE_CODE.test(candidate.reasonCode)) return null;
  const routeLimitLearned = candidate.routeLimitLearned === true;
  return {
    phase,
    reasonCode: candidate.reasonCode,
    retryable: candidate.retryable === true && sideEffectState === "NONE"
      && (transientReasonCode(candidate.reasonCode) || ALTERNATE_SOURCE_CODES.has(candidate.reasonCode) || routeLimitLearned),
    ...(routeLimitLearned ? { routeLimitLearned: true } : {}),
    sideEffectState,
  };
}

function reasonCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const detail = (error as { detail?: unknown }).detail;
    if (typeof detail === "string" && /max[_ -]?completion[_ -]?tokens|completion budget/iu.test(detail)) {
      return "model_context_budget_exhausted";
    }
    const status = numericStatus(error);
    if (status === 403 && typeof detail === "string") return classifyHttp403Detail(detail);
    if (status === 400 && typeof detail === "string") {
      if (/(?:invalid|unsupported|unknown|not found|does not exist)[^\r\n]{0,80}\bmodel\b|\bmodel\b[^\r\n]{0,80}(?:invalid|unsupported|unknown|not found|does not exist)/iu.test(detail)) {
        return "invalid_model";
      }
      if (/(?:unsupported|unknown|unrecognized)[^\r\n]{0,80}(?:parameter|field)|(?:parameter|field)[^\r\n]{0,80}(?:unsupported|not supported|unknown|unrecognized)/iu.test(detail)) {
        return "unsupported_parameter";
      }
      if (/invalid[_ -]?request(?:[_ -]?error)?|malformed request/iu.test(detail)) return "invalid_request";
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && STABLE_CODE.test(code)) return code;
    if (status !== null) return `http_${String(status)}`;
  }
  return "unknown_error";
}

/** Classifies transient provider text and returns only a persistence-safe reason code. */
export function classifyHttp403Detail(detail: string): "auth_forbidden" | "http_403" | "model_access_forbidden" | "region_forbidden" | "request_policy_forbidden" {
  if (/(?:invalid|expired|revoked|missing)[^\r\n]{0,80}(?:api[ _-]?key|token|credential)|(?:api[ _-]?key|token|credential)[^\r\n]{0,80}(?:invalid|expired|revoked|missing)|authentication|unauthori[sz]ed/iu.test(detail)) {
    return "auth_forbidden";
  }
  if (/(?:model|deployment)[^\r\n]{0,100}(?:not (?:available|enabled|allowed)|access|permission|entitlement)|(?:access|permission|entitlement)[^\r\n]{0,100}(?:model|deployment)/iu.test(detail)) {
    return "model_access_forbidden";
  }
  if (/(?:region|country|geograph|location|territor)[^\r\n]{0,100}(?:unsupported|unavailable|restricted|blocked|forbidden)|(?:unsupported|unavailable|restricted|blocked|forbidden)[^\r\n]{0,100}(?:region|country|geograph|location|territor)/iu.test(detail)) {
    return "region_forbidden";
  }
  if (/(?:request|content|prompt)[^\r\n]{0,100}(?:policy|safety|blocked|forbidden|restricted)|(?:policy|safety)[^\r\n]{0,100}(?:request|content|prompt)/iu.test(detail)) {
    return "request_policy_forbidden";
  }
  return "http_403";
}

function transientFailure(error: unknown, reasonCode: string): boolean {
  const status = numericStatus(error);
  if (status !== null && (status === 408 || status === 429 || status >= 500)) return true;
  return transientReasonCode(reasonCode);
}

function transientReasonCode(reasonCode: string): boolean {
  if (/^http_(?:408|429|5\d{2})$/u.test(reasonCode)) return true;
  return TRANSIENT_CODES.has(reasonCode.toUpperCase()) || TRANSIENT_CODES.has(reasonCode);
}

function numericStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const record = error as { status?: unknown; statusCode?: unknown };
  const value = typeof record.status === "number" ? record.status : record.statusCode;
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}
