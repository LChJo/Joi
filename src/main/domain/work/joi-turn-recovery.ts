export const JOI_TURN_FAILURE_LIMIT = 8;
export const JOI_TURN_RETRY_BASE_MILLIS = 30_000;
export const JOI_TURN_RETRY_MAX_MILLIS = 10 * 60_000;

const SYNTHESIS_OUTPUT_FAILURES = new Set([
  "goal_synthesis_reference_invalid", "goal_synthesis_state_invalid", "goal_synthesis_correction_exhausted",
  "joi_turn_outcome_uncommitted", "joi_goal_synthesis_outcome_uncommitted", "joi_turn_completion_empty",
  "joi_goal_synthesis_summary_empty", "joi_model_toolcall_leak", "custom_model_tool_capability_unverified",
]);

export function isSynthesisOutputFailure(reasonCode: string): boolean {
  return SYNTHESIS_OUTPUT_FAILURES.has(reasonCode);
}

export function isSynthesisStateCorrection(reasonCode: string): boolean {
  return reasonCode === "goal_synthesis_reference_invalid" || reasonCode === "goal_synthesis_state_invalid";
}

export function isTerminalTurnFailure(reasonCode: string): boolean {
  return ["source_auth", "source_balance", "source_configuration", "source_access", "source_safety_refusal", "source_content_refusal", "model_context_budget_exhausted"].includes(reasonCode);
}

export function joiTurnRetryDelay(failureCount: number): number {
  return Math.min(JOI_TURN_RETRY_MAX_MILLIS, JOI_TURN_RETRY_BASE_MILLIS * 2 ** Math.max(0, failureCount - 1));
}

/** A recovery scan cannot grant replay permission that the execution owner withheld. */
export function canRedriveSynthesis(input: { failureCount: number; reasonCode?: string; unsafeEffects: boolean }): boolean {
  return !input.unsafeEffects && input.failureCount < JOI_TURN_FAILURE_LIMIT
    && !isSynthesisOutputFailure(input.reasonCode ?? "") && !isTerminalTurnFailure(input.reasonCode ?? "");
}
