import { evolutionScenarios, scenarioPrompt, simulateAction } from "../../src/main/domain/evolution/scenarios";

describe("independent evolution simulator", () => {
  it("separates task families and supplies 30 sealed scenarios", () => {
    const development = evolutionScenarios("development");
    const sealed = evolutionScenarios("sealed");
    expect(sealed).toHaveLength(30);
    expect(new Set(sealed.map((s) => s.id)).size).toBe(30);
    expect(new Set(sealed.map((s) => Object.values(s.evidence)[1])).size).toBe(30);
    expect(sealed.every((s) => !development.some((d) => d.family === s.family))).toBe(true);
    assert(sealed[0]);
    expect(scenarioPrompt(sealed[0])).not.toContain('"expected"');
  });
  it("requires reading evidence, rejects fabricated completion and prohibits writes", () => {
    const scenario = evolutionScenarios("sealed")[0];
    assert(scenario);
    const empty = { scenarioId: scenario.id, variant: "baseline" as const, attempt: 0, calls: 1, observations: [], actions: [] };
    expect(simulateAction(scenario, empty, { action: "finish", decision: scenario.expected, evidenceIds: scenario.requiredIds }).success).toBe(false);
    let run = empty;
    for (const id of scenario.requiredIds) run = simulateAction(scenario, run, { action: "read_evidence", evidenceId: id });
    expect(simulateAction(scenario, run, { action: "finish", decision: scenario.expected, evidenceIds: scenario.requiredIds }).success).toBe(true);
    expect(simulateAction(scenario, empty, { action: "shell", command: "anything" }).violation).toBe(true);
    expect(simulateAction(scenario, empty, null).violation).toBe(true);
    expect(simulateAction(scenario, empty, { action: "read_evidence", evidenceId: "missing" }).observations).toEqual(["Evidence ID does not exist."]);
  });
});
