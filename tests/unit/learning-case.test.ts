import { asScenario, buildLearningCases, type LearningFacts } from "../../src/main/domain/evolution/learning-case";

const facts: LearningFacts = { goalId: "private-goal-secret", workbenchId: "private-workbench-secret", requirementsRevision: 1, resultRevision: 2, observedAt: "2026-10-23T00:00:00.000Z", completed: true, canceled: false, verified: 1, failed: 1, unverified: 0, requirementCount: 2, coveredRequirementCount: 1, foreignEvidenceCount: 0, dependencyViolationCount: 0, redundantReads: 0, environmentFailed: false, executionFailed: false };
describe("objective structural learning cases", () => {
  it("preserves stable identity and never carries private identifiers into evidence or prompts", () => {
    const cases = buildLearningCases(facts);
    expect(cases.map(row => row.defect)).toEqual(["false_completion", "requirement_gap"]);
    expect(buildLearningCases({ ...facts, observedAt: "2026-10-24T00:00:00.000Z" }).map(row => row.caseId)).toEqual(cases.map(row => row.caseId));
    for (const row of cases) {
      const scenario = asScenario(row);
      expect(scenario.expected).toBe("continue");
      expect(JSON.stringify(scenario)).not.toContain("private-");
      expect(row.requiredIds.every(id => row.evidence[id] !== undefined)).toBe(true);
    }
  });
  it.each([{ verified: 2 }, { failed: 2 }, { unverified: 1 }, { requirementCount: 3 }, { coveredRequirementCount: 0 },
    { foreignEvidenceCount: 1 }, { dependencyViolationCount: 1 }, { redundantReads: 2 }, { completed: false }])(
    "creates a new immutable case when authoritative facts change: %j", change => {
      const before = buildLearningCases(facts).find(row => row.defect === "requirement_gap");
      const after = buildLearningCases({ ...facts, ...change }).find(row => row.defect === "requirement_gap");
      expect(after?.caseId).not.toBe(before?.caseId);
      expect(after?.groupId).toBe(before?.groupId);
      expect(after?.split).toBe(before?.split);
    });
  it("isolates connected near duplicates and goal versions into the same split", () => {
    const cases = [
      ...buildLearningCases({ ...facts, sourceGroupId: "known-source" }),
      ...buildLearningCases({ ...facts, sourceGroupId: "known-source", goalId: "other-goal", resultRevision: 3 }),
      ...buildLearningCases({ ...facts, sourceGroupId: "known-source", verified: 2, failed: 0, coveredRequirementCount: 2, resultRevision: 4 }),
    ];
    expect(new Set(cases.map(row => row.groupId)).size).toBe(1);
    expect(new Set(cases.map(row => row.split)).size).toBe(1);
    expect(buildLearningCases({ ...facts, resultRevision: 19 })[0]?.groupId).toBe(buildLearningCases(facts)[0]?.groupId);
    expect(buildLearningCases({ ...facts, goalId: "other-independent-goal" })[0]?.groupId).not.toBe(buildLearningCases(facts)[0]?.groupId);
  });
  it("matches by input structure independently of post-treatment outcomes", () => {
    const successful = buildLearningCases({ ...facts, failed: 0, verified: 2, coveredRequirementCount: 2 });
    const unsuccessful = buildLearningCases({ ...facts, foreignEvidenceCount: 2, dependencyViolationCount: 1, redundantReads: 4 });
    expect(successful[0]?.profile).toBe(unsuccessful[0]?.profile);
    expect(successful[0]?.profile).toBe("requirements:explicit;count:small");
    expect(buildLearningCases({ ...facts, requirementCount: 10 })[0]?.profile).toBe("requirements:explicit;count:small");
    expect(buildLearningCases({ ...facts, requirementCount: 11 })[0]?.profile).toBe("requirements:explicit;count:medium");
    expect(buildLearningCases({ ...facts, requirementCount: 100 })[0]?.profile).toBe("requirements:explicit;count:medium");
    expect(buildLearningCases({ ...facts, requirementCount: 101 })[0]?.profile).toBe("requirements:explicit;count:large");
    expect(buildLearningCases({ ...facts, requirementCount: 0, coveredRequirementCount: 0 })[0]?.profile).toBe("requirements:absent;count:small");
  });
  it("excludes canceled, environmental, execution and unverifiable facts", () => {
    for (const change of [{ canceled: true }, { environmentFailed: true }, { executionFailed: true }, { verified: 0, failed: 0, unverified: 3 }]) {
      expect(buildLearningCases({ ...facts, ...change })).toEqual([]);
    }
    expect(() => buildLearningCases({ ...facts, verified: -1 })).toThrow();
    expect(buildLearningCases({ ...facts, requirementsRevision: 0 })).toEqual([]);
    expect(() => buildLearningCases({ ...facts, coveredRequirementCount: 3 })).toThrow();
  });
  it("requires authoritative coverage rather than inferring missing requirements", () => {
    const healthy = buildLearningCases({ ...facts, failed: 0, requirementCount: 0, coveredRequirementCount: 0 });
    expect(healthy.map(row => row.defect)).toEqual(["healthy"]);
    expect(healthy[0]?.expected).toBe("complete");
    expect(buildLearningCases({ ...facts, completed: false, failed: 0, coveredRequirementCount: 2 })).toEqual([]);
  });
  it.each([0, 2])("requires authoritative completion before creating a positive case with %i redundant reads", redundantReads => {
    expect(buildLearningCases({ ...facts, completed: false, failed: 0, coveredRequirementCount: 2, redundantReads })).toEqual([]);
  });
  it("builds factual identity, dependency and read-efficiency cases", () => {
    const cases = buildLearningCases({ ...facts, failed: 0, coveredRequirementCount: 2, foreignEvidenceCount: 1, dependencyViolationCount: 1, redundantReads: 2 });
    expect(cases.map(row => row.defect)).toEqual(["false_completion", "evidence_identity", "dependency_order", "redundant_read"]);
    expect(buildLearningCases({ ...facts, completed: true, failed: 0, coveredRequirementCount: 2, redundantReads: 2 })[0]?.expected).toBe("complete");
    expect(buildLearningCases({ ...facts, completed: false })).toHaveLength(1);
    expect(buildLearningCases({ ...facts, completed: false, coveredRequirementCount: 2 })).toEqual([]);
    for (const changes of [{ goalId: "" }, { workbenchId: "" }, { sourceGroupId: "" }, { observedAt: "invalid" }, { failed: Number.NaN }]) {
      expect(() => buildLearningCases({ ...facts, ...changes })).toThrow();
    }
    expect(buildLearningCases({ ...facts, resultRevision: 0 })).toEqual([]);
  });
});
