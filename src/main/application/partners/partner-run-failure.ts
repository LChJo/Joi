export type PartnerRunFailurePhase = "ENGINE" | "EXECUTION" | "MODEL" | "RECOVERY";
export type PartnerRunSideEffectState = "NONE" | "OBSERVED" | "UNKNOWN";

export interface PartnerRunFailure {
  phase: PartnerRunFailurePhase;
  reasonCode: string;
  retryable: boolean;
  sideEffectState: PartnerRunSideEffectState;
}

interface PartnerRunFailureCarrier {
  partnerRunFailure?: unknown;
}

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "connect", "partner_run_timed_out", "rate_limited", "server_error", "timeout",
]);
const PHASES = new Set<PartnerRunFailurePhase>(["ENGINE", "EXECUTION", "MODEL", "RECOVERY"]);
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

export function partnerRunFailureFromError(error: unknown): PartnerRunFailure {
  const carried = failureCarrier(error);
  return carried ?? classifyPartnerRunFailure(error, { phase: "EXECUTION", sideEffectState: "UNKNOWN" });
}

/** Wraps an engine exception without retaining its raw message, payload, stack or credentials. */
export function wrapPartnerRunFailure(
  error: unknown,
  context: { phase: PartnerRunFailurePhase; sideEffectState: PartnerRunSideEffectState },
): Error & { code: string; partnerRunFailure: PartnerRunFailure } {
  const partnerRunFailure = classifyPartnerRunFailure(error, context);
  return Object.assign(new Error("partner_run_failed"), {
    code: partnerRunFailure.reasonCode,
    partnerRunFailure,
  });
}

export function safePartnerRunFailureBody(failure: PartnerRunFailure): string {
  const facts = `phase=${failure.phase}; reasonCode=${failure.reasonCode}; retryable=${String(failure.retryable)}; sideEffectState=${failure.sideEffectState}`;
  const next = failure.retryable
    ? "Joi may select another READY model source, create a new immutable partner revision, and reassign this Work as a new attempt."
    : failure.sideEffectState === "NONE"
      ? "Joi must inspect configuration or request input before creating another attempt."
      : "Joi must not replay this Work automatically because side effects were observed or cannot be determined.";
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
  return {
    phase,
    reasonCode: candidate.reasonCode,
    retryable: candidate.retryable === true && sideEffectState === "NONE" && transientReasonCode(candidate.reasonCode),
    sideEffectState,
  };
}

function reasonCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const status = numericStatus(error);
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && STABLE_CODE.test(code)) return code;
    if (status !== null) return `http_${String(status)}`;
  }
  return "unknown_error";
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
