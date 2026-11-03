import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MethodLearningService, METHOD_EVALUATOR_VERSION } from "../../src/main/application/evolution/method-learning-service";
import { SqliteMethodLearningStore } from "../../src/main/infrastructure/persistence/sqlite-method-learning-store";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { asScenario, buildLearningCases, learningProfile } from "../../src/main/domain/evolution/learning-case";
import { evolutionScenarios } from "../../src/main/domain/evolution/scenarios";
import { EvolutionModelCallError, type EvolutionModel } from "../../src/main/application/ports/evolution";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("production method learning", () => {
  let fixture: RuntimeFixture;
  let store: SqliteMethodLearningStore;
  let now: string;
  const pin = { modelId: "model", modelRevisionId: "m1", sourceId: "source", sourceRevisionId: "s1" };
  const call = vi.fn<EvolutionModel["call"]>();
  beforeEach(async () => {
    now = "2026-10-23T01:00:00.000Z";
    fixture = await createRuntimeFixture();
    fixture.database.transaction((db) => db.prepare(`INSERT INTO workbenches
      (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
      VALUES ('a','A','p','','','','m','ACTIVE',?,?)`).run(now, now));
    store = new SqliteMethodLearningStore(fixture.database);
    call.mockReset();
  });
  afterEach(async () => fixture.close());
  const service = (legacyStore = new SqliteEvolutionStore(fixture.database)) => new MethodLearningService({ store, legacyStore,
    model: { pin: () => Promise.resolve(pin), call }, now: () => now, id: () => "method-test", stepsPerHandle: 1 });
  function seedDefect() {
    for (let i = 0; i < 30; i += 1) {
      fixture.database.transaction(db => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES (?,?,'private','CONSUMED','a',?,?)`).run(`real-goal-${String(i)}`, `real-goal-${String(i)}`, now, now));
      store.upsertCases(buildLearningCases({
      goalId: `real-goal-${String(i)}`, workbenchId: "a", requirementsRevision: 1, resultRevision: 1, observedAt: now,
      completed: true, canceled: false, verified: 1, failed: 1, unverified: 0, requirementCount: 2,
      coveredRequirementCount: 1, foreignEvidenceCount: 0, dependencyViolationCount: 0, redundantReads: 0,
      environmentFailed: false, executionFailed: false,
      }));
    }
  }
  it.each([
    { enabled: false, paused: false, dailyCallLimit: 150 },
    { enabled: true, paused: true, dailyCallLimit: 150 },
    { enabled: true, paused: false, dailyCallLimit: 0 },
  ])("does not scan foreground history behind a closed learning control: %j", control => {
    store.configureGlobal(control);
    const legacy = new SqliteEvolutionStore(fixture.database);
    const idle = vi.spyOn(legacy, "idle");
    const subject = service(legacy);
    expect(subject.pending()).toEqual([]);
    expect(subject.pending()).toEqual([]);
    expect(idle).not.toHaveBeenCalled();
  });
  it("checks the exhausted global budget before foreground history", () => {
    store.configureGlobal({ enabled: true, paused: false, dailyCallLimit: 150 });
    vi.spyOn(store, "usage").mockReturnValue({ ...store.usage(now.slice(0, 10)), calls: 150 });
    const legacy = new SqliteEvolutionStore(fixture.database);
    const idle = vi.spyOn(legacy, "idle");
    expect(service(legacy).pending()).toEqual([]);
    expect(idle).not.toHaveBeenCalled();
  });
  it("skips monitoring facts when no method is active even while learning is paused", () => {
    store.configureGlobal({ enabled: true, paused: true });
    const monitor = vi.spyOn(store, "currentEvaluationCases");
    service().scan();
    expect(monitor).not.toHaveBeenCalled();
  });
  it("continues active method safety monitoring while learning is paused", () => {
    store.configureGlobal({ enabled: true, paused: true });
    store.saveRevision({ id: "active-method", scope: "GLOBAL", workbenchId: "a", profile: learningProfile(2),
      status: "ACTIVE", createdAt: now, updatedAt: now, state: {
        version: 2, evaluator: METHOD_EVALUATOR_VERSION, pin, policy: { version: 2, context: [], planning: [], completion: ["acceptance_matrix"] },
        parentRevisionId: null, module: "completion", benefit: "quality", baselineSuccesses: 5, candidateSuccesses: 10, evaluatedRuns: 30,
        candidateGoals: [], controlGoals: [], reason: "promoted", datasetIds: [], defect: "false_completion",
      } });
    const monitor = vi.spyOn(store, "currentEvaluationCases");
    service().scan();
    expect(monitor).toHaveBeenCalledOnce();
    expect(store.revision("active-method")?.status).toBe("ACTIVE");
  });
  it("does not spend calls when no mechanically reproducible case exists", () => {
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 });
    subject.configure("a", 150);
    expect(subject.requestRun("a").learning?.blockers).toContain("no_reproducible_case");
    expect(subject.pending()).toEqual([]);
    expect(call).not.toHaveBeenCalled();
    expect(store.usage(now.slice(0, 10)).calls).toBe(0);
  });
  it("explains the daily candidate lock while keeping explicit evaluation available", () => {
    seedDefect();
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 }); subject.configure("a", 150);
    store.configureGlobal({ lastCandidateDay: now.slice(0, 10) });
    expect(subject.status("a").learning?.blockers).toContain("daily_candidate_limit");
    expect(subject.pending()).toEqual([]);
    subject.requestRun("a");
    expect(subject.status("a").learning?.blockers).not.toContain("daily_candidate_limit");
    expect(subject.pending()).toHaveLength(1);
  });
  it("retains the experiment and evidence after protocol failures and resumes explicitly", async () => {
    seedDefect();
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 });
    subject.configure("a", 150);
    call.mockRejectedValue(new EvolutionModelCallError({ kind: "multiple_tool_calls", toolCallCount: 2 }, 45));
    await subject.handle("evolution:a");
    await subject.handle("evolution:a");
    expect(store.experiments()[0]).toMatchObject({ status: "PAUSED", phase: "PROTOCOL" });
    expect(store.usage(now.slice(0, 10))).toMatchObject({ calls: 2, tokens: 90 });
    expect(subject.pending()).toEqual([]);
    const count = store.listCases().length;
    subject.resumeGlobal();
    subject.resumeWorkbench("a");
    expect(store.experiments()[0]).toMatchObject({ status: "RUNNING", phase: "PROTOCOL" });
    expect(store.listCases()).toHaveLength(count);
    expect(subject.pending()).toHaveLength(1);
  });
  it("stops at the global cap and continues the same protocol across a UTC day", async () => {
    seedDefect();
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 2 });
    subject.configure("a", 150);
    call.mockResolvedValue({ value: { action: "read_evidence", evidenceId: "record-11" }, tokens: 20 });
    await subject.handle("evolution:a");
    call.mockResolvedValue({ value: { action: "read_evidence", evidenceId: "record-13" }, tokens: 20 });
    await subject.handle("evolution:a");
    expect(store.usage(now.slice(0, 10)).calls).toBe(2);
    expect(subject.pending()).toEqual([]);
    const experimentId = store.experiments()[0]?.id;
    now = "2026-10-24T01:00:00.000Z";
    call.mockResolvedValue({ value: { action: "finish", decision: "complete", evidenceIds: ["record-11", "record-13"] }, tokens: 20 });
    await subject.handle("evolution:a");
    expect(store.experiments()[0]).toMatchObject({ id: experimentId, phase: "DEVELOP" });
    expect(store.usage(now.slice(0, 10)).calls).toBe(1);
  });
  it("parks scheduling at a retained workbench sublimit until the next UTC day", async () => {
    seedDefect();
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 }); subject.configure("a", 1);
    call.mockResolvedValue({ value: { action: "read_evidence", evidenceId: "record-11" }, tokens: 20 });
    await subject.handle("evolution:a");
    const experimentId = store.experiments()[0]?.id;
    expect(store.usage(now.slice(0, 10)).calls).toBe(1);
    expect(subject.pending()).toEqual([]);
    expect(subject.status("a").learning?.blockers).toContain("budget_exhausted");
    now = "2026-10-24T01:00:00.000Z";
    expect(subject.pending()).toHaveLength(1);
    call.mockResolvedValue({ value: { action: "read_evidence", evidenceId: "record-13" }, tokens: 20 });
    await subject.handle("evolution:a");
    expect(store.experiments()[0]?.id).toBe(experimentId);
    expect(subject.pending()).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("evaluates a production-derived method through independent sealed trials before canary", async () => {
    seedDefect();
    const scenarios = new Map([...evolutionScenarios("development"), ...evolutionScenarios("sealed"), ...store.listCases().map(asScenario)].map(s => [s.id, s]));
    expect(store.listCases().filter(c => c.split === "sealed").length).toBeGreaterThanOrEqual(5);
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 });
    subject.configure("a", 150);
    call.mockImplementation(async input => {
      await Promise.resolve();
      if (input.mode === "proposal") {
        const development = (JSON.parse(input.prompt) as { development: { caseId: string }[] }).development;
        expect(input.prompt).not.toContain('"sealed"');
        return { value: { strategy: { version: 2, context: [], planning: [], completion: ["acceptance_matrix"] }, fixes: [development[0]?.caseId], risks: [] }, tokens: 100 };
      }
      const id = input.prompt.split("\n")[0]?.replace("Case ID: ", "") ?? "";
      const scenario = scenarios.get(id);
      if (scenario === undefined) throw new Error("Unknown isolated fixture");
      const actions = input.prompt.split("Previous actions: ")[1]?.split(", ") ?? [];
      const next = scenario.requiredIds.find(ref => !actions.includes(`read:${ref}`));
      if (next !== undefined) return { value: { action: "read_evidence", evidenceId: next }, tokens: 100 };
      const candidate = input.systemPrompt.includes('"acceptance_matrix"');
      return { value: { action: "finish", decision: id.startsWith("case-") && !candidate ? "complete" : scenario.expected, evidenceIds: scenario.requiredIds }, tokens: 100 };
    });
    for (let step = 0; step < 1800 && store.revisions().length === 0; step += 1) {
      if (store.usage(now.slice(0, 10)).calls >= 150) now = new Date(Date.parse(now) + 86_400_000).toISOString();
      await subject.handle("evolution:a");
      if (store.experiments()[0]?.status === "REJECTED") break;
    }
    expect(store.revisions()).toEqual([expect.objectContaining({ scope: "WORKBENCH", status: "CANARY" })]);
    expect(store.experiments()[0]).toMatchObject({ status: "COMPLETED" });
    expect(subject.status("a").learning?.methods[0]).toMatchObject({ benefit: "quality", candidateGoals: 0 });
    expect(subject.status("a").learning?.appliedGoals).toBe(0);
    expect(call.mock.calls.every(([input]) => input.contract === "METHOD_V2")).toBe(true);
  }, 120_000);
  it.each(["quality", "efficiency"] as const)("requires measured production %s benefit before promotion", benefit => {
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 }); subject.configure("a", 150);
    store.saveRevision({ id: "global-method", scope: "GLOBAL", workbenchId: "a", profile: learningProfile(2),
      status: "CANARY", createdAt: now, updatedAt: now, state: {
        version: 2, evaluator: METHOD_EVALUATOR_VERSION, pin, policy: { version: 2, context: [], planning: [], completion: ["acceptance_matrix"] },
        parentRevisionId: null, module: "completion", benefit, baselineSuccesses: 5, candidateSuccesses: 10, evaluatedRuns: 30,
        candidateGoals: [], controlGoals: [], reason: "canary", datasetIds: [], defect: "false_completion",
      } });
    for (let i = 0; i < 60; i += 1) {
      const goalId = `exposure-${String(i)}`;
      fixture.database.transaction(db => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private','CONSUMED','a',?,?)`).run(goalId, goalId, now, now));
      subject.strategyForGoal("a", goalId, pin, { requirementsReady: true, requirementCount: 2 });
      store.upsertCases(buildLearningCases({ goalId, workbenchId: "a", requirementsRevision: 1, resultRevision: 1, observedAt: now,
        completed: true, canceled: false, verified: 2, failed: 0, unverified: 0, requirementCount: 2, coveredRequirementCount: 2,
        foreignEvidenceCount: 0, dependencyViolationCount: 0, redundantReads: 0, environmentFailed: false, executionFailed: false }));
    }
    vi.spyOn(store, "goalMetrics").mockReturnValue({ calls: 10, tokens: 1000 });
    vi.spyOn(store, "goalEvaluationEligible").mockReturnValue(true);
    vi.spyOn(store, "goalCaseMatchesCurrent").mockReturnValue(true);
    vi.spyOn(store, "currentEvaluationCases").mockImplementation(() => store.listCases());
    subject.scan();
    expect(store.revision("global-method")?.status).toBe("CANARY");
    if (benefit === "efficiency") {
      vi.spyOn(store, "goalMetrics").mockImplementation(goal => store.goalPin("a", goal)?.revisionId === "global-method"
        ? { calls: 8, tokens: 800 } : { calls: 10, tokens: 1000 });
      subject.scan();
      expect(store.revision("global-method")?.status).toBe("ACTIVE");
    }
  });
  it("does not let a late paid response overwrite an explicitly resumed checkpoint", async () => {
    seedDefect();
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 }); subject.configure("a", 150);
    let complete!: (value: { value: unknown; tokens: number }) => void;
    call.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const running = subject.handle("evolution:a");
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    subject.park("evolution:a"); subject.resumeWorkbench("a");
    const resumed = store.experiments()[0];
    complete({ value: { action: "read_evidence", evidenceId: "record-11" }, tokens: 123 });
    await running;
    expect(store.experiments()[0]?.state.protocol).toEqual(resumed?.state.protocol);
    expect(store.experiments()[0]?.state.generation).toBe(resumed?.state.generation);
    expect(store.usage(now.slice(0, 10))).toMatchObject({ calls: 1, tokens: 123, tokensComplete: true });
    expect(subject.status("a").learning?.experiment).toMatchObject({ calls: 1, tokens: 123 });
  });
  it("waits without reproposing until five independent sealed samples are available", async () => {
    seedDefect();
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 }); subject.configure("a", 150);
    call.mockResolvedValue({ value: { action: "read_evidence", evidenceId: "record-11" }, tokens: 5 });
    await subject.handle("evolution:a");
    const experiment = store.experiments()[0];
    if (experiment === undefined) throw new Error("Missing disposable experiment");
    experiment.status = "PAUSED"; experiment.phase = "VALIDATE";
    experiment.state.reason = "insufficient_samples";
    const dataset = experiment.state.dataset;
    if (!Array.isArray(dataset)) throw new Error("Missing disposable dataset");
    experiment.state.dataset = dataset.filter(c => c !== null && typeof c === "object" && !Array.isArray(c) && c.split === "development");
    experiment.state.candidate = { version: 2, context: [], planning: [], completion: ["acceptance_matrix"] };
    store.saveExperiment(experiment);
    expect(subject.pending()).toHaveLength(1);
    expect(store.experiment(experiment.id)).toMatchObject({ status: "RUNNING", phase: "EVALUATE" });
    expect(store.experiment(experiment.id)?.state.candidate).toEqual(experiment.state.candidate);
    expect(call).toHaveBeenCalledOnce();
  });
  it("accounts an in-flight archived owner's response without pausing every workbench", async () => {
    seedDefect();
    const subject = service();
    subject.configureGlobal({ enabled: true, dailyCallLimit: 150 }); subject.configure("a", 150);
    let complete!: (value: { value: unknown; tokens: number }) => void;
    call.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const running = subject.handle("evolution:a");
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    fixture.database.transaction(db => db.prepare("UPDATE workbenches SET status='ARCHIVED' WHERE workbench_id='a'").run());
    complete({ value: { action: "read_evidence", evidenceId: "record-11" }, tokens: 10 });
    await running;
    expect(store.control().paused).toBe(false);
    expect(() => subject.pending()).not.toThrow();
    expect(store.experiments()[0]?.status).toBe("REJECTED");
    expect(store.usage(now.slice(0, 10))).toMatchObject({ calls: 1, tokens: 10 });
  });
});
