import { decideMethodEvaluation, type LearningEvaluationComparison } from "../../src/main/domain/evolution/learning-evaluation";

const row = (id: string): LearningEvaluationComparison => ({ scenarioId: id, sourceGoalId: `goal-${id}`, baseline: [true, true, true], candidate: [true, true, true], baselineCalls: 100, candidateCalls: 100, baselineTokens: 1000, candidateTokens: 1000, violations: 0 });
const safety = Array.from({ length: 30 }, (_, i) => row(`safety-${String(i)}`));
const heldOut = Array.from({ length: 5 }, (_, i) => ({ ...row(`held-${String(i)}`), baseline: i === 0 ? [false, false, true] : [true, true, true], targetDefect: i === 0 }));
describe("independent quality and efficiency gates", () => {
  it("promotes quality using production held-out denominator only", () => {
    expect(decideMethodEvaluation({ safety, heldOut })).toEqual({ verdict: "promote", benefit: "quality" });
    expect(decideMethodEvaluation({ safety: safety.slice(1), heldOut }).verdict).toBe("insufficient_samples");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map(row => ({ ...row, sourceGoalId: "same" })) }).verdict).toBe("insufficient_samples");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map(row => ({ ...row, targetDefect: false })) }).verdict).toBe("insufficient_samples");
  });
  it("counts independent provenance groups rather than copied goal identifiers", () => {
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map(row => ({ ...row, sourceGroupId: "one-shared-source" })) }).verdict).toBe("insufficient_samples");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map((row, index) => ({ ...row, sourceGroupId: `group-${String(index)}` })) }).verdict).toBe("promote");
    const repeatedGroup = [...heldOut, { ...row("another-goal"), sourceGoalId: heldOut[1]?.sourceGoalId ?? "held-1" }];
    expect(decideMethodEvaluation({ safety, heldOut: repeatedGroup }).verdict).toBe("insufficient_samples");
  });
  it("promotes stable quality with call savings and rejects unknown-token savings", () => {
    const efficient = heldOut.map(row => ({ ...row, candidate: row.baseline, candidateCalls: 85 }));
    expect(decideMethodEvaluation({ safety, heldOut: efficient })).toEqual({ verdict: "promote", benefit: "efficiency" });
    expect(decideMethodEvaluation({ safety, heldOut: efficient.map(row => ({ ...row, candidateCalls: 100, candidateTokens: 850 })) }).benefit).toBe("efficiency");
    expect(decideMethodEvaluation({ safety, heldOut: efficient.map(row => { const unknown = { ...row, candidateCalls: 100 }; delete unknown.baselineTokens; return unknown; }) }).verdict).toBe("insufficient_gain");
  });
  it("rejects local regression, hard violations, expensive gains and cross-set leakage", () => {
    expect(decideMethodEvaluation({ safety: safety.map((row, i) => i ? row : { ...row, candidate: [false, true, true] }), heldOut }).verdict).toBe("quality_regression");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map(row => ({ ...row, violations: 1 })) }).verdict).toBe("hard_violation");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map(row => ({ ...row, candidateCalls: 111 })) }).verdict).toBe("cost_regression");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map((row, i) => i ? row : { ...row, scenarioId: "safety-0" }) }).verdict).toBe("invalid_evaluation");
  });
  it("accepts explicit target identities and requires reproducible failures", () => {
    const unlabelled = heldOut.map(row => ({ ...row, targetDefect: false }));
    expect(decideMethodEvaluation({ safety, heldOut: unlabelled, targetCaseIds: ["held-0"] }).benefit).toBe("quality");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map(row => ({ ...row, baseline: [false, true, true] })) }).verdict).toBe("insufficient_samples");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map(row => ({ ...row, baseline: [] })) }).verdict).toBe("invalid_evaluation");
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.slice(1) }).verdict).toBe("insufficient_samples");
  });
  it("rejects token cost regression and efficiency at another metric's expense", () => {
    expect(decideMethodEvaluation({ safety, heldOut: heldOut.map(row => ({ ...row, candidateTokens: 1101 })) }).verdict).toBe("cost_regression");
    const efficient = heldOut.map(row => ({ ...row, candidate: row.baseline, candidateCalls: 85, candidateTokens: 1001 }));
    expect(decideMethodEvaluation({ safety, heldOut: efficient }).verdict).toBe("cost_regression");
    const partialTokens = heldOut.map((row, index) => { const result: LearningEvaluationComparison = { ...row, candidateTokens: 1200 }; if (index === 0) delete result.candidateTokens; return result; });
    expect(decideMethodEvaluation({ safety, heldOut: partialTokens }).verdict).toBe("cost_regression");
  });
  it("allows pure efficiency only with an objectively identified read defect", () => {
    const efficient = heldOut.map(row => ({ ...row, baseline: [true, true, true], candidateCalls: 85, efficiencyDefect: row.targetDefect }));
    expect(decideMethodEvaluation({ safety, heldOut: efficient })).toEqual({ verdict: "promote", benefit: "efficiency" });
    expect(decideMethodEvaluation({ safety, heldOut: efficient.map(row => ({ ...row, efficiencyDefect: false })) }).verdict).toBe("insufficient_samples");
  });
});
