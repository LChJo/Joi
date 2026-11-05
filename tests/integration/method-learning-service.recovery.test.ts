import { MethodLearningService, METHOD_EVALUATOR_VERSION } from "../../src/main/application/evolution/method-learning-service";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { SqliteMethodLearningStore } from "../../src/main/infrastructure/persistence/sqlite-method-learning-store";
import { baselineMethodPolicy, composeMethodInstructions } from "../../src/main/domain/evolution/learning-policy";
import { buildLearningCases, learningProfile } from "../../src/main/domain/evolution/learning-case";
import type { EvolutionModel } from "../../src/main/application/ports/evolution";
import type { MethodExperiment } from "../../src/main/application/ports/method-learning";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator";
import { SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime";
import { withGoalRequirementsTools } from "../../src/main/infrastructure/pi/joi-requirements-tools";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";

describe("method learning recovery and exposure safeguards", () => {
  let fixture: RuntimeFixture;
  let store: SqliteMethodLearningStore;
  let subject: MethodLearningService;
  const now = "2026-10-23T01:00:00.000Z";
  const pin = { modelId: "model", modelRevisionId: "m1", sourceId: "source", sourceRevisionId: "s1" };
  const policy = { version: 2 as const, context: [], planning: [], completion: ["acceptance_matrix" as const] };
  const call = vi.fn<EvolutionModel["call"]>();
  beforeEach(async () => {
    fixture = await createRuntimeFixture();
    fixture.database.transaction(db => {
      for (const id of ["a", "b"]) db.prepare(`INSERT INTO workbenches
        (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES (?,?,'persona','Careful','Local tasks','Repo',?,'ACTIVE',?,?)`).run(id, id, id, now, now);
    });
    store = new SqliteMethodLearningStore(fixture.database);
    store.configureGlobal({ enabled: true, dailyCallLimit: 150 });
    for (const id of ["a", "b"]) store.configureParticipant(id, { enabled: true, paused: false, dailyCallLimit: 150 });
    call.mockReset();
    subject = new MethodLearningService({ store, legacyStore: new SqliteEvolutionStore(fixture.database),
      model: { pin: () => Promise.resolve(pin), call }, now: () => now, id: () => "recovery", stepsPerHandle: 1 });
  });
  afterEach(async () => fixture.close());
  function goals(ids: readonly string[], workbench = "a", failed = false): void {
    fixture.database.transaction(db => {
      const insert = db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES (?,?,'private','CONSUMED',?,?,?)`);
      for (const id of ids) insert.run(id, id, workbench, now, now);
    });
    store.upsertCases(ids.flatMap(id => buildLearningCases({ goalId: id, workbenchId: workbench, requirementsRevision: 1, resultRevision: 1, observedAt: now,
      completed: true, canceled: false, verified: 2, failed: failed ? 1 : 0, unverified: 0, requirementCount: 2,
      coveredRequirementCount: 2, foreignEvidenceCount: 0, dependencyViolationCount: 0, redundantReads: 0,
      environmentFailed: false, executionFailed: false })));
  }
  function experiment(status: MethodExperiment["status"] = "RUNNING", phase: MethodExperiment["phase"] = "PROTOCOL"): MethodExperiment {
    const trial = { scenarioId: "case-test", variant: "candidate", attempt: 0, calls: 3, modelCalls: 3, tokens: 90,
      tokensComplete: true, observations: [], actions: [], success: true };
    return { id: "experiment", workbenchId: "a", scope: "WORKBENCH", profile: learningProfile(2), phase, status,
      createdAt: now, updatedAt: now, state: { version: 2, evaluator: METHOD_EVALUATOR_VERSION, pin, parent: { ...baselineMethodPolicy },
        parentRevisionId: null, candidate: phase === "EVALUATE" ? policy : null, dataset: [],
        trials: phase === "EVALUATE" ? [trial] : [], current: phase === "EVALUATE" ? trial : null,
        protocol: { scenarioId: "protocol", variant: "baseline", attempt: 0, calls: 0, modelCalls: 0, tokens: 0, tokensComplete: true, observations: [], actions: [] },
        sequence: 3, calls: 3, tokens: 90, invalidStreak: 0, failure: null, reason: "evaluating", benefit: null, pendingCall: null, fixes: [] } };
  }
  function revision(): void {
    store.saveRevision({ id: "method", workbenchId: "a", scope: "GLOBAL", profile: learningProfile(2), status: "CANARY",
      createdAt: now, updatedAt: now, state: { version: 2, evaluator: METHOD_EVALUATOR_VERSION, pin, policy,
        parentRevisionId: null, module: "completion", benefit: "quality", baselineSuccesses: 5, candidateSuccesses: 10,
        evaluatedRuns: 30, candidateGoals: [], controlGoals: [], reason: "canary", datasetIds: [], defect: "false_completion" } });
  }
  function measuredGoals(): void {
    const eligible = (id: string) => fixture.database.transaction(db => db.prepare("SELECT 1 FROM method_learning_exposure_invalidations WHERE goal_id=?").get(id)) === undefined;
    Object.assign(store, { goalEvaluationEligible: eligible, goalCaseMatchesCurrent: () => true,
      currentEvaluationCases: () => store.listCases().filter(item => eligible(item.goalId)) });
    // Canary monitoring requires at least five candidate goals and five independent controls.
    const ids = Array.from({ length: 25 }, (_, i) => `exposure-${String(i).padStart(2, "0")}`);
    goals(ids);
    for (const id of ids) subject.strategyForGoal("a", id, pin, { requirementsReady: true, requirementCount: 2 });
    expect(store.goalPins("method").length).toBeGreaterThanOrEqual(5);
    if (store.revision("method")?.status === "CANARY") {
      expect(store.goalPins().filter(item => item.revisionId === null).length).toBeGreaterThanOrEqual(5);
    }
  }
  it("refreshes held-out cases during the safety scan while scheduling is paused", () => {
    const paused = experiment("PAUSED", "EVALUATE");
    paused.state.reason = "insufficient_samples";
    store.saveExperiment(paused);
    goals(Array.from({ length: 80 }, (_, i) => `held-out-${String(i)}`));
    expect(store.listCases().filter(item => item.split === "sealed").length).toBeGreaterThanOrEqual(5);
    store.configureGlobal({ paused: true });
    subject.scan();
    expect(store.experiment("experiment")).toMatchObject({ status: "RUNNING", phase: "EVALUATE", state: { reason: "evaluating" } });
    expect(subject.pending()).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });
  it("retires archived experiments during the safety scan while scheduling is disabled", () => {
    store.saveExperiment(experiment());
    store.configureGlobal({ enabled: false });
    fixture.database.transaction(db => db.prepare("UPDATE workbenches SET status='ARCHIVED' WHERE workbench_id='a'").run());
    subject.scan();
    expect(store.experiment("experiment")).toMatchObject({ status: "REJECTED", state: { reason: "disabled" } });
    expect(call).not.toHaveBeenCalled();
  });
  it("continues a locally parked experiment through explicit local resume", () => {
    store.saveExperiment(experiment());
    subject.park("evolution:a");
    expect(store.experiment("experiment")?.status).toBe("PAUSED");
    expect(store.control().paused).toBe(false);
    subject.resumeWorkbench("a");
    expect(store.experiment("experiment")).toMatchObject({ status: "RUNNING", phase: "PROTOCOL" });
    expect(subject.pending()).toEqual([{ inputId: "evolution:a", createdAt: now }]);
  });
  it("does not carry candidate measurements into a new proposal after resume", () => {
    store.saveExperiment(experiment("PAUSED", "EVALUATE"));
    store.configureGlobal({ paused: true });
    subject.resumeGlobal();
    const resumed = store.experiment("experiment");
    expect(resumed).toMatchObject({ phase: "PROTOCOL", status: "RUNNING" });
    expect(resumed?.state.candidate).toBeNull();
    expect(resumed?.state.current).toBeNull();
    expect(resumed?.state.trials).toEqual([]);
    expect(resumed?.state.calls).toBe(3);
  });
  it("does not expose a learned method to new goals when the global cap is zero", () => {
    revision();
    store.configureGlobal({ enabled: true, dailyCallLimit: 0 });
    const ids = Array.from({ length: 25 }, (_, i) => `zero-budget-${String(i)}`);
    goals(ids);
    for (const id of ids) {
      expect(subject.strategyForGoal("a", id, pin, { requirementsReady: true, requirementCount: 2 }).strategyRevisionId).toBeNull();
    }
    expect(call).not.toHaveBeenCalled();
  });
  it("preserves archived experiment history without throwing or blocking another workbench", () => {
    store.saveExperiment(experiment());
    goals(Array.from({ length: 30 }, (_, i) => `next-${String(i)}`), "b", true);
    fixture.database.transaction(db => db.prepare("UPDATE workbenches SET status='ARCHIVED' WHERE workbench_id='a'").run());
    expect(() => subject.pending()).not.toThrow();
    expect(subject.pending()[0]?.inputId).toBe("evolution:b");
    expect(store.experiment("experiment")).not.toBeNull();
  });
  it("excludes source-incompatible outcomes from candidate monitoring", () => {
    revision();
    measuredGoals();
    vi.spyOn(store, "goalMetrics").mockReturnValue({ calls: 10, tokens: 1000 });
    subject.scan();
    expect(subject.status("a").learning?.methods[0]?.candidateGoals).toBeGreaterThanOrEqual(5);
    vi.spyOn(store, "goalSourceMatches").mockReturnValue(false);
    subject.scan();
    expect(subject.status("a").learning?.methods[0]?.candidateGoals).toBe(0);
    expect(subject.status("a").learning?.methods[0]?.controlGoals).toBe(0);
  });
  it("does not promote a known paired Token regression when another goal has unknown usage", () => {
    revision();
    measuredGoals();
    const pins = store.goalPins();
    const controls = pins.filter(p => p.revisionId === null);
    expect(pins.filter(p => p.revisionId === "method").length).toBeGreaterThanOrEqual(5);
    expect(controls.length).toBeGreaterThanOrEqual(5);
    for (const row of controls) store.upsertCases(buildLearningCases({ goalId: row.goalId, workbenchId: "a", requirementsRevision: 1,
      resultRevision: 2, observedAt: "2026-10-23T02:00:00.000Z", completed: true, canceled: false, verified: 1, failed: 1,
      unverified: 0, requirementCount: 2, coveredRequirementCount: 2, foreignEvidenceCount: 0, dependencyViolationCount: 0,
      redundantReads: 0, environmentFailed: false, executionFailed: false }));
    const unknown = controls[0]?.goalId;
    const metrics = vi.spyOn(store, "goalMetrics").mockImplementation(id => ({ calls: 10,
      tokens: id === unknown ? null : store.goalPin("a", id)?.revisionId === "method" ? 2000 : 1000 }));
    subject.scan();
    expect(subject.status("a").learning?.methods[0]?.candidateGoals).toBeGreaterThanOrEqual(5);
    expect(subject.status("a").learning?.methods[0]?.controlGoals).toBeGreaterThanOrEqual(5);
    expect(metrics).toHaveBeenCalledWith(unknown);
    expect(store.revision("method")?.status).not.toBe("ACTIVE");
  });
  it("keeps opted-out workbenches outside a canary control cohort", () => {
    revision();
    measuredGoals();
    subject.scan();
    const controls = subject.status("a").learning?.methods[0]?.controlGoals;
    expect(controls).toBeGreaterThanOrEqual(5);
    subject.configureParticipation("b", false);
    const ids = Array.from({ length: 15 }, (_, i) => `opt-out-${String(i)}`);
    goals(ids, "b");
    for (const id of ids) {
      expect(subject.strategyForGoal("b", id, pin, { requirementsReady: true, requirementCount: 2 }).strategyRevisionId).toBeNull();
      expect(JSON.parse(store.goalPin("b", id)?.policy ?? "{}") as unknown).toMatchObject({ cohortRevisionId: null });
    }
    subject.scan();
    expect(subject.status("a").learning?.methods[0]?.controlGoals).toBe(controls);
  });
  it("invalidates existing exposure after its source changes and excludes it from monitoring", () => {
    revision();
    measuredGoals();
    subject.scan();
    expect(subject.status("a").learning?.methods[0]?.candidateGoals).toBeGreaterThanOrEqual(5);
    const candidates = store.goalPins("method");
    const invalidate = vi.spyOn(store, "invalidateGoalExposure");
    for (const exposure of candidates) {
      expect(subject.strategyForGoal("a", exposure.goalId, { ...pin, modelRevisionId: "changed-model" },
        { requirementsReady: true, requirementCount: 2 }).instructions).toBe(composeMethodInstructions(baselineMethodPolicy));
      expect(invalidate).toHaveBeenCalledWith("a", exposure.goalId);
      expect(store.goalPin("a", exposure.goalId)?.revisionId).toBe("method");
    }
    subject.scan();
    expect(subject.status("a").learning?.methods[0]?.candidateGoals).toBe(0);
  });
  it("does not count repeated source groups as independent production samples", () => {
    revision();
    measuredGoals();
    subject.scan();
    expect(subject.status("a").learning?.methods[0]?.candidateGoals).toBeGreaterThanOrEqual(5);
    const cases = store.listCases().map(item => ({ ...item, groupId: "shared-source-group" }));
    vi.spyOn(store, "listCases").mockReturnValue(cases);
    vi.spyOn(store, "goalMetrics").mockReturnValue({ calls: 10, tokens: 1000 });
    subject.scan();
    const method = subject.status("a").learning?.methods[0];
    expect(method?.candidateGoals).toBeLessThanOrEqual(1);
    expect(method?.controlGoals).toBeLessThanOrEqual(1);
    expect(store.revision("method")?.status).toBe("CANARY");
  });
  it("reverts a production hard violation without waiting for a second failed goal", () => {
    revision();
    const active = store.revision("method");
    if (active === null) throw new Error("Missing fixture method.");
    store.saveRevision({ ...active, status: "ACTIVE" });
    measuredGoals();
    const exposure = store.goalPins("method")[0];
    if (exposure === undefined) throw new Error("Missing candidate exposure.");
    store.upsertCases(buildLearningCases({ goalId: exposure.goalId, workbenchId: "a", requirementsRevision: 1,
      resultRevision: 2, observedAt: "2026-10-23T02:00:00.000Z", completed: true, canceled: false, verified: 2,
      failed: 0, unverified: 0, requirementCount: 2, coveredRequirementCount: 2, foreignEvidenceCount: 1,
      dependencyViolationCount: 0, redundantReads: 0, environmentFailed: false, executionFailed: false }));
    subject.scan();
    expect(store.revision("method")?.status).toBe("REVERTED");
    expect(store.control().paused).toBe(true);
  });
  it("waits for normalized requirements before pinning and refreshes the method inside the same Turn", async () => {
    revision();
    const active = store.revision("method");
    if (active === null) throw new Error("Missing fixture method.");
    store.saveRevision({ ...active, status: "ACTIVE" });
    const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
    const rule = "Only read local inputs.";
    await inbox.create({ inputId: "normalized", idempotencyKey: "normalized", body: rule, status: "PENDING", workbenchId: "a",
      createdAt: now, updatedAt: now });
    const requirements = new SqliteGoalRequirementsRepository(fixture.database);
    const pinGoal = vi.spyOn(store, "pinGoal");
    const strategy = vi.spyOn(subject, "strategyForGoal");
    const requests: string[] = [];
    const faux = fauxProvider({ provider: "method-normalization-refresh" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("goal_read_inputs", { sourceRevision: 1, offset: 0 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("goal_update_requirements", { expectedRevision: 0, processedSourceRevision: 1, retirements: [],
        upserts: [{ id: "read-only", kind: "CONSTRAINT", scope: "GLOBAL", mandatory: true, text: rule, source: { sourceRevision: 1, quote: rule } }] })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("turn_complete", { outcome: "DIRECT_ANSWER", requirementsRevision: 1 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("Requirements established.")]),
    ].map((response, index) => context => {
      requests.push(JSON.stringify(context.messages));
      if (index < 2) expect(store.goalPin("a", "normalized")).toBeNull();
      return response;
    }));
    const models = createModels(); models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({ model: { ...faux.getModel(), contextWindow: 200000 }, models, thinkingLevel: "off",
      sessionStore: { load: () => Promise.resolve(null), save: () => Promise.resolve() },
      tools: turn => withGoalRequirementsTools([{ name: "turn_complete", label: "Complete", description: "Complete", parameters: Type.Object({ outcome: Type.String() }),
        execute: () => Promise.resolve({ content: [{ type: "text", text: JSON.stringify({ outcome: "DIRECT_ANSWER", status: "COMMITTED" }) }], details: {} }) }], {
        requirements, goalInputId: "normalized", workbenchId: "a", turnId: turn.turnId,
        work: { listForGoal: () => Promise.resolve([]), readBrief: () => Promise.resolve(null), refreshBrief: () => Promise.resolve() },
      }),
    });
    const coordinator = new JoiCoordinator({ requirements, evolution: subject, clock: fixture.clock, ids: fixture.ids, runtime, workbenches: fixture.workbenches,
      sources: { selectInitial: turnId => Promise.resolve({ turnId, sourceRevisionId: pin.sourceRevisionId,
        modelRevisionId: pin.modelRevisionId, sourceId: pin.sourceId, modelId: pin.modelId }) },
      router: { decide: () => Promise.reject(new Error("Goal already bound.")) },
      store: { loadInput: id => inbox.loadInput(id),
        createTurn: input => inbox.createTurn({ inputId: input.inputId, turnId: input.turnId, sessionId: input.sessionId,
          workbenchId: input.workbenchId, createdAt: input.createdAt }),
        completeInput: (id, turnId, completion) => inbox.completeInput(id, turnId, completion),
        requireClarification: (id, reason, prompt) => inbox.requireClarification(id, reason, prompt),
        failTurn: (id, turnId) => inbox.failTurn(id, turnId),
      },
    });
    await coordinator.handle("normalized");
    expect(strategy).toHaveBeenCalledWith("a", "normalized", expect.objectContaining(pin), { requirementsReady: false, requirementCount: 0 });
    expect(strategy).toHaveBeenCalledWith("a", "normalized", expect.objectContaining(pin), { requirementsReady: true, requirementCount: 1 });
    expect(pinGoal).toHaveBeenCalledTimes(1);
    expect(store.goalPin("a", "normalized")?.revisionId).toBe("method");
    const invalidate = vi.spyOn(store, "invalidateGoalExposure");
    const reordered = { turnId: "another-turn", modelRevisionId: pin.modelRevisionId, sourceId: pin.sourceId,
      modelId: pin.modelId, sourceRevisionId: pin.sourceRevisionId };
    expect(subject.strategyForGoal("a", "normalized", reordered, { requirementsReady: true, requirementCount: 1 }).instructions).toBe(composeMethodInstructions(policy));
    expect(invalidate).not.toHaveBeenCalled();
    expect(requests[2]).toContain("Runtime method");
    expect(requests[2]).toContain(JSON.stringify(composeMethodInstructions(policy)).slice(1, -1));
    expect((await requirements.load("normalized", "a"))?.status).toBe("READY");
    const turns = fixture.database.transaction(db => db.prepare("SELECT turn_id FROM joi_turns WHERE input_id='normalized'").all());
    expect(turns).toHaveLength(1);
  });
});
