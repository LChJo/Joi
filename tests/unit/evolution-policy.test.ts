import { baselineStrategy, parseStrategy, promotionDecision, composeStrategyInstructions } from "../../src/main/domain/evolution/strategy";

describe("evolution strategy boundaries", () => {
  it("rejects executable or unrecognized policy fields and changes to both modules", () => {
    expect(() => parseStrategy({ ...baselineStrategy, shell: "echo unsafe" }, baselineStrategy)).toThrow();
    expect(() => parseStrategy({ context: "requirements_first", completion: "evidence_matrix" }, baselineStrategy)).toThrow();
    expect(parseStrategy({ ...baselineStrategy, context: "requirements_first" }, baselineStrategy)).toEqual({ ...baselineStrategy, context: "requirements_first" });
  });
  it("keeps mandatory requirements and evidence gates in every strategy", () => {
    expect(composeStrategyInstructions(baselineStrategy)).toContain("original goal");
    expect(composeStrategyInstructions({ ...baselineStrategy, completion: "evidence_matrix" })).toContain("evidence");
    expect(composeStrategyInstructions({ context: "open_questions_first", completion: "contradiction_check" })).toContain("contradictions");
    expect(composeStrategyInstructions({ ...baselineStrategy, context: "requirements_first" })).toContain("retrieve");
  });
  it.each([null, [], 1, {}, { context: false, completion: "baseline" }, { context: "unknown", completion: "baseline" }, { context: "baseline", completion: "code" }])("rejects malformed strategy %j", (input) => {
    expect(() => parseStrategy(input)).toThrow();
  });
  it("rejects unchanged strategies and invalid evaluation measurements", () => {
    expect(() => parseStrategy(baselineStrategy, baselineStrategy)).toThrow();
    const row = { scenarioId: "s", baseline: [true,true,true], candidate: [true,true,true], baselineCalls: 3, candidateCalls: 3, violations: 0 };
    for (const change of [{ baseline: [] }, { candidate: [] }, { baselineCalls: Number.NaN }, { candidateCalls: 0 }, { violations: -1 }, { violations: 0.5 }]) {
      expect(promotionDecision([{ ...row, ...change }])).toBe("invalid_evaluation");
    }
  });
  it("rejects insufficient samples, regressions, hard violations and excessive calls", () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({ scenarioId: `s${String(index)}`, baseline: [index >= 3, true, true], candidate: [true, true, true], baselineCalls: 3, candidateCalls: 3, violations: 0 }));
    expect(promotionDecision(rows)).toBe("insufficient_gain");
    assert(rows[3]);
    rows[3].baseline = [false, false, true];
    expect(promotionDecision(rows)).toBe("promote");
    expect(promotionDecision(rows.slice(1))).toBe("insufficient_samples");
    assert(rows[0]);
    expect(promotionDecision([...rows, rows[0]])).toBe("invalid_evaluation");
    expect(promotionDecision(rows.map((r, i) => i === 0 ? { ...r, violations: 1 } : r))).toBe("hard_violation");
    expect(promotionDecision(rows.map((r, i) => i === 29 ? { ...r, candidate: [false, true, true] } : r))).toBe("quality_regression");
    expect(promotionDecision(rows.map((r) => ({ ...r, candidateCalls: 4 })))).toBe("cost_regression");
    expect(promotionDecision(rows.map((r) => ({ ...r, baselineTokens: 100, candidateTokens: 111 })))).toBe("cost_regression");
    expect(promotionDecision(rows.map((r) => ({ ...r, baselineTokens: 100, candidateTokens: 105, candidateCalls: 99 })))).toBe("promote");
  });
});
