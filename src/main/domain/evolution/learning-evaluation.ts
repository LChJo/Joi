import type { EvolutionReason } from "../../../shared/evolution.js";
import { validEvaluationComparisons, type EvaluationComparison } from "./strategy.js";

export interface LearningEvaluationComparison extends EvaluationComparison {
  sourceGoalId?: string;
  sourceGroupId?: string;
  targetDefect?: boolean;
  efficiencyDefect?: boolean;
}
export interface MethodEvaluationInput {
  safety: readonly LearningEvaluationComparison[];
  heldOut: readonly LearningEvaluationComparison[];
  targetCaseIds?: readonly string[];
}
export interface MethodEvaluationDecision {
  verdict: "promote" | EvolutionReason;
  benefit: "quality" | "efficiency" | null;
}

export function decideMethodEvaluation({ safety, heldOut, targetCaseIds = [] }: MethodEvaluationInput): MethodEvaluationDecision {
  const reject = (verdict: EvolutionReason): MethodEvaluationDecision => ({ verdict, benefit: null });
  const all = [...safety, ...heldOut];
  if (!validEvaluationComparisons(all)) return reject("invalid_evaluation");
  const independentGroups = new Set(heldOut.map(row => row.sourceGroupId ?? row.sourceGoalId).filter(id => typeof id === "string" && id.length > 0));
  const reproducibleDefect = heldOut.some(row => (row.targetDefect === true || targetCaseIds.includes(row.scenarioId)) && row.baseline.filter(value => !value).length >= 2);
  const reproducibleEfficiencyDefect = heldOut.some(row => row.efficiencyDefect === true && successes(row.baseline) === 3 && successes(row.candidate) === 3);
  if (safety.length < 30 || heldOut.length < 5 || independentGroups.size < 5 || independentGroups.size !== heldOut.length
    || (!reproducibleDefect && !reproducibleEfficiencyDefect)) return reject("insufficient_samples");
  if (all.some(row => row.violations > 0)) return reject("hard_violation");
  if (all.some(row => successes(row.candidate) < successes(row.baseline))) return reject("quality_regression");
  const baselineSuccess = heldOut.reduce((total, row) => total + successes(row.baseline), 0);
  const candidateSuccess = heldOut.reduce((total, row) => total + successes(row.candidate), 0);
  const baselineCalls = heldOut.reduce((total, row) => total + row.baselineCalls, 0);
  const candidateCalls = heldOut.reduce((total, row) => total + row.candidateCalls, 0);
  const completeTokens = heldOut.every(row => row.baselineTokens !== undefined && row.candidateTokens !== undefined);
  const pairedTokens = heldOut.filter(row => row.baselineTokens !== undefined && row.candidateTokens !== undefined);
  const baselineTokens = pairedTokens.reduce((total, row) => total + (row.baselineTokens ?? 0), 0);
  const candidateTokens = pairedTokens.reduce((total, row) => total + (row.candidateTokens ?? 0), 0);
  const gain = (candidateSuccess - baselineSuccess) / (heldOut.length * 3);
  if (gain >= 0.05) {
    if (!reproducibleDefect) return reject("insufficient_samples");
    if (candidateCalls > baselineCalls * 1.1 || candidateTokens > baselineTokens * 1.1) return reject("cost_regression");
    return { verdict: "promote", benefit: "quality" };
  }
  const callsSaved = candidateCalls <= baselineCalls * 0.85;
  const tokensSaved = completeTokens && candidateTokens <= baselineTokens * 0.85;
  if ((reproducibleDefect || reproducibleEfficiencyDefect) && (callsSaved || tokensSaved) && candidateCalls <= baselineCalls && candidateTokens <= baselineTokens) {
    return { verdict: "promote", benefit: "efficiency" };
  }
  if (candidateCalls > baselineCalls || candidateTokens > baselineTokens) return reject("cost_regression");
  return reject("insufficient_gain");
}

function successes(trials: readonly boolean[]): number {
  return trials.filter(Boolean).length;
}
