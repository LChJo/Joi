import { MethodLearningService, METHOD_EVALUATOR_VERSION } from "../../src/main/application/evolution/method-learning-service";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { SqliteMethodLearningStore } from "../../src/main/infrastructure/persistence/sqlite-method-learning-store";
import { baselineMethodPolicy, composeMethodInstructions } from "../../src/main/domain/evolution/learning-policy";
import { buildLearningCases, learningProfile } from "../../src/main/domain/evolution/learning-case";
import type { EvolutionModel, EvolutionSourcePin } from "../../src/main/application/ports/evolution";
import type { JsonObject, MethodExperiment, MethodRevision } from "../../src/main/application/ports/method-learning";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("method learning public and rollout safety boundaries", () => {
  let fixture: RuntimeFixture;
  let store: SqliteMethodLearningStore;
  let legacy: SqliteEvolutionStore;
  let subject: MethodLearningService;
  let now: string;
  const pin: EvolutionSourcePin = { modelId: "model", modelRevisionId: "model-one", sourceId: "source", sourceRevisionId: "source-one" };
  const policy = { version: 2 as const, context: [], planning: [], completion: ["acceptance_matrix" as const] };
  const baseline = composeMethodInstructions(baselineMethodPolicy);
  const call = vi.fn<EvolutionModel["call"]>();
  beforeEach(async () => {
    now = "2026-10-23T01:00:00.000Z";
    fixture = await createRuntimeFixture();
    fixture.database.transaction(db => {
      for (const id of ["a", "b"]) db.prepare(`INSERT INTO workbenches
        (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES (?,?,'persona','','','',?,'ACTIVE',?,?)`).run(id,id,id,now,now);
    });
    store = new SqliteMethodLearningStore(fixture.database);
    legacy = new SqliteEvolutionStore(fixture.database);
    store.configureGlobal({ enabled: true, dailyCallLimit: 150 });
    for (const id of ["a", "b"]) store.configureParticipant(id, { enabled: true, paused: false, dailyCallLimit: 150 });
    call.mockReset();
    subject = new MethodLearningService({ store, legacyStore: legacy, model: { pin: () => Promise.resolve(pin), call },
      now: () => now, id: () => "safeguards", stepsPerHandle: 1, diagnostics: { emit: () => undefined } });
  });
  afterEach(async () => fixture.close());
  function goal(id: string, workbench = "a"): void {
    fixture.database.transaction(db => db.prepare(`INSERT INTO joi_inbox_messages
      (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
      VALUES (?,?,'fixture','CONSUMED',?,?,?)`).run(id,id,workbench,now,now));
  }
  function revision(id: string, patch: Partial<MethodRevision> = {}, statePatch: JsonObject = {}): MethodRevision {
    const value: MethodRevision = { id, workbenchId: "a", scope: "WORKBENCH", profile: learningProfile(2), status: "ACTIVE",
      createdAt: now, updatedAt: now, ...patch, state: { version: 2, evaluator: METHOD_EVALUATOR_VERSION, pin: { ...pin }, policy,
        parentRevisionId: null, module: "completion", benefit: "quality", baselineSuccesses: 5, candidateSuccesses: 10,
        evaluatedRuns: 30, candidateGoals: [], controlGoals: [], reason: "promoted", datasetIds: [], defect: "false_completion", ...statePatch } };
    store.saveRevision(value); return value;
  }
  function experiment(status: MethodExperiment["status"] = "RUNNING"): MethodExperiment {
    return { id: "in-flight", workbenchId: "a", scope: "WORKBENCH", profile: learningProfile(2), phase: "PROTOCOL", status,
      createdAt: now, updatedAt: now, state: { version: 2, evaluator: METHOD_EVALUATOR_VERSION, pin: { ...pin }, parent: { ...baselineMethodPolicy },
        parentRevisionId: null, candidate: null, dataset: [], trials: [], current: null,
        protocol: { scenarioId: "protocol", variant: "baseline", attempt: 0, calls: 0, modelCalls: 0, tokens: 0, tokensComplete: true, observations: [], actions: [] },
        sequence: 0, calls: 0, tokens: 0, invalidStreak: 0, failure: null, reason: "evaluating", benefit: null, pendingCall: null, fixes: [] } };
  }
  function bind(goalId: string, workbench = "a", source: EvolutionSourcePin | undefined = pin, requirementCount = 2) {
    return subject.strategyForGoal(workbench, goalId, source, { requirementsReady: true, requirementCount });
  }

  it("rejects invalid budgets and cannot resume disabled scopes or silently unpause with a budget edit", () => {
    for (const invalid of [-1, 0.5, Number.NaN, 10001]) {
      expect(() => subject.configure("a", invalid)).toThrow(expect.objectContaining({ code: "evolution_budget_invalid" }));
      expect(() => subject.configureGlobal({ dailyCallLimit: invalid })).toThrow(expect.objectContaining({ code: "evolution_budget_invalid" }));
    }
    subject.configureGlobal({ enabled: false });
    expect(() => subject.resumeGlobal()).toThrow(expect.objectContaining({ code: "evolution_run_now_invalid" }));
    subject.configureGlobal({ enabled: true, dailyCallLimit: 0 });
    expect(() => subject.resumeGlobal()).toThrow();
    subject.configureGlobal({ dailyCallLimit: 150 });
    subject.configure("a", 0);
    expect(() => subject.resumeWorkbench("a")).toThrow();
    expect(() => subject.requestRun("a")).toThrow();
    subject.configureParticipation("a", true);
    expect(store.participant("a")).toMatchObject({ enabled: true, dailyCallLimit: 150 });
    subject.configure("a", 50);
    subject.configureParticipation("a", false);
    subject.configureParticipation("a", true);
    expect(store.participant("a").dailyCallLimit).toBe(50);
    store.configureParticipant("a", { paused: true });
    expect(subject.configure("a", 150).paused).toBe(true);
    expect(() => subject.requestRun("a")).toThrow();
    expect(subject.resumeWorkbench("a").paused).toBe(false);
    store.configureParticipant("a", { enabled: true, dailyCallLimit: 0 });
    expect(() => subject.resumeWorkbench("a")).toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects concurrent run requests and emergency stop blocks every participating scope", () => {
    const inFlight = experiment();
    store.saveExperiment(inFlight);
    expect(() => subject.requestRun("b")).toThrow(expect.objectContaining({ code: "evolution_run_now_invalid" }));
    store.saveExperiment({ ...inFlight, status: "PAUSED" });
    expect(() => subject.requestRun("a")).toThrow();
    expect(subject.canceled("evolution:a")).toBe(false);
    subject.configureParticipation("b", false);
    expect(subject.canceled("evolution:b")).toBe(true);
    expect(subject.canceled("evolution:missing")).toBe(true);
    subject.emergencyStop();
    expect(store.control()).toMatchObject({ enabled: false, paused: true });
    expect(subject.pending()).toEqual([]);
    expect(subject.canceled("evolution:a")).toBe(true);
    expect(() => subject.park("evolution:missing")).not.toThrow();
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps legacy null bindings and unresolved requirement goals off newly active methods", () => {
    goal("old-null"); goal("not-ready"); goal("no-snapshot"); goal("modern");
    legacy.bindGoal("a", "old-null", null, pin);
    revision("active");
    expect(bind("old-null").strategyRevisionId).toBeNull();
    expect(store.goalPin("a", "old-null")).toBeNull();
    expect(subject.strategyForGoal("a", "not-ready", pin, { requirementsReady: false, requirementCount: 2 })).toEqual({ strategyRevisionId: null, instructions: baseline });
    expect(store.goalPin("a", "not-ready")).toBeNull();
    expect(subject.strategyForGoal("a", "no-snapshot", pin).strategyRevisionId).toBeNull();
    expect(store.goalPin("a", "no-snapshot")).toBeNull();
    vi.spyOn(store, "goalRequirementCount").mockReturnValue(2);
    expect(subject.strategyForGoal("a", "modern", pin).strategyRevisionId).toBe("active");
    expect(store.goalPin("a", "modern")?.revisionId).toBe("active");
  });

  it("matches method profiles and source versions while preserving immutable existing bindings", () => {
    revision("active");
    for (const id of ["different-profile", "different-source", "missing-pin", "bound", "legacy-method"]) goal(id);
    expect(bind("different-profile", "a", pin, 101)).toEqual({ strategyRevisionId: null, instructions: baseline });
    expect(bind("different-source", "a", { ...pin, sourceRevisionId: "source-two" })).toEqual({ strategyRevisionId: null, instructions: baseline });
    expect(subject.status("a").revalidationRequired).toBe(true);
    expect(subject.strategyForGoal("a", "missing-pin", undefined, { requirementsReady: true, requirementCount: 2 }).strategyRevisionId).toBeNull();
    expect(bind("bound").strategyRevisionId).toBe("active");
    expect(subject.strategyForGoal("a", "bound").instructions).toBe(composeMethodInstructions(policy));
    expect(subject.strategyForGoal("a", "bound", { ...pin, modelRevisionId: "other-model" }).instructions).toBe(baseline);
    expect(store.goalPin("a", "bound")?.revisionId).toBe("active");
    expect(fixture.database.transaction(db => db.prepare("SELECT 1 FROM method_learning_exposure_invalidations WHERE goal_id='bound'").get())).toBeDefined();
    store.pinGoal({ workbenchId: "a", goalId: "legacy-method", revisionId: "active", policy: JSON.stringify({ policy }), at: now });
    expect(bind("legacy-method").instructions).toBe(composeMethodInstructions(policy));
    expect(() => bind("bound", "b")).toThrow(expect.objectContaining({ code: "evolution_goal_invalid" }));
  });

  it("requires owned active revisions and makes local rollback idempotent", () => {
    revision("local"); revision("rejected", { status: "REJECTED" });
    expect(() => subject.rollback("b", "local")).toThrow(expect.objectContaining({ code: "evolution_goal_invalid" }));
    expect(() => subject.rollback("a", "rejected")).toThrow(expect.objectContaining({ code: "evolution_revision_stale" }));
    expect(() => subject.rollback("a", "missing")).toThrow(expect.objectContaining({ code: "evolution_revision_stale" }));
    expect(subject.rollback("a", "local").paused).toBe(true);
    expect(store.revision("local")?.status).toBe("REVERTED");
    expect(store.revision("local")?.state.reason).toBe("rolled_back");
    subject.resumeWorkbench("a");
    expect(subject.rollback("a", "local").paused).toBe(false);
    expect(store.revision("local")?.status).toBe("REVERTED");
  });

  it("restores only compatible safe parents and never resurrects a failed ancestor", () => {
    for (const [parentStatus, reason, compatible, restored] of [
      ["ACTIVE", "promoted", true, true], ["REJECTED", "promoted", true, true],
      ["REJECTED", "quality_regression", true, false], ["REVERTED", "rolled_back", true, false],
      ["REJECTED", "promoted", false, false],
    ] as const) {
      const id = `${parentStatus}-${reason}-${String(compatible)}`;
      revision(`${id}-parent`, { status: parentStatus }, { reason, pin: compatible ? { ...pin } : { ...pin, modelRevisionId: "incompatible" } });
      revision(`${id}-child`, {}, { parentRevisionId: `${id}-parent` });
      subject.rollback("a", `${id}-child`);
      expect(store.revision(`${id}-parent`)?.status).toBe(restored ? "ACTIVE" : parentStatus);
      expect(store.revision(`${id}-child`)?.status).toBe("REVERTED");
      subject.resumeWorkbench("a");
    }
    revision("orphan", {}, { parentRevisionId: "missing-parent" });
    expect(() => subject.rollback("a", "orphan")).not.toThrow();
    expect(store.revision("orphan")?.status).toBe("REVERTED");
  });

  it("applies explicit feedback to the bound method and rejects feedback for an unrelated goal", () => {
    goal("no-binding"); goal("baseline"); goal("method-goal"); goal("missing-revision"); goal("already-rejected");
    expect(() => subject.negativeFeedback("a", "no-binding")).toThrow(expect.objectContaining({ code: "evolution_goal_invalid" }));
    legacy.bindGoal("a", "baseline", null, pin);
    expect(subject.negativeFeedback("a", "baseline").paused).toBe(false);
    revision("method");
    expect(bind("method-goal").strategyRevisionId).toBe("method");
    expect(subject.negativeFeedback("a", "method-goal").paused).toBe(true);
    expect(store.revision("method")?.status).toBe("REVERTED");
    subject.resumeWorkbench("a");
    expect(subject.negativeFeedback("a", "method-goal").paused).toBe(false);
    for (const [id, revisionId] of [["missing-revision", "gone"], ["already-rejected", "rejected"]] as const) {
      store.pinGoal({ workbenchId: "a", goalId: id, revisionId, policy: JSON.stringify({ policy, pin }), at: now });
    }
    revision("rejected", { status: "REJECTED" }, { reason: "quality_regression" });
    expect(subject.negativeFeedback("a", "missing-revision").paused).toBe(false);
    expect(subject.negativeFeedback("a", "already-rejected").paused).toBe(false);
  });

  it("continues global ACTIVE monitoring across workbenches after its owner is archived", () => {
    revision("global", { scope: "GLOBAL" });
    for (const id of ["failure-one", "failure-two"]) {
      goal(id, "b");
      expect(bind(id, "b").strategyRevisionId).toBe("global");
      store.upsertCases(buildLearningCases({ goalId: id, workbenchId: "b", requirementsRevision: 1, resultRevision: 1, observedAt: now,
        completed: true, canceled: false, verified: 1, failed: 1, unverified: 0, requirementCount: 2, coveredRequirementCount: 2,
        foreignEvidenceCount: 0, dependencyViolationCount: 0, redundantReads: 0, executionFailed: false, environmentFailed: false }));
    }
    fixture.database.transaction(db => db.prepare("UPDATE workbenches SET status='ARCHIVED' WHERE workbench_id='a'").run());
    vi.spyOn(store, "currentEvaluationCases").mockImplementation(() => store.listCases());
    expect(() => subject.scan()).not.toThrow();
    expect(store.revision("global")?.status).toBe("REVERTED");
    expect(store.control().paused).toBe(true);
    expect(subject.status("b").learning?.methods[0]?.status).toBe("REVERTED");
    expect(subject.rollback("b", "global").workbenchId).toBe("b");
  });

  it("ends expired canaries without affecting active methods for other input profiles", () => {
    revision("active-large", { profile: learningProfile(101) });
    revision("expired", { scope: "GLOBAL", status: "CANARY", createdAt: "2026-09-01T01:00:00.000Z" }, { reason: "canary" });
    subject.scan();
    expect(store.revision("expired")?.status).toBe("REJECTED");
    expect(store.revision("expired")?.state.reason).toBe("insufficient_samples");
    expect(store.revision("active-large")?.status).toBe("ACTIVE");
    expect(store.control().paused).toBe(false);
  });

  it("does not include an overview projection when every workbench is archived", () => {
    fixture.database.transaction(db => db.prepare("UPDATE workbenches SET status='ARCHIVED'").run());
    expect(subject.overview()).not.toHaveProperty("learning");
    expect(subject.overview()).toMatchObject({ workbenches: 0, enabled: 0 });
  });
});
