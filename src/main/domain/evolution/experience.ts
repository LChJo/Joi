import type { EvolutionStrategy } from "../../../shared/evolution.js";
import { parseStrategy, validEvaluationComparisons, type EvaluationComparison } from "./strategy.js";

export interface EvolutionExperience {
  id: string;
  batchId: string;
  revisionId: string;
  createdAt: string;
  evidenceScope: "development";
  conditions: { sourcePin: string; evaluatorVersion: string; parentStrategy: EvolutionStrategy; scenarioIds: string[] };
  defects: { scenarioId: string; baselineFailures: number }[];
  change: { module: "context" | "completion"; from: string; to: string };
  comparisons: EvaluationComparison[];
  benefit: { additionalSuccesses: number; modelCallDelta: number; tokenDelta: number | null };
  risks: { scenarioId: string; kind: "quality" | "hard_violation" | "calls" | "tokens" }[];
  outcome: "benefit" | "risk" | "mixed";
  invalidWhen: ("source_pin_changed" | "evaluator_changed" | "parent_strategy_changed" | "scenario_contract_changed")[];
}

/** A lesson states measured changes under fixed conditions; equal observations establish no lesson. */
export function deriveEvolutionExperience(input: {
  id: string; batchId: string; revisionId: string; createdAt: string; sourcePin: string; evaluatorVersion: string;
  parentStrategy: EvolutionStrategy; strategy: EvolutionStrategy; comparisons: readonly EvaluationComparison[];
}): EvolutionExperience | undefined {
  const rows = input.comparisons;
  if (rows.length === 0 || rows.length > 10 || !validEvaluationComparisons(rows) || rows.some(row => !row.scenarioId.startsWith("development:"))) return undefined;
  try { parseStrategy(input.strategy, input.parentStrategy); } catch { return undefined; }
  const successes = (values: readonly boolean[]) => values.filter(Boolean).length;
  const risks: EvolutionExperience["risks"] = [];
  for (const row of rows) {
    if (successes(row.candidate) < successes(row.baseline)) risks.push({ scenarioId: row.scenarioId, kind: "quality" });
    if (row.violations > 0) risks.push({ scenarioId: row.scenarioId, kind: "hard_violation" });
    if (row.candidateCalls > row.baselineCalls * 1.1) risks.push({ scenarioId: row.scenarioId, kind: "calls" });
    if (row.baselineTokens !== undefined && row.candidateTokens !== undefined && row.candidateTokens > row.baselineTokens * 1.1) risks.push({ scenarioId: row.scenarioId, kind: "tokens" });
  }
  const additionalSuccesses = rows.reduce((sum, row) => sum + successes(row.candidate) - successes(row.baseline), 0);
  const modelCallDelta = rows.reduce((sum, row) => sum + row.candidateCalls - row.baselineCalls, 0);
  const tokenDelta = rows.every(row => row.baselineTokens !== undefined && row.candidateTokens !== undefined)
    ? rows.reduce((sum, row) => sum + (row.candidateTokens ?? 0) - (row.baselineTokens ?? 0), 0) : null;
  const beneficial = additionalSuccesses > 0 || modelCallDelta < 0 || (tokenDelta !== null && tokenDelta < 0);
  if (!beneficial && risks.length === 0) return undefined;
  const module = input.strategy.context !== input.parentStrategy.context ? "context" : "completion";
  const scenarioIds = rows.filter(row => successes(row.candidate) !== successes(row.baseline) || row.baselineCalls !== row.candidateCalls
    || (row.baselineTokens !== undefined && row.candidateTokens !== undefined && row.baselineTokens !== row.candidateTokens) || row.violations > 0).map(row => row.scenarioId);
  return {
    id: input.id, batchId: input.batchId, revisionId: input.revisionId, createdAt: input.createdAt, evidenceScope: "development",
    conditions: { sourcePin: input.sourcePin, evaluatorVersion: input.evaluatorVersion, parentStrategy: { ...input.parentStrategy }, scenarioIds },
    defects: rows.filter(row => scenarioIds.includes(row.scenarioId) && row.baseline.some(value => !value))
      .map(row => ({ scenarioId: row.scenarioId, baselineFailures: row.baseline.filter(value => !value).length })),
    change: { module, from: input.parentStrategy[module], to: input.strategy[module] },
    comparisons: rows.map(row => ({ ...row, baseline: [...row.baseline], candidate: [...row.candidate] })),
    benefit: { additionalSuccesses, modelCallDelta, tokenDelta }, risks,
    outcome: risks.length === 0 ? "benefit" : beneficial ? "mixed" : "risk",
    invalidWhen: ["source_pin_changed", "evaluator_changed", "parent_strategy_changed", "scenario_contract_changed"],
  };
}

/** Both improvements and counterexamples can be relevant; freshness alone establishes neither. */
export function selectEvolutionExperiences(experiences: readonly EvolutionExperience[], query: {
  sourcePin: string; evaluatorVersion: string; parentStrategy: EvolutionStrategy; failedScenarioIds: readonly string[];
}): EvolutionExperience[] {
  const relevant = (experience: EvolutionExperience) => experience.conditions.scenarioIds.filter(id => query.failedScenarioIds.includes(id)).length;
  return experiences.filter(experience => experience.conditions.sourcePin === query.sourcePin && experience.conditions.evaluatorVersion === query.evaluatorVersion
    && experience.conditions.parentStrategy.context === query.parentStrategy.context && experience.conditions.parentStrategy.completion === query.parentStrategy.completion
    && relevant(experience) > 0)
    .sort((left, right) => relevant(right) - relevant(left) || right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id)).slice(0, 4);
}
