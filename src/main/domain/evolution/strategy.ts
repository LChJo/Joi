import { DomainError } from "../errors.js";
import type { EvolutionReason, EvolutionStrategy } from "../../../shared/evolution.js";

export const baselineStrategy: Readonly<EvolutionStrategy> = Object.freeze({ context: "baseline", completion: "baseline" });
const contextModes = ["baseline", "requirements_first", "open_questions_first"];
const completionModes = ["baseline", "evidence_matrix", "contradiction_check"];

export function parseStrategy(value: unknown, parent?: EvolutionStrategy): EvolutionStrategy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new DomainError("evolution_strategy_invalid", "Strategy is invalid.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.context !== "string" || !contextModes.includes(record.context)
    || typeof record.completion !== "string" || !completionModes.includes(record.completion)) throw new DomainError("evolution_strategy_invalid", "Strategy is invalid.");
  const strategy = { context: record.context, completion: record.completion } as EvolutionStrategy;
  if (parent !== undefined && Number(parent.context !== strategy.context) + Number(parent.completion !== strategy.completion) !== 1) {
    throw new DomainError("evolution_strategy_invalid", "Change exactly one strategy module.");
  }
  return strategy;
}

export function composeStrategyInstructions(strategy: EvolutionStrategy): string {
  const instructions = ["Preserve the original goal, explicit constraints, unresolved questions and unmet acceptance conditions. User requirements and immutable runtime gates always take precedence."];
  if (strategy.context === "requirements_first") instructions.push("Before planning or summarizing, restate the current goal's acceptance requirements and bind each relevant result to them. Keep requirements ahead of historical summaries; retrieve referenced evidence before relying on it.");
  if (strategy.context === "open_questions_first") instructions.push("Before advancing, list unresolved questions and unmet requirements. Preserve these through summaries; discard redundant history before any current constraint. Retrieve only current-goal evidence needed to resolve them.");
  if (strategy.completion === "evidence_matrix") instructions.push("Before completion, build an acceptance-to-evidence matrix. Read the evidence for every required item. A partner's completion claim is not verification. Missing evidence requires one concrete verification task or an explicit blocked outcome; never claim completion with unmet conditions.");
  if (strategy.completion === "contradiction_check") instructions.push("Before completion, compare all current evidence against the original requirements and check for contradictions, stale results, failed checks and missing deliverables. Resolve each gap with bounded verification or report it as blocked. Never repeat an external side effect to obtain evidence.");
  return instructions.join("\n");
}

export interface EvaluationComparison {
  scenarioId: string;
  baseline: boolean[];
  candidate: boolean[];
  baselineCalls: number;
  candidateCalls: number;
  violations: number;
}
export function promotionDecision(rows: readonly EvaluationComparison[]): "promote" | EvolutionReason {
  if (new Set(rows.map((row) => row.scenarioId)).size !== rows.length || rows.some((row) =>
    row.baseline.length !== 3 || row.candidate.length !== 3 || [...row.baseline, ...row.candidate].some((v) => typeof v !== "boolean")
    || !Number.isFinite(row.baselineCalls) || row.baselineCalls < 1 || !Number.isFinite(row.candidateCalls) || row.candidateCalls < 1
    || !Number.isInteger(row.violations) || row.violations < 0)) return "invalid_evaluation";
  if (rows.length < 30) return "insufficient_samples";
  if (rows.some((row) => row.violations > 0)) return "hard_violation";
  if (rows.some((row) => row.candidate.filter(Boolean).length < row.baseline.filter(Boolean).length)) return "quality_regression";
  const baseline = rows.reduce((sum, row) => sum + row.baseline.filter(Boolean).length, 0);
  const candidate = rows.reduce((sum, row) => sum + row.candidate.filter(Boolean).length, 0);
  if ((candidate - baseline) / (rows.length * 3) < 0.05) return "insufficient_gain";
  if (rows.reduce((sum, row) => sum + row.candidateCalls, 0) > rows.reduce((sum, row) => sum + row.baselineCalls, 0) * 1.1) return "cost_regression";
  return "promote";
}
