import { EvolutionService } from "../../src/main/application/evolution/evolution-service";
import { DomainError } from "../../src/main/domain/errors";
import type { RuntimeDiagnosticEventMap, RuntimeDiagnostics } from "../../src/main/application/ports/runtime-diagnostics";
import { EVOLUTION_EVIDENCE_THRESHOLD, EVOLUTION_FAILURE_THRESHOLD } from "../../src/shared/evolution";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";
import { evolutionScenarios, EVOLUTION_EVALUATOR_VERSION } from "../../src/main/domain/evolution/scenarios";
import { baselineStrategy } from "../../src/main/domain/evolution/strategy";
import { deriveEvolutionExperience } from "../../src/main/domain/evolution/experience";
import { DEFAULT_EVOLUTION_DAILY_CALL_LIMIT } from "../../src/shared/evolution";
import { PiEvolutionModel } from "../../src/main/infrastructure/pi/pi-evolution-model";
import type { EvolutionBatch, EvolutionModel, EvolutionRevision } from "../../src/main/application/ports/evolution";

const pin = { modelId: "m", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" };
describe("evolution execution and budget", () => {
  let fixture: RuntimeFixture;
  let store: SqliteEvolutionStore;
  let service: EvolutionService;
  let day: string;
  const call = vi.fn();
  beforeEach(async () => {
    fixture = await createRuntimeFixture();
    store = new SqliteEvolutionStore(fixture.database);
    day = "2026-09-22T01:00:00.000Z";
    call.mockReset().mockResolvedValue({ action: "read_evidence", evidenceId: "record-11" });
    // One step per handle for the legacy single-step semantics; multi-step advancing has its own tests.
    service = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => day, id: () => "batch-1", stepsPerHandle: 1 });
    fixture.database.transaction((db) => {
      db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('a','A','p','','','','mem','ACTIVE',?,?)`).run(day, day);
      for (let i = 0; i < 10; i++) db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private','CONSUMED','a',?,?)`).run(`g${String(i)}`, `g${String(i)}`, day, day);
    });
    for (let i = 0; i < 10; i++) store.recordEvidence({ workbenchId: "a", goalId: `g${String(i)}`, revisionId: null, outcome: i < 3 ? "VERIFICATION_FAILED" : "VERIFIED", observedAt: day });
  });
  afterEach(async () => { await fixture.close(); });
  it("starts off, spends nothing until explicitly enabled, and validates budgets", async () => {
    expect(service.status("a").dailyCallLimit).toBe(DEFAULT_EVOLUTION_DAILY_CALL_LIMIT);
    expect(service.status("a").reason).toBe("disabled");
    expect(() => service.configure("a", -1)).toThrow();
    expect(() => service.configure("a", 1.1)).toThrow();
    expect(service.configure("a", 0).dailyCallLimit).toBe(0);
    expect(service.status("a").reason).toBe("disabled");
    expect(service.pending()).toEqual([]);
    await service.handle("evolution:a");
    expect(call).not.toHaveBeenCalled();
    expect(service.configure("a", 2).dailyCallLimit).toBe(2);
  });
  it("performs one call per slot, reserves budget, and resumes on the next day", async () => {
    service.configure("a", 1);
    expect(service.pending()).toHaveLength(1);
    await service.handle("evolution:a");
    expect(call).toHaveBeenCalledTimes(1);
    expect(service.status("a").callsUsedToday).toBe(1);
    expect(service.pending()).toEqual([]);
    day = "2026-09-23T01:00:00.000Z";
    await service.handle("evolution:a");
    expect(call).toHaveBeenCalledTimes(2);
    expect(store.read("a").batch?.rollouts[0]?.calls).toBe(2);
    expect(JSON.stringify(service.status("a"))).not.toContain("record-11");
  });
  it("gives user tasks priority and does not refund failed calls", async () => {
    service.configure("a", 2);
    fixture.database.transaction((db) => db.prepare("UPDATE joi_inbox_messages SET status = 'PENDING' WHERE input_id = 'g0'").run());
    expect(service.pending()).toEqual([]);
    await service.handle("evolution:a");
    expect(call).not.toHaveBeenCalled();
    fixture.database.transaction((db) => db.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = 'g0'").run());
    call.mockRejectedValue(new Error("private provider error"));
    await service.handle("evolution:a");
    expect(service.status("a").callsUsedToday).toBe(1);
    expect(JSON.stringify(service.status("a"))).not.toContain("provider");
  });
  function revision(revisionId = "r1"): EvolutionRevision {
    return { revisionId, parentRevisionId: null, evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, monitoredGoals: [], strategy: { ...baselineStrategy, completion: "evidence_matrix" }, pin, evidenceIds: [], prediction: { fixes: [], risks: [] }, module: "completion", status: "ACTIVE", createdAt: day, reason: "promoted", baselineSuccesses: 80, candidateSuccesses: 90, evaluatedRuns: 180 };
  }
  function batch(): EvolutionBatch {
    return { id: "b", evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, parentStrategy: baselineStrategy, parentRevisionId: null, strategy: baselineStrategy, pin, phase: "DEVELOP", evidenceIds: ["g0","g1","g2"], rollouts: [] };
  }
  function responseService(response: unknown, diagnostics?: RuntimeDiagnostics) {
    const completeSimple = vi.fn().mockResolvedValue(response);
    const model = new PiEvolutionModel({ resolver: { resolve: vi.fn().mockResolvedValue({ model: { api: "anthropic-messages" }, models: { completeSimple }, thinkingLevel: "off" }) },
      sources: { selectInitial: vi.fn().mockResolvedValue(pin) } });
    return { runner: new EvolutionService({ store, model, now: () => day, id: () => "batch-1", stepsPerHandle: 1,
      ...(diagnostics === undefined ? {} : { diagnostics }) }), completeSimple };
  }
  it("charges invalid responses to the failed batch and exposes only numeric failure metadata", async () => {
    service.configure("a", 10);
    const emit = vi.fn();
    const { runner } = responseService({ content: [], stopReason: "stop", usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 } }, { emit });
    await runner.handle("evolution:a");
    await runner.handle("evolution:a");
    expect(runner.status("a")).toMatchObject({ paused: false, reason: "model_response_invalid",
      failure: { kind: "no_tool_call", stopReason: "stop", toolCallCount: 0 },
      batchHistory: [{ tokens: 200, calls: 2, failure: { kind: "no_tool_call" } }] });
    expect(runner.overview().batches[0]).toMatchObject({ tokens: 200 });
    expect(emit).toHaveBeenCalledWith("joi.evolution.response_invalid", expect.objectContaining({ ...pin,
      failure: { kind: "no_tool_call", stopReason: "stop", toolCallCount: 0 } }));
  });
  it("keeps unknown failure consumption unknown even when the following call returns tokens", async () => {
    service.configure("a", 10);
    const { runner, completeSimple } = responseService({ content: [], stopReason: "stop" });
    await runner.handle("evolution:a");
    completeSimple.mockResolvedValue({ content: [], stopReason: "stop", usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 } });
    await runner.handle("evolution:a");
    expect(runner.status("a").batchHistory?.[0]?.tokens).toBeNull();
  });
  it("reads evidence sequentially, clears recovered failures and includes retry tokens in the rollout", async () => {
    service.configure("a", 10);
    const usage = { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 };
    const { runner, completeSimple } = responseService({ content: [], stopReason: "stop", usage });
    await runner.handle("evolution:a");
    for (const evidenceId of ["record-11", "record-13"]) {
      completeSimple.mockResolvedValue({ content: [{ type: "toolCall", name: "read_evidence", arguments: { evidenceId } }], stopReason: "toolUse", usage });
      await runner.handle("evolution:a");
    }
    completeSimple.mockResolvedValue({ content: [{ type: "toolCall", name: "finish", arguments: { decision: "complete", evidenceIds: ["record-11", "record-13"] } }], stopReason: "toolUse", usage });
    await runner.handle("evolution:a");
    expect(store.read("a").batch?.rollouts[0]).toMatchObject({ success: true, tokens: 400, tokensComplete: true, modelCalls: 4 });
    expect(runner.status("a").failure).toBeUndefined();
    expect(runner.status("a").currentBatch).toMatchObject({ tokens: 400, calls: 4 });
    expect(runner.status("a").currentBatch?.failure).toBeUndefined();
  });
  it("keeps a returned call charged when source pin verification fails", async () => {
    service.configure("a", 10);
    let selections = 0;
    const runner = new EvolutionService({ store, model: {
      pin: () => ++selections === 1 ? Promise.resolve(pin) : Promise.reject(new Error("private pin failure")),
      call: () => Promise.resolve({ value: { action: "read_evidence", evidenceId: "record-11" }, tokens: 100 }),
    }, now: () => day, id: () => "batch-1", stepsPerHandle: 1 });
    await runner.handle("evolution:a");
    expect(runner.status("a").currentBatch).toMatchObject({ reason: "call_failed", tokens: 100, calls: 1 });
  });
  it("records late provider consumption against a finished batch without changing its verdict", async () => {
    service.configure("a", 10);
    let settle: ((value: unknown) => void) | undefined;
    call.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const handling = service.handle("evolution:a");
    await vi.waitFor(() => expect(settle).toBeDefined());
    store.update("a", (state) => {
      assert(state.batch);
      state.batchHistory = [{ batchId: state.batch.id, workbenchId: "a", scope: "GLOBAL", phase: "DEVELOP",
        startedAt: day, finishedAt: day, reason: "rolled_back", calls: 1, tokens: 0, revisionId: null }];
      state.batch = null; state.paused = true; state.reason = "rolled_back";
    });
    assert(settle);
    settle({ value: { action: "read_evidence", evidenceId: "record-11" }, tokens: 100 });
    await handling;
    expect(service.status("a")).toMatchObject({ paused: true, reason: "rolled_back", batchHistory: [{ tokens: 100, reason: "rolled_back" }] });
    expect(store.read("a").batch).toBeNull();
  });
  it.each(["error", "aborted"])("routes SDK %s away from format retries while retaining usage", async (stopReason) => {
    service.configure("a", 10);
    const { runner } = responseService({ content: [], stopReason, errorMessage: "private provider body", usage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0 } });
    await runner.handle("evolution:a");
    const state = store.read("a");
    expect(state.batch).not.toBeNull();
    expect(state.batch?.tokens).toBe(100);
    expect(state.responseInvalidStreak).toBe(0);
    expect(state.reason).toBe("call_failed");
    expect(state.callFailures ?? 0).toBe(stopReason === "error" ? 1 : 0);
    expect(state.parkedDay ?? null).toBe(stopReason === "error" ? day.slice(0, 10) : null);
    expect(JSON.stringify(runner.status("a"))).not.toContain("private");
  });
  it("projects legacy failed zero consumption as unknown without rewriting history", () => {
    const record = { batchId: "legacy", workbenchId: "a", scope: "GLOBAL" as const, phase: "DEVELOP" as const,
      startedAt: day, finishedAt: day, reason: "model_response_invalid" as const, calls: 2, tokens: 0, revisionId: null };
    store.update("a", (state) => { state.batchHistory = [record]; });
    expect(service.status("a").batchHistory?.[0]?.tokens).toBeNull();
    expect(service.overview().batches[0]?.tokens).toBeNull();
    expect(store.read("a").batchHistory?.[0]?.tokens).toBe(0);
  });
  it.each(["joi-orchestration-v1", "joi-orchestration-v2"])("requires revalidation of strategies scored under %s", evaluatorVersion => {
    store.update("a", (state) => { state.revisions = [{ ...revision(), evaluatorVersion }]; state.activeRevisionId = "r1"; });
    expect(service.strategyForGoal("a", "g0", pin).strategyRevisionId).toBeNull();
    expect(service.status("a")).toMatchObject({ revalidationRequired: true, activeEffective: false });
  });
  it("proposes from relevant pinned comparison lessons and excludes raw successful history", async () => {
    service.configure("a", 10);
    const scenarioIds = evolutionScenarios("development").slice(0, 3).map(scenario => scenario.id);
    const experience = deriveEvolutionExperience({ id: "relevant", batchId: "prior", revisionId: "prior-revision", createdAt: day,
      sourcePin: JSON.stringify(pin), evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, parentStrategy: baselineStrategy,
      strategy: { ...baselineStrategy, completion: "evidence_matrix" }, comparisons: scenarioIds.map(scenarioId => ({ scenarioId,
        baseline: [false, true, true], candidate: [true, true, true], baselineCalls: 9, candidateCalls: 9, violations: 0 })) });
    assert(experience);
    store.update("a", state => {
      state.batch = { ...batch(), phase: "PROPOSE", rollouts: scenarioIds.map(scenarioId => ({ scenarioId, variant: "baseline", attempt: 0, calls: 3,
        success: false, observations: [], actions: [] })) };
      state.developmentHistory = [{ scenarioId: scenarioIds[0] ?? "", variant: "baseline", attempt: 0, calls: 3, success: true, actions: [], observations: ["OLD_SUCCESS_SHOULD_NOT_BE_USED"] }];
      state.experiences = [experience, { ...experience, id: "foreign-pin", conditions: { ...experience.conditions, sourcePin: "different" } },
        { ...experience, id: "unrelated", conditions: { ...experience.conditions, scenarioIds: ["development:unrelated"] } }];
    });
    call.mockImplementation((input: Parameters<EvolutionModel["call"]>[0]) => {
      const prompt = JSON.parse(input.prompt) as { experiences: { id: string }[]; historicalSuccesses?: unknown };
      expect(prompt.experiences.map(entry => entry.id)).toEqual(["relevant"]);
      expect(prompt.historicalSuccesses).toBeUndefined();
      expect(input.prompt).not.toContain("OLD_SUCCESS_SHOULD_NOT_BE_USED");
      expect(input.prompt).not.toContain("sealed:");
      return Promise.resolve({ strategy: { ...baselineStrategy, completion: "evidence_matrix" }, fixes: scenarioIds, risks: [] });
    });
    await service.handle("evolution:a");
    expect(store.read("a").batch?.phase).toBe("VALIDATE");
  });
  // The full evaluation commits durable checkpoints for 180 paired trials.
  it("runs contrastive development, sealed paired trials, promotion, goal pinning and rollback end to end", async () => {
    service.configure("a", 1000);
    const development = evolutionScenarios("development");
    const sealed = evolutionScenarios("sealed");
    call.mockImplementation((input: Parameters<EvolutionModel["call"]>[0]) => {
      const current = store.read("a").batch;
      assert(current);
      if (current.phase === "PROPOSE") {
        expect(input.prompt).not.toContain("sealed:");
        return Promise.resolve({ value: { strategy: { ...baselineStrategy, completion: "evidence_matrix" }, fixes: development.slice(0,3).map((s) => s.id), risks: [] }, tokens: 100 });
      }
      const run = current.rollouts.at(-1);
      assert(run);
      const scenario = [...development, ...sealed].find((s) => s.id === run.scenarioId);
      assert(scenario);
      if (run.calls < 2) return Promise.resolve({ value: { action: "read_evidence", evidenceId: scenario.requiredIds[run.calls] }, tokens: 100 });
      const fail = current.phase === "DEVELOP" ? development.indexOf(scenario) < 3 : current.phase === "EVALUATE" && run.variant === "baseline" && run.attempt === 0 && sealed.indexOf(scenario) < 5;
      return Promise.resolve({ value: { action: "finish", decision: fail ? scenario.expected === "complete" ? "wait" : "complete" : scenario.expected, evidenceIds: scenario.requiredIds }, tokens: 100 });
    });
    const original = service.strategyForGoal("a", "g0", pin);
    expect(original.strategyRevisionId).toBeNull();
    for (let i = 0; i < 1000 && service.status("a").activeRevisionId === null; i++) {
      await service.handle("evolution:a");
      if (i > 0 && store.read("a").batch === null) break;
    }
    const canary = service.status("a");
    expect(canary.reason).toBe("canary");
    expect(canary.versions[0]).toMatchObject({ status: "CANARY", scope: "GLOBAL", baselineSuccesses: 85, candidateSuccesses: 90, evaluatedRuns: 180 });
    expect(canary.lastVerdict).toMatchObject({ reason: "canary", baselineSuccesses: 85, candidateSuccesses: 90, evaluatedRuns: 180 });
    expect(store.read("a").revisions[0]?.evaluation).toHaveLength(30);
    const experience = new SqliteEvolutionStore(fixture.database).read("a").experiences?.[0];
    expect(experience).toMatchObject({ evidenceScope: "development", outcome: "benefit", change: { module: "completion", from: "baseline", to: "evidence_matrix" }, benefit: { additionalSuccesses: 9, modelCallDelta: 0, tokenDelta: 0 } });
    expect(experience?.comparisons).toHaveLength(10);
    expect(JSON.stringify(experience)).not.toContain("sealed:");
    expect(Object.values(store.read("a").sealedBaselineCache ?? {})[0]).toHaveLength(90);
    expect(canary.batchHistory?.[0]).toMatchObject({ tokens: 72_100 });
    expect(service.strategyForGoal("a", "g0", pin)).toEqual(original);
    day = "2026-09-23T01:00:00.000Z";
    let candidateGoal = "";
    let candidateCount = 0;
    let controlCount = 0;
    for (let index = 0; index < 100 && (candidateCount < 5 || controlCount < 5); index += 1) {
      const goalId = `canary-${String(index)}`;
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private','CONSUMED','a',?,?)`).run(goalId, goalId, day, day));
      const selected = service.strategyForGoal("a", goalId, pin);
      if (selected.strategyRevisionId === canary.canaryRevisionId) { candidateCount += 1; candidateGoal ||= goalId; }
      else controlCount += 1;
      store.recordEvidence({ workbenchId: "a", goalId, revisionId: selected.strategyRevisionId, outcome: "VERIFIED", cause: "none", observedAt: day });
    }
    service.scan();
    const promoted = service.status("a");
    expect(promoted.globalRevisionId).toBe(canary.canaryRevisionId);
    expect(promoted.versions[0]).toMatchObject({ status: "ACTIVE", reason: "promoted" });
    expect(service.strategyForGoal("a", "g2", { ...pin, modelRevisionId: "new" }).strategyRevisionId).toBeNull();
    expect(service.status("a")).toMatchObject({ revalidationRequired: true, activeEffective: false, reason: "revalidation_required" });
    expect(service.negativeFeedback("a", candidateGoal)).toMatchObject({ globalRevisionId: null, reason: "rolled_back" });
    expect(service.pending()).toEqual([]);
  }, process.env.CI ? 180_000 : 60_000);
  it("resumes completed trials after a crash without refunding or reusing the abandoned call", async () => {
    service.configure("a", 3);
    await service.handle("evolution:a");
    store.update("a", (s) => { assert(s.call); s.call.state = "RUNNING"; });
    const previous = store.read("a").call?.id;
    service.scan(); // Already owned by this instance: no concurrent recovery.
    const restored = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => day, id: () => "b2", stepsPerHandle: 1 });
    restored.scan();
    expect(store.read("a").batch?.rollouts).toEqual([]);
    await restored.handle("evolution:a");
    expect(store.read("a").call?.id).not.toBe(previous);
    expect(restored.status("a").callsUsedToday).toBe(2);
    expect(store.read("a").batch?.rollouts[0]).toMatchObject({ modelCalls: 2, calls: 1, tokensComplete: false });
  });
  it("keeps completed trials after a transient failure and abandons the batch only after repeated failures", async () => {
    service.configure("a", 10);
    await service.handle("evolution:a"); // one successful read; the rollout stays open
    call.mockRejectedValueOnce(new Error("private transient"));
    await service.handle("evolution:a");
    const failed = store.read("a");
    expect(failed.batch).not.toBeNull(); // the multi-day batch survives a transient error
    expect(failed.batch?.rollouts).toEqual([]); // only the interrupted attempt is dropped
    expect(failed.call?.state).toBe("DONE");
    expect(failed.reason).toBe("call_failed");
    expect(service.status("a").callsUsedToday).toBe(2); // the reserved call is not refunded
    expect(service.pending()).toEqual([]); // parked for the day
    day = "2026-09-23T01:00:00.000Z";
    expect(service.pending()).toHaveLength(1); // resumes the next day
    call.mockRejectedValue(new Error("private again"));
    await service.handle("evolution:a");
    expect(store.read("a").batch).not.toBeNull();
    day = "2026-09-24T01:00:00.000Z";
    await service.handle("evolution:a");
    expect(store.read("a").batch).toBeNull(); // abandoned after three consecutive failures
    expect(store.read("a").callFailures).toBe(3);
    expect(store.read("a").lastBatchFinishedAt).toBeUndefined(); // infrastructure aborts keep the trigger
    expect(service.status("a").reason).toBe("call_failed");
  });
  it("retries an invalid model response without parking and abandons the batch on the second", async () => {
    service.configure("a", 10);
    call.mockRejectedValue(new DomainError("evolution_response_invalid", "bad shape"));
    await service.handle("evolution:a");
    await service.handle("evolution:a");
    const failed = store.read("a");
    expect(failed.batch).toBeNull();
    expect(failed.reason).toBe("model_response_invalid");
    expect(failed.parkedDay).toBeUndefined(); // a bad response is a model-quality signal, not a fault: no day is lost
    expect(failed.callFailures).toBeUndefined(); // and the infrastructure retry budget is untouched
    expect(failed.responseInvalidStreak).toBe(2);
    expect(failed.lastBatchFinishedAt).toBe(day); // consumes the trigger, so a broken source cannot re-pay daily
    expect(service.pending()).toEqual([]);
  });
  it("trips the global breaker after repeated invalid responses and recovers via configure", async () => {
    const events: string[] = [];
    const breaker = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => day, id: () => "bk", stepsPerHandle: 5,
      diagnostics: { emit: (name) => { events.push(name); } } });
    call.mockRejectedValue(new DomainError("evolution_response_invalid", "bad shape"));
    service.configure("a", 100);
    for (let cycle = 0; cycle < 5; cycle++) {
      breaker.requestRun("a");
      await breaker.handle("evolution:a");
    }
    const state = store.read("a");
    expect(state.paused).toBe(true);
    expect(state.reason).toBe("model_response_invalid");
    expect(state.batch).toBeNull();
    expect(events).toContain("joi.evolution.breaker_tripped");
    expect(() => breaker.requestRun("a")).toThrow(); // re-enable first; run-now is not a pause bypass
    expect(breaker.configure("a", 50).reason).toBe("collecting");
  });
  it("lets a failed global batch consume its shared trigger without stamping unrelated local state", async () => {
    service.configure("a", 100);
    fixture.database.transaction((db) => {
      db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('b','B','pb','','','','pb','ACTIVE',?,?)`).run(day, day);
      for (let i = 0; i < 11; i++) db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private','CONSUMED','b',?,?)`).run(`bg${String(i)}`, `bg${String(i)}`, day, day);
    });
    for (let i = 0; i < 11; i++) store.recordEvidence({ workbenchId: "b", goalId: `bg${String(i)}`, revisionId: null, outcome: i < 4 ? "VERIFICATION_FAILED" : "VERIFIED", observedAt: day });
    call.mockRejectedValue(new DomainError("evolution_response_invalid", "bad shape"));
    const breaker = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => day, id: () => "bk2", stepsPerHandle: 5 });
    for (let cycle = 0; cycle < 5; cycle++) {
      breaker.requestRun("a");
      await breaker.handle("evolution:a");
    }
    const stopped = store.read("b");
    expect(stopped.paused).toBe(true);
    expect(stopped.reason).toBe("model_response_invalid"); // the panel still explains why it stopped
    expect(stopped.lastBatchFinishedAt).toBeUndefined(); // but no verdict consumed its trigger window
    expect(breaker.configure("b", 50).reason).toBe("collecting");
    // A global verdict consumes the shared trigger independently of each workbench's local stamp;
    // re-enabling another owner must not replay the same evidence.
    const resumed = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => "2026-09-23T01:00:00.000Z", id: () => "res", stepsPerHandle: 1 });
    expect(resumed.pending()).toEqual([]);
  });
  it("lets the day's first candidate lock out every other workbench, run-now aside", async () => {
    service.configure("a", 10);
    fixture.database.transaction((db) => {
      db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('b','B','pb','','','','pb','ACTIVE',?,?)`).run(day, day);
      for (let i = 0; i < 11; i++) db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private','CONSUMED','b',?,?)`).run(`bg${String(i)}`, `bg${String(i)}`, day, day);
    });
    for (let i = 0; i < 11; i++) store.recordEvidence({ workbenchId: "b", goalId: `bg${String(i)}`, revisionId: null, outcome: i < 4 ? "VERIFICATION_FAILED" : "VERIFIED", observedAt: day });
    // b holds the stronger local signal, but an explicit run-now on a wins the pick.
    service.requestRun("a");
    expect(service.pending().map((entry) => entry.inputId)).toEqual(["evolution:a"]);
    await service.handle("evolution:a");
    // The day's candidate slot is spent globally: b never gets one, and a's live batch continues.
    expect(store.lastCandidateDay()).toBe("2026-09-22");
    expect(service.pending().map((entry) => entry.inputId)).toEqual(["evolution:a"]);
    expect(store.read("b").batch).toBeNull();
  });
  it("starts a batch on request without waiting for the evidence gate", async () => {
    fixture.database.transaction((db) => db.prepare("DELETE FROM evolution_evidence").run());
    service.configure("a", 10);
    expect(service.pending()).toEqual([]);
    service.requestRun("a");
    expect(service.pending()).toHaveLength(1);
    await service.handle("evolution:a");
    expect(call).toHaveBeenCalledTimes(1);
    expect(store.read("a").runRequestedAt).toBeNull(); // consumed by the batch it started
    // An expired request is a dead letter, not a permanent bypass.
    store.update("a", (s) => { s.batch = null; s.runRequestedAt = "2026-09-21T00:00:00.000Z"; });
    expect(service.pending()).toEqual([]);
    // Paused or disabled workbenches refuse the request outright instead of silently queueing.
    expect(() => { service.configure("a", 0); service.requestRun("a"); }).toThrow();
  });
  it("refuses a run-now request while a batch is in flight instead of buying a second one", async () => {
    service.configure("a", 10);
    await service.handle("evolution:a"); // opens a batch and issues its first call
    expect(store.read("a").batch).not.toBeNull();
    expect(() => service.requestRun("a")).toThrow(expect.objectContaining({ code: "evolution_run_now_invalid" }));
    expect(store.read("a").runRequestedAt).toBeNull(); // the refused request leaves nothing queued
    // The in-flight batch already spent the day's candidate slot: had the request been queued it
    // would outlive the verdict and open a second batch, so once the batch closes nothing restarts.
    store.update("a", (s) => { s.batch = null; s.lastBatchFinishedAt = day; });
    expect(service.pending()).toEqual([]);
    await service.handle("evolution:a");
    expect(store.read("a").batch).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("treats a cancelled handle as crash recovery, not as an infrastructure failure", async () => {
    service.configure("a", 10);
    await service.handle("evolution:a"); // one successful read; the rollout stays open
    call.mockRejectedValue(Object.assign(new Error("canceled"), { name: "AbortError" }));
    await service.handle("evolution:a");
    const state = store.read("a");
    expect(state.batch).not.toBeNull();
    expect(state.batch?.rollouts).toEqual([]); // only the interrupted attempt is dropped
    expect(state.parkedDay).toBeUndefined(); // a cancellation must not cost the day's candidate
    expect(state.callFailures).toBe(0); // nor feed the infrastructure retry budget
    expect(service.pending()).toHaveLength(1); // still allowed to continue today
  });
  it("advances several calls per handle while the slot stays idle", async () => {
    const multi = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => day, id: () => "multi", stepsPerHandle: 5 });
    multi.configure("a", 100);
    await multi.handle("evolution:a");
    expect(call).toHaveBeenCalledTimes(5);
    expect(multi.status("a").callsUsedToday).toBe(5);
    expect(store.read("a").batch).not.toBeNull();
  });
  it("freezes merit rejections but lets infrastructure failures retry the same strategy once", async () => {
    service.configure("a", 100);
    const development = evolutionScenarios("development");
    const failedRuns = development.slice(0, 3).map((s, index) => ({ scenarioId: s.id, variant: "baseline" as const, attempt: index, calls: 3, observations: [], actions: [], success: false }));
    const rejected = (reason: EvolutionRevision["reason"], revisionId: string): EvolutionRevision => ({ revisionId, parentRevisionId: null, evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, monitoredGoals: [], strategy: { ...baselineStrategy, completion: "evidence_matrix" }, pin, evidenceIds: [], prediction: { fixes: [], risks: [] }, module: "completion", status: "REJECTED", createdAt: day, reason, baselineSuccesses: 0, candidateSuccesses: 0, evaluatedRuns: 0 });
    const propose = async (revisions: EvolutionRevision[]) => {
      store.update("a", (s) => { s.revisions = revisions; s.batch = { ...batch(), phase: "PROPOSE", rollouts: failedRuns }; });
      call.mockResolvedValue({ strategy: { ...baselineStrategy, completion: "evidence_matrix" }, fixes: development.slice(0, 3).map((s) => s.id), risks: [] });
      await service.handle("evolution:a");
    };
    await propose([rejected("call_failed", "r-infra")]);
    expect(store.read("a").batch?.phase).toBe("VALIDATE");
    expect(store.read("a").revisions).toHaveLength(2);
    await propose([rejected("hard_violation", "r-frozen")]);
    expect(service.status("a").reason).toBe("invalid_candidate");
    await propose([rejected("cost_regression", "r-cost")]);
    expect(service.status("a").reason).toBe("invalid_candidate");
    await propose([rejected("call_failed", "r-1"), rejected("call_failed", "r-2")]);
    expect(service.status("a").reason).toBe("invalid_candidate"); // attempts exhausted
    await propose([rejected("quality_regression", "r-noise")]);
    expect(store.read("a").batch?.phase).toBe("VALIDATE"); // noise-sensitive verdicts get one retry
  });
  it("starts a new batch only for evidence observed after the previous verdict", () => {
    service.configure("a", 100);
    expect(service.pending()).toHaveLength(1);
    store.update("a", (s) => { s.lastBatchFinishedAt = "2026-09-22T02:00:00.000Z"; });
    expect(service.pending()).toEqual([]); // historical failures were consumed by the verdict
    fixture.database.transaction((db) => db.prepare("DELETE FROM evolution_evidence").run());
    for (let i = 0; i < 10; i++) store.recordEvidence({ workbenchId: "a", goalId: `g${String(i)}`, revisionId: null, outcome: i < 3 ? "VERIFICATION_FAILED" : "VERIFIED", observedAt: "2026-09-22T03:00:00.000Z" });
    expect(service.pending()).toHaveLength(1); // fresh failures re-arm the trigger
  });
  it("rejects changed model/evaluator versions and unsupported proposals", async () => {
    service.configure("a", 10);
    store.update("a", (s) => { s.batch = { ...batch(), evaluatorVersion: "old" }; });
    await service.handle("evolution:a");
    expect(service.status("a").reason).toBe("model_changed");
    expect(call).not.toHaveBeenCalled();
    store.update("a", (s) => { s.batch = { ...batch(), phase: "PROPOSE" }; });
    call.mockResolvedValue({ strategy: { ...baselineStrategy, context: "requirements_first" }, fixes: [], risks: [] });
    await service.handle("evolution:a");
    expect(service.status("a").reason).toBe("invalid_candidate");
  });
  it("counts a proposal from a previous day's batch against today's candidate limit", async () => {
    service.configure("a", 10);
    store.update("a", (s) => { s.batch = { ...batch(), phase: "PROPOSE" }; s.lastCandidateDay = "2026-09-21"; });
    call.mockResolvedValue({ strategy: baselineStrategy, fixes: [], risks: [] });
    await service.handle("evolution:a");
    expect(service.status("a").reason).toBe("invalid_candidate");
    expect(service.pending()).toEqual([]);
  });
  it.each(["hard_violation", "quality_regression", "insufficient_gain"] as const)("rejects development validation with %s", async (reason) => {
    service.configure("a", 10);
    const scenarios = evolutionScenarios("development");
    const runs = scenarios.flatMap((s) => [0,1,2].map((attempt) => ({ scenarioId: s.id, variant: "baseline" as const, attempt, calls: 3, observations: [], actions: [], success: true })));
    const candidates = runs.map((r) => ({ ...r, variant: "candidate" as const }));
    const last = candidates.pop(); assert(last);
    const scenario = scenarios.at(-1); assert(scenario);
    store.update("a", (s) => {
      s.revisions = [{ ...revision(), status: "CANDIDATE", prediction: { fixes: [scenarios[0]?.id ?? ""], risks: [] } }];
      s.batch = { ...batch(), phase: "VALIDATE", revisionId: "r1", rollouts: [...runs, ...candidates, { scenarioId: last.scenarioId, variant: "candidate", attempt: last.attempt, observations: [], calls: 2, actions: scenario.requiredIds.map((id) => `read:${id}`) }] };
    });
    call.mockResolvedValue(reason === "hard_violation" ? { action: "write_file" } : { action: "finish", decision: reason === "quality_regression" ? "wait" : scenario.expected, evidenceIds: scenario.requiredIds });
    await service.handle("evolution:a");
    expect(service.status("a").reason).toBe(reason);
    expect(service.status("a").activeRevisionId).toBeNull();
    expect(service.status("a").versions[0]?.status).toBe("REJECTED");
    // The verdict statistics survive the finished batch so the panel can show how close it came.
    expect(service.status("a").lastVerdict?.reason).toBe(reason);
  });
  it("restores the superseded parent and rejects late results after source changes", async () => {
    store.update("a", (s) => { s.revisions = [{ ...revision("parent"), status: "SUPERSEDED" }, { ...revision(), parentRevisionId: "parent" }]; s.activeRevisionId = "r1"; });
    expect(service.rollback("a", "r1").activeRevisionId).toBe("parent");
    expect(service.status("a").versions.find((r) => r.revisionId === "parent")?.status).toBe("ACTIVE");
    service.configure("a", 10);
    // The rollback verdict consumed the stale evidence trigger; seed the resumed batch directly.
    store.update("a", (s) => { s.batch = batch(); });
    const source = vi.fn().mockResolvedValueOnce(pin).mockResolvedValue({ ...pin, sourceRevisionId: "changed" });
    const changed = new EvolutionService({ store, model: { pin: source, call }, now: () => day, id: () => "changed" });
    await changed.handle("evolution:a");
    expect(changed.status("a").reason).toBe("model_changed");
    expect(changed.status("a").activeRevisionId).toBe("parent");
    // The rollback verdict stamped the trigger; the infrastructure abort leaves that stamp unchanged.
    expect(store.read("a").lastBatchFinishedAt).toBe(day);
  });
  it("warns on the first monitored verification failure and rolls back on the second", () => {
    store.update("a", (s) => { s.revisions = [revision()]; s.activeRevisionId = "r1"; });
    fixture.database.transaction((db) => db.prepare("UPDATE evolution_evidence SET revision_id = 'r1' WHERE goal_id = 'g0'").run());
    const warnings: RuntimeDiagnosticEventMap["joi.evolution.monitor_warning"][] = [];
    const watching = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => day, id: () => "w", stepsPerHandle: 1,
      diagnostics: { emit: (name, fields) => { if (name === "joi.evolution.monitor_warning") warnings.push(fields as unknown as RuntimeDiagnosticEventMap["joi.evolution.monitor_warning"]); } } });
    watching.scan();
    expect(service.status("a").activeRevisionId).toBe("r1"); // one unlucky failure does not kill a fresh strategy
    expect(warnings).toEqual([{ workbenchId: "a", failedCount: 1, threshold: 2 }]);
    fixture.database.transaction((db) => db.prepare("UPDATE evolution_evidence SET revision_id = 'r1' WHERE goal_id = 'g1'").run());
    watching.scan();
    expect(service.status("a").activeRevisionId).toBeNull(); // the second failure in the window reverts
    store.update("a", (s) => { s.paused = false; s.revisions = [{ ...revision(), monitoredGoals: Array.from({length:10}, (_, i) => `old-${String(i)}`) }]; s.activeRevisionId = "r1"; });
    service.scan();
    expect(service.status("a").activeRevisionId).toBe("r1"); // the window stops growing at ten goals
  });
  it("validates feedback scope and makes emergency stop cancel background calls", () => {
    store.update("a", (s) => { s.revisions = [revision()]; s.activeRevisionId = "r1"; });
    expect(() => service.negativeFeedback("a", "unknown")).toThrow();
    service.strategyForGoal("a", "g1", pin);
    expect(service.negativeFeedback("a", "g1").activeRevisionId).toBeNull();
    expect(service.negativeFeedback("a", "g1").reason).toBe("rolled_back");
    expect(() => service.rollback("a", "stale")).toThrow();
    service.configure("a", 3);
    expect(service.canceled("evolution:a")).toBe(false);
    service.emergencyStop();
    expect(service.canceled("evolution:a")).toBe(true);
    expect(service.canceled("evolution:missing")).toBe(true);
  });
  it("classifies acceptance gaps, cancellation and unverified success separately", () => {
    fixture.database.transaction((db) => db.prepare("DELETE FROM evolution_evidence").run());
    const common = { workbenchId: "a", observedAt: day, canceled: false, disposition: "COMPLETED", verified: 1, failed: 0, unverified: 0, workFailed: 0 };
    vi.spyOn(store, "evidenceSeeds").mockReturnValue([
      { ...common, goalId: "g0", canceled: true },
      { ...common, goalId: "g1", disposition: "ACCEPTED_WITH_GAPS" },
      { ...common, goalId: "g2", failed: 1 },
      { ...common, goalId: "g3", workFailed: 1 },
      { ...common, goalId: "g4" },
      { ...common, goalId: "g5", unverified: 1 },
    ]);
    service.scan();
    expect(store.evidence("a").map((e) => e.outcome).sort()).toEqual(["ACCEPTED_WITH_GAPS", "CANCELED", "ENVIRONMENT_FAILED", "UNEVALUABLE", "VERIFICATION_FAILED", "VERIFIED"]);
    service.configure("a", 10);
    expect(service.pending()).toEqual([]);
  });
  it("keeps a revoked goal's verification failure whichever order its facts arrive in", () => {
    fixture.database.transaction((db) => db.prepare("DELETE FROM evolution_evidence").run());
    // Disposition stays null, so the revocation is the only fact that could speak for this goal.
    const common = { workbenchId: "a", observedAt: day, disposition: null, verified: 2, failed: 0, unverified: 0, workFailed: 0 };
    const seeds = vi.spyOn(store, "evidenceSeeds");
    const outcomeOf = (goalId: string) => store.evidence("a").find((entry) => entry.goalId === goalId)?.outcome;
    // Sampled while nothing had failed yet: the revocation is all we know.
    seeds.mockReturnValue([{ ...common, goalId: "g0", canceled: true }]);
    service.scan();
    expect(outcomeOf("g0")).toBe("CANCELED");
    // The verification failure then lands. Revoked goals are exactly where these concentrate, so the
    // revocation must not keep them out — that is the whole signal the trigger pool is built on.
    seeds.mockReturnValue([{ ...common, goalId: "g0", canceled: true, failed: 1 }]);
    service.scan();
    expect(outcomeOf("g0")).toBe("VERIFICATION_FAILED");
    // A later re-look that no longer reports the failure must not be able to walk it back.
    seeds.mockReturnValue([{ ...common, goalId: "g0", canceled: true }]);
    service.scan();
    expect(outcomeOf("g0")).toBe("VERIFICATION_FAILED");
  });
  it("does not publish when disabled during a call and skips canceled requests", async () => {
    service.configure("a", 10);
    const controller = new AbortController(); controller.abort();
    await service.handle("evolution:a", controller.signal);
    await service.handle("ordinary-input");
    expect(call).not.toHaveBeenCalled();
    call.mockImplementation(() => { service.configure("a", 0); return Promise.resolve({ action: "finish", decision: "complete", evidenceIds: [] }); });
    await service.handle("evolution:a");
    expect(store.read("a").batch?.rollouts[0]?.success).toBeUndefined();
    expect(service.status("a").activeRevisionId).toBeNull();
    expect(service.status("a").callsUsedToday).toBe(1);
  });
  it("arms a batch from the shared evidence pool and picks the strongest local signal", () => {
    fixture.database.transaction((db) => {
      db.prepare("DELETE FROM evolution_evidence").run();
      db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('b','B','p','','','','mem-b','ACTIVE',?,?)`).run(day, day);
      for (let i = 0; i < 5; i++) db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private','CONSUMED','b',?,?)`).run(`h${String(i)}`, `h${String(i)}`, day, day);
    });
    // Neither workbench reaches ten evaluable with three failures on its own; the shared pool does.
    for (let i = 0; i < 6; i++) store.recordEvidence({ workbenchId: "a", goalId: `g${String(i)}`, revisionId: null, outcome: i < 2 ? "VERIFICATION_FAILED" : "VERIFIED", observedAt: day });
    for (let i = 0; i < 5; i++) store.recordEvidence({ workbenchId: "b", goalId: `h${String(i)}`, revisionId: null, outcome: i < 1 ? "VERIFICATION_FAILED" : "VERIFIED", observedAt: day });
    expect(store.evidenceTotals(null)).toEqual({ evaluable: 11, verificationFailed: 3 });
    // The status DTO reports the pool the gate uses, so the settings panel can explain itself.
    expect(service.status("a")).toMatchObject({ evaluableCount: 6, poolEvaluable: 11, poolVerificationFailed: 3 });
    service.configure("a", 10);
    service.configure("b", 10);
    // The trigger pool is shared but the revision lands on one workbench, so the strongest local
    // signal wins.
    expect(service.pending()).toEqual([{ inputId: "evolution:a", createdAt: day }]);
    // With the local signal tied the pick falls back to the workbench id, so it stays stable across
    // restarts instead of depending on row order.
    fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES ('h5','h5','private','CONSUMED','b',?,?)`).run(day, day));
    store.recordEvidence({ workbenchId: "b", goalId: "h5", revisionId: null, outcome: "VERIFIED", observedAt: day });
    expect(store.evidence("a").length).toBe(store.evidence("b").length);
    expect(service.pending()).toEqual([{ inputId: "evolution:a", createdAt: day }]);
    // Negative control: drop the pool below the threshold and nothing fires despite both budgets.
    fixture.database.transaction((db) => db.prepare("DELETE FROM evolution_evidence WHERE workbench_id = 'b'").run());
    expect(service.pending()).toEqual([]);
  });
  it("reports why a batch was declined, once per change instead of every tick", () => {
    const emit = vi.fn();
    const observed = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => day, id: () => "batch-1", diagnostics: { emit } });
    fixture.database.transaction((db) => db.prepare("DELETE FROM evolution_evidence").run());
    observed.configure("a", 10);
    expect(observed.pending()).toEqual([]);
    expect(emit).toHaveBeenCalledWith("joi.evolution.gate_skipped", expect.objectContaining({
      reason: "evidence_below_threshold", evaluable: 0, verificationFailed: 0,
      thresholdEvaluable: EVOLUTION_EVIDENCE_THRESHOLD, thresholdFailed: EVOLUTION_FAILURE_THRESHOLD,
    }));
    // pending() runs on every idle tick, so an unchanged gate must not repeat itself.
    expect(observed.pending()).toEqual([]);
    expect(observed.pending()).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    // A busy instance is a different reason and is reported again.
    fixture.database.transaction((db) => db.prepare("UPDATE joi_inbox_messages SET status = 'PENDING' WHERE input_id = 'g0'").run());
    expect(observed.pending()).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith("joi.evolution.gate_skipped", expect.objectContaining({ reason: "not_idle" }));
  });
  it("logs evidence upgrades so a masked verification failure stays visible", () => {
    const emit = vi.fn();
    const observed = new EvolutionService({ store, model: { pin: () => Promise.resolve(pin), call }, now: () => day, id: () => "batch-1", diagnostics: { emit } });
    // Start from an empty pool: the shared beforeEach fixture already recorded g0 as a failure, and
    // a classification may only be upgraded, never downgraded.
    fixture.database.transaction((db) => db.prepare("DELETE FROM evolution_evidence").run());
    const seed = { workbenchId: "a", observedAt: day, canceled: false, disposition: "COMPLETED", verified: 1, failed: 0, unverified: 0, workFailed: 0 };
    const seeds = vi.spyOn(store, "evidenceSeeds");
    seeds.mockReturnValue([{ ...seed, goalId: "g0" }]);
    observed.scan();
    expect(emit).toHaveBeenCalledWith("joi.evolution.evidence_recorded", { goalInputId: "g0", workbenchId: "a", outcome: "VERIFIED" });
    // Re-observing the same facts is not news.
    emit.mockClear();
    observed.scan();
    expect(emit).not.toHaveBeenCalledWith("joi.evolution.evidence_recorded", expect.anything());
    // The failure that follows the premature snapshot upgrades it, and the log names what it replaced.
    seeds.mockReturnValue([{ ...seed, goalId: "g0", verified: 0, failed: 1, observedAt: "2026-09-23T01:00:00.000Z" }]);
    observed.scan();
    expect(emit).toHaveBeenCalledWith("joi.evolution.evidence_recorded",
      { goalInputId: "g0", workbenchId: "a", outcome: "VERIFICATION_FAILED", previousOutcome: "VERIFIED" });
    expect(store.evidence("a").find((entry) => entry.goalId === "g0")).toMatchObject({ outcome: "VERIFICATION_FAILED" });
    // A refused downgrade (here: the goal is canceled after failing) still refreshes the guard, but
    // must not be logged as a new outcome — the stored classification did not change.
    emit.mockClear();
    seeds.mockReturnValue([{ ...seed, goalId: "g0", verified: 0, failed: 0, canceled: true, observedAt: "2026-09-24T01:00:00.000Z" }]);
    observed.scan();
    expect(emit).not.toHaveBeenCalledWith("joi.evolution.evidence_recorded", expect.anything());
    expect(store.evidence("a").find((entry) => entry.goalId === "g0")).toMatchObject({ outcome: "VERIFICATION_FAILED" });
  });
  it("parks unusable sources for the day without unbudgeted model attempts", async () => {
    service.configure("a", 10);
    const broken = new EvolutionService({ store, model: { pin: vi.fn().mockRejectedValue(new Error("not ready")), call }, now: () => day, id: () => "b" });
    await broken.handle("evolution:a");
    expect(broken.status("a").reason).toBe("call_failed");
    expect(broken.pending()).toEqual([]);
    expect(call).not.toHaveBeenCalled();
    broken.park("evolution:missing");
    broken.park("evolution:a");
    expect(broken.canceled("evolution:a")).toBe(true);
    expect(broken.evaluatorVersion).toBe(EVOLUTION_EVALUATOR_VERSION);
  });
});
