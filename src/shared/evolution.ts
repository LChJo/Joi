export type EvolutionModule = "context" | "completion";
export interface EvolutionStrategy {
  context: "baseline" | "requirements_first" | "open_questions_first";
  completion: "baseline" | "evidence_matrix" | "contradiction_check";
}
export type EvolutionBudgetPresetKey = "off" | "low" | "medium" | "high";
export interface EvolutionBudgetPreset {
  key: EvolutionBudgetPresetKey;
  /** Maximum background model calls per workbench per UTC day. */
  limit: number;
}
/** A full evaluation batch needs roughly 700 (typical) to 1441 (worst case) calls; presets pace it from ~2 days to ~4 weeks of idle time. */
export const EVOLUTION_BUDGET_PRESETS: readonly EvolutionBudgetPreset[] = [
  { key: "off", limit: 0 },
  { key: "low", limit: 50 },
  { key: "medium", limit: 150 },
  { key: "high", limit: 400 },
];
export const DEFAULT_EVOLUTION_DAILY_CALL_LIMIT = 50;
/**
 * A batch starts once the evidence pool holds this many objectively evaluable goals, of which at
 * least EVOLUTION_FAILURE_THRESHOLD ended in a verification failure. The pool spans every workbench
 * because evaluation runs on fixed synthetic scenarios identical for all of them; the resulting
 * strategy revision is still bound to a single workbench. Shared so the settings panel can show the
 * same numbers the gate actually uses.
 */
export const EVOLUTION_EVIDENCE_THRESHOLD = 10;
export const EVOLUTION_FAILURE_THRESHOLD = 3;
export type EvolutionReason = "collecting" | "disabled" | "budget_exhausted" | "evaluating" | "promoted" | "rolled_back" | "model_changed" | "insufficient_samples" | "insufficient_gain" | "quality_regression" | "cost_regression" | "hard_violation" | "invalid_evaluation" | "invalid_candidate" | "call_failed";
export interface EvolutionVersionDto {
  revisionId: string;
  parentRevisionId: string | null;
  module: EvolutionModule;
  status: "CANDIDATE" | "ACTIVE" | "SUPERSEDED" | "REJECTED" | "ROLLED_BACK";
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
  reason: EvolutionReason;
  versions: EvolutionVersionDto[];
}
