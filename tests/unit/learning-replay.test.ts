import { asScenario, buildLearningCases, learningProfile, type LearningFacts } from "../../src/main/domain/evolution/learning-case";
import { METHOD_OPERATIONS } from "../../src/main/domain/evolution/learning-policy";
import { METHOD_WORK_PLAN_SCHEMA, simulateMethodAction, type SimulationRun } from "../../src/main/domain/evolution/learning-replay";
import { evolutionScenarios } from "../../src/main/domain/evolution/scenarios";

const facts: LearningFacts = { goalId: "private-goal", workbenchId: "private-bench", requirementsRevision: 1, resultRevision: 1, observedAt: "2026-10-23T00:00:00Z", completed: false, canceled: false, verified: 1, failed: 0, unverified: 0, requirementCount: 1, coveredRequirementCount: 1, foreignEvidenceCount: 0, dependencyViolationCount: 1, redundantReads: 0, environmentFailed: false, executionFailed: false };
const item = buildLearningCases(facts).find(c => c.defect === "dependency_order");
assert(item);
const scenario = asScenario(item);
const plan = {
  action: "work_plan", requirementsRevision: 1,
  work: [
    { key: "source", title: "Read prerequisite evidence", partnerId: "fixture-reader", accessMode: "READ", executionNeeds: [], acceptanceChecks: [{ kind: "BODY_PRESENT" }] },
    { key: "review", title: "Review dependent result", partnerId: "fixture-reader", accessMode: "READ", executionNeeds: [], acceptanceChecks: [{ kind: "BODY_PRESENT" }] },
    { key: "verify", title: "Verify acceptance", partnerId: "fixture-reader", accessMode: "READ", executionNeeds: [], acceptanceChecks: [{ kind: "BODY_PRESENT" }] },
  ], dependencies: [{ workKey: "review", dependsOnKey: "source" }, { workKey: "verify", dependsOnKey: "review" }],
};
function readRegisters(): SimulationRun {
  return scenario.requiredIds.reduce<SimulationRun>((run, evidenceId) => simulateMethodAction(scenario, run, { action: "read_evidence", evidenceId }, item), { observations: [], actions: [] });
}
describe("isolated working-method replay", () => {
  it("requires an observable valid dependency plan before successful finish", () => {
    const run = readRegisters();
    expect(simulateMethodAction(scenario, run, { action: "finish", decision: "continue", evidenceIds: scenario.requiredIds }, item).success).toBe(false);
    const planned = simulateMethodAction(scenario, run, plan, item);
    expect(planned.observations.at(-1)).toContain("source > review > verify");
    expect(simulateMethodAction(scenario, planned, { action: "finish", decision: "continue", evidenceIds: scenario.requiredIds }, item).success).toBe(true);
    expect(scenario.request).toContain("fixture-reader");
    expect(JSON.stringify(scenario)).not.toContain("private-");
  });
  it("rejects unknown references, self-dependencies, cycles and missing prerequisites", () => {
    for (const dependencies of [[], [{ workKey: "review", dependsOnKey: "other-case:source" }], [{ workKey: "review", dependsOnKey: "review" }], [...plan.dependencies, { workKey: "source", dependsOnKey: "verify" }]]) {
      expect(simulateMethodAction(scenario, readRegisters(), { ...plan, dependencies }, item)).toMatchObject({ success: false, violation: true });
    }
    expect(simulateMethodAction({ ...scenario, id: "another-case" }, readRegisters(), plan, item)).toMatchObject({ success: false, violation: true });
  });
  it("enforces fixture aliases, acceptance checks and read-only execution ceilings", () => {
    for (const changed of [{ acceptanceChecks: [] }, { partnerId: "external-partner" }, { executionNeeds: ["SHELL"] }, { accessMode: "WRITE" }, { instructions: "execute arbitrary shell" }, { key: "foreign-task" }, { script: "unsafe" }]) {
      expect(simulateMethodAction(scenario, readRegisters(), { ...plan, work: plan.work.map((work, index) => index ? work : { ...work, ...changed }) }, item)).toMatchObject({ success: false, violation: true });
    }
    expect(METHOD_WORK_PLAN_SCHEMA.properties.work.minItems).toBe(3);
  });
  it("preserves the authored scenario contract and counts repeated unchanged reads as actions", () => {
    const fixture = evolutionScenarios("development")[0];
    assert(fixture);
    const repeatedId = fixture.requiredIds[0];
    assert(repeatedId);
    let run: SimulationRun = { observations: [], actions: [] };
    for (const evidenceId of [...fixture.requiredIds, repeatedId]) run = simulateMethodAction(fixture, run, { action: "read_evidence", evidenceId });
    expect(run.actions).toHaveLength(3);
    expect(simulateMethodAction(fixture, run, { action: "finish", decision: fixture.expected, evidenceIds: fixture.requiredIds }).success).toBe(true);
  });
  it("exports input-only profiles and the bounded operation registry", () => {
    expect(learningProfile(10)).toBe("requirements:explicit;count:small");
    expect(learningProfile(100)).toBe("requirements:explicit;count:medium");
    expect(learningProfile(101)).toBe("requirements:explicit;count:large");
    expect(() => learningProfile(-1)).toThrow();
    expect(METHOD_OPERATIONS.planning).toContain("dependency_outline");
  });
});
