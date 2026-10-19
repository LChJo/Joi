import { baselineStrategy, type EvaluationComparison } from "../../src/main/domain/evolution/strategy.js";
import { deriveEvolutionExperience, selectEvolutionExperiences } from "../../src/main/domain/evolution/experience.js";

const comparison = (scenarioId: string, delta = 1): EvaluationComparison => ({ scenarioId,
  baseline: [false, true, true], candidate: [delta > 0, true, delta >= 0], baselineCalls: 9, candidateCalls: 9,
  baselineTokens: 900, candidateTokens: 900, violations: 0 });
const input = () => ({ id: "exp", batchId: "batch", revisionId: "revision", createdAt: "2026-10-19T00:00:00Z",
  sourcePin: "pin", evaluatorVersion: "evaluator", parentStrategy: baselineStrategy,
  strategy: { ...baselineStrategy, completion: "evidence_matrix" as const }, comparisons: [comparison("development:parser")] });

describe("AC-EVO-01/03/06 evidence-backed strategy experience", () => {
  it("records executable comparisons and applicability, without inventing a lesson for unchanged observations", () => {
    const experience = deriveEvolutionExperience(input());
    expect(experience).toMatchObject({ conditions: { sourcePin: "pin", evaluatorVersion: "evaluator", parentStrategy: baselineStrategy, scenarioIds: ["development:parser"] },
      change: { module: "completion", from: "baseline", to: "evidence_matrix" },
      defects: [{ scenarioId: "development:parser", baselineFailures: 1 }],
      benefit: { additionalSuccesses: 1, modelCallDelta: 0, tokenDelta: 0 }, outcome: "benefit", risks: [] });
    expect(experience?.comparisons).toEqual(input().comparisons);
    expect(experience?.invalidWhen).toEqual(["source_pin_changed", "evaluator_changed", "parent_strategy_changed", "scenario_contract_changed"]);
    const row = comparison("development:parser");
    expect(deriveEvolutionExperience({ ...input(), comparisons: [{ ...row, candidate: row.baseline }] })).toBeUndefined();
    expect(deriveEvolutionExperience({ ...input(), comparisons: [] })).toBeUndefined();
    expect(deriveEvolutionExperience({ ...input(), comparisons: [comparison("sealed:held-out")] })).toBeUndefined();
  });
  it("retains failure lessons and chooses related experiences under the same fixed evaluation conditions", () => {
    const good = deriveEvolutionExperience(input());
    const bad = deriveEvolutionExperience({ ...input(), id: "failure", comparisons: [comparison("development:parser", -1)] });
    assert(good); assert(bad);
    expect(bad.outcome).toBe("risk");
    expect(bad.risks).toContainEqual({ scenarioId: "development:parser", kind: "quality" });
    const unrelated = { ...good, id: "unrelated", conditions: { ...good.conditions, scenarioIds: ["development:other"] } };
    const stale = { ...good, id: "stale", conditions: { ...good.conditions, sourcePin: "different" } };
    const selected = selectEvolutionExperiences([unrelated, stale, bad, good], { sourcePin: "pin", evaluatorVersion: "evaluator", parentStrategy: baselineStrategy, failedScenarioIds: ["development:parser"] });
    expect(selected.map(entry => entry.id).sort()).toEqual(["exp", "failure"]);
    expect(selectEvolutionExperiences([good], { sourcePin: "pin", evaluatorVersion: "new", parentStrategy: baselineStrategy, failedScenarioIds: ["development:parser"] })).toEqual([]);
    expect(selectEvolutionExperiences([good], { sourcePin: "pin", evaluatorVersion: "evaluator", parentStrategy: good.conditions.parentStrategy, failedScenarioIds: [] })).toEqual([]);
  });
});
