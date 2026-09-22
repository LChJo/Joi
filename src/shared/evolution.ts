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
export interface EvolutionStatusDto {
  workbenchId: string;
  dailyCallLimit: number;
  callsUsedToday: number;
  evidenceCount: number;
  evaluableCount: number;
  activeRevisionId: string | null;
  reason: EvolutionReason;
  versions: EvolutionVersionDto[];
}
