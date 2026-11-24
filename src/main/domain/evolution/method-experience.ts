import { parseMethodPolicy, type MethodPolicy } from "./learning-policy.js";
import type { LearningEvaluationComparison } from "./learning-evaluation.js";
import { validEvaluationComparisons } from "./strategy.js";

export interface MethodExperience {
  parent: MethodPolicy;
  candidate: MethodPolicy;
  baselineSuccesses: number;
  candidateSuccesses: number;
  baselineCalls: number;
  candidateCalls: number;
  baselineTokens: number | null;
  candidateTokens: number | null;
  violations: number;
  runs: number;
  conditions?: { profile: string; scope: "GLOBAL" | "WORKBENCH"; defects: string[] };
  observedActions?: { baseline: number; candidate: number; baselineReads:number;candidateReads:number };
  counterexamples?: { regressions: number; hardViolations: number };
}

/** Development comparisons are conditional evidence, never held-out or production benefit. */
export function deriveMethodExperience(input: {
  parent: Readonly<MethodPolicy>;
  candidate: Readonly<MethodPolicy>;
  comparisons: readonly LearningEvaluationComparison[];
}): MethodExperience | null {
  const rows = input.comparisons;
  if (rows.length === 0 || !validEvaluationComparisons(rows)) return null;
  const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);
  const paired = rows.every(row => row.baselineTokens !== undefined && row.candidateTokens !== undefined);
  const result: MethodExperience = {
    parent: parseMethodPolicy(input.parent), candidate: parseMethodPolicy(input.candidate, input.parent),
    baselineSuccesses: total(rows.map(row => row.baseline.filter(Boolean).length)),
    candidateSuccesses: total(rows.map(row => row.candidate.filter(Boolean).length)),
    baselineCalls: total(rows.map(row => row.baselineCalls)), candidateCalls: total(rows.map(row => row.candidateCalls)),
    baselineTokens: paired ? total(rows.map(row => row.baselineTokens ?? 0)) : null,
    candidateTokens: paired ? total(rows.map(row => row.candidateTokens ?? 0)) : null,
    violations: total(rows.map(row => row.violations)), runs: rows.length * 3,
  };
  return rows.some(row => row.baseline.filter(Boolean).length !== row.candidate.filter(Boolean).length
    || row.baselineCalls !== row.candidateCalls
    || (row.baselineTokens !== undefined && row.candidateTokens !== undefined && row.baselineTokens !== row.candidateTokens)
    || row.violations > 0) ? result : null;
}
