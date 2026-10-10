export type EvolutionModule = "context" | "completion";
export interface EvolutionStrategy {
  context: "baseline" | "requirements_first" | "open_questions_first";
  completion: "baseline" | "evidence_matrix" | "contradiction_check";
}
export type EvolutionBudgetPresetKey = "off" | "low" | "medium" | "high";
export interface EvolutionBudgetPreset {
  key: EvolutionBudgetPresetKey;
  /** Maximum background model calls charged to one workbench per UTC day. */
  limit: number;
}
/** A full evaluation batch needs roughly 700 (typical) to 1441 (worst case) calls; presets pace it from ~2 days to ~4 weeks of idle time. */
export const EVOLUTION_BUDGET_PRESETS: readonly EvolutionBudgetPreset[] = [
  { key: "off", limit: 0 },
  { key: "low", limit: 50 },
  { key: "medium", limit: 150 },
  { key: "high", limit: 400 },
];
export const DEFAULT_EVOLUTION_DAILY_CALL_LIMIT = 0;
/**
 * A batch starts once the evidence pool holds this many objectively evaluable goals, of which at
 * least EVOLUTION_FAILURE_THRESHOLD are attributable to context or completion policy. The shared
 * pool can create only a global baseline; a workbench overlay uses the same thresholds on local
 * evidence. Shared constants keep the settings panel and the gate aligned.
 */
export const EVOLUTION_EVIDENCE_THRESHOLD = 10;
export const EVOLUTION_FAILURE_THRESHOLD = 3;
/** Verification failures among the first monitored goals after promotion that force a rollback. Deliberately lower than the trigger threshold: a freshly promoted strategy is expected to beat its parent, so its elimination line is stricter. */
export const EVOLUTION_MONITOR_REVERT_THRESHOLD = 2;
/** One driver step is one bounded model call; a single handle() advances at most this many. */
export const EVOLUTION_MAX_STEPS_PER_HANDLE = 20;
/**
 * Wall-clock budget for one handle(). Must stay far below the 15-minute stalled-turn watchdog in
 * JoiTaskComponent, or a legitimately long-running handle would be aborted as a stuck turn, feed the
 * crash-loop breaker and eventually park the workbench.
 */
export const EVOLUTION_HANDLE_TIME_BUDGET_MS = 120_000;
/** Consecutive invalid model responses tolerated on one workbench before its batch is abandoned. */
export const EVOLUTION_RESPONSE_INVALID_RETRY_LIMIT = 2;
/** Consecutive invalid model responses across every workbench that trip the global breaker. */
export const EVOLUTION_RESPONSE_INVALID_BREAKER_LIMIT = 10;
/** How long a run-now request stays eligible while waiting for an idle slot. */
export const EVOLUTION_RUN_NOW_TTL_MILLIS = 15 * 60_000;
export type EvolutionReason = "collecting" | "disabled" | "budget_exhausted" | "evaluating" | "canary" | "promoted" | "rolled_back" | "model_changed" | "revalidation_required" | "revision_limit_reached" | "insufficient_samples" | "insufficient_gain" | "quality_regression" | "cost_regression" | "hard_violation" | "invalid_evaluation" | "invalid_candidate" | "call_failed" | "model_response_invalid";
export type EvolutionScope = "GLOBAL" | "WORKBENCH";
export type EvolutionFailureCause = "none" | "context" | "completion" | "execution" | "environment" | "unknown";
export interface EvolutionVersionDto {
  revisionId: string;
  parentRevisionId: string | null;
  module: EvolutionModule;
  status: "CANDIDATE" | "CANARY" | "ACTIVE" | "SUPERSEDED" | "REJECTED" | "ROLLED_BACK";
  scope?: EvolutionScope;
  createdAt: string;
  reason: EvolutionReason;
  baselineSuccesses: number;
  candidateSuccesses: number;
  evaluatedRuns: number;
}
/** The four stages a batch moves through, in order. Shared so the panel and the ports cannot drift. */
export type EvolutionPhase = "DEVELOP" | "PROPOSE" | "VALIDATE" | "EVALUATE";
export type EvolutionDryRunOutcome = "promoted" | "rejected" | "truncated" | "not_started";
export interface EvolutionDryRunPhaseDto {
  phase: EvolutionPhase;
  /** Synthetic model calls spent in this phase; equivalently, driver steps. */
  steps: number;
  /** Rollouts completed in this phase. */
  rollouts: number;
}
/**
 * What a manual dry run proved. It exercises the whole batch pipeline against a deterministic stand-in
 * model, so it says the orchestration and its gates work — not that a real strategy would earn anything.
 * Never carries scenario bodies, prompts, observations or goal content.
 */
export interface EvolutionDryRunReportDto {
  workbenchId: string;
  /** The one field to read first. */
  outcome: EvolutionDryRunOutcome;
  verdict: EvolutionReason | null;
  promoted: boolean;
  /** Synthetic calls, one per driver step. Always zero real provider calls. */
  steps: number;
  phases: EvolutionDryRunPhaseDto[];
  /** Where it stopped when outcome is not "promoted". */
  blockedAt: { phase: EvolutionPhase | null; reason: EvolutionReason } | null;
  truncated: boolean;
  revision: EvolutionVersionDto | null;
  evaluation: { scenarios: number; baselineSuccesses: number; candidateSuccesses: number; evaluatedRuns: number } | null;
  /** A missed self check means the stand-in drifted, not that the pipeline is broken. */
  selfCheck: { expectedVerdict: "promote"; matched: boolean };
  /** The synthetic pool that bypassed the evidence gate. */
  syntheticEvidence: { evaluable: number; verificationFailed: number };
  /** Emitted diagnostic names with counts only: payloads stay out of the report. */
  events: { name: string; count: number }[];
  durationMs: number;
}
/** The verdict statistics of the most recently finished batch, kept so the panel can show how close a rejection came to promotion. */
export interface EvolutionLastVerdict {
  reason: EvolutionReason;
  at: string;
  baselineSuccesses: number;
  candidateSuccesses: number;
  evaluatedRuns: number;
}
export interface EvolutionBatchRecordDto {
  batchId: string;
  workbenchId: string;
  scope: EvolutionScope;
  phase: EvolutionPhase;
  startedAt: string;
  finishedAt: string | null;
  reason: EvolutionReason;
  calls: number;
  tokens: number | null;
  revisionId: string | null;
}
export interface EvolutionOverviewDto {
  workbenches: number;
  enabled: number;
  evaluating: number;
  canary: number;
  active: number;
  revalidationRequired: number;
  poolEvaluable: number;
  poolVerificationFailed: number;
  batches: EvolutionBatchRecordDto[];
}
export interface EvolutionStatusDto {
  workbenchId: string;
  dailyCallLimit: number;
  callsUsedToday: number;
  evidenceCount: number;
  evaluableCount: number;
  /**
   * The shared trigger pool as this workbench's gate sees it: evidence observed since its own last
   * verdict. Reported alongside the per-workbench counts so the panel can explain why a batch has
   * not started instead of leaving the user to guess.
   */
  poolEvaluable: number;
  poolVerificationFailed: number;
  activeRevisionId: string | null;
  globalRevisionId?: string | null;
  canaryRevisionId?: string | null;
  activeEffective?: boolean;
  revalidationRequired?: boolean;
  reason: EvolutionReason;
  /** Set while a run-now request waits for an idle slot; null once consumed or expired. */
  runRequestedAt: string | null;
  lastVerdict: EvolutionLastVerdict | null;
  currentBatch?: EvolutionBatchRecordDto | null;
  batchHistory?: EvolutionBatchRecordDto[];
  versions: EvolutionVersionDto[];
}
