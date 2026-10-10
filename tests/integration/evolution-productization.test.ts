import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EvolutionService } from "../../src/main/application/evolution/evolution-service";
import type { EvolutionModel } from "../../src/main/application/ports/evolution";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";
import { baselineStrategy } from "../../src/main/domain/evolution/strategy";
import { EVOLUTION_EVALUATOR_VERSION } from "../../src/main/domain/evolution/scenarios";

describe("evolution productization", () => {
  let fixture: RuntimeFixture;
  let store: SqliteEvolutionStore;
  const now = "2026-10-10T04:00:00.000Z";
  const pin = { modelId: "model", modelRevisionId: "model-r1", sourceId: "source", sourceRevisionId: "source-r1" };
  const call = vi.fn<(...args: Parameters<EvolutionModel["call"]>) => ReturnType<EvolutionModel["call"]>>();

  beforeEach(async () => {
    call.mockReset().mockResolvedValue({ action: "read_evidence", evidenceId: "record-11" });
    fixture = await createRuntimeFixture();
    store = new SqliteEvolutionStore(fixture.database);
    fixture.database.transaction((db) => {
      db.prepare(`INSERT INTO workbenches
        (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES ('a','A','p','','','','mem-a','ACTIVE',?,?)`).run(now, now);
    });
  });

  afterEach(async () => fixture.close());

  function service() {
    return new EvolutionService({
      id: () => "batch-product",
      model: { pin: () => Promise.resolve(pin), call },
      now: () => now,
      store,
      stepsPerHandle: 1,
    });
  }

  it("defaults new workbenches to explicit opt-in", () => {
    expect(store.read("a")).toMatchObject({ dailyCallLimit: 0, reason: "disabled" });
  });

  it("does not arm policy evolution from execution-attributed verification failures", () => {
    for (let index = 0; index < 10; index += 1) {
      const goalId = `goal-${String(index)}`;
      fixture.database.transaction((db) => {
        db.prepare(`INSERT INTO joi_inbox_messages
          (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
          VALUES (?,?,'private','CONSUMED','a',?,?)`).run(goalId, goalId, now, now);
      });
      store.recordEvidence({
        cause: index < 3 ? "execution" : "none",
        goalId,
        observedAt: now,
        outcome: index < 3 ? "VERIFICATION_FAILED" : "VERIFIED",
        revisionId: null,
        workbenchId: "a",
      });
    }
    service().configure("a", 50);
    expect(service().pending()).toEqual([]);
  });

  it("reports aggregate progress and preserves a pre-proposal failed batch", async () => {
    const subject = service();
    subject.configure("a", 50);
    subject.requestRun("a");
    call.mockRejectedValueOnce(new Error("provider unavailable"));
    await subject.handle("evolution:a");
    const overview = (subject as unknown as { overview(): { active: number; batches: { phase: string; reason: string }[] } }).overview();
    expect(overview.active).toBe(0);
    expect(overview.batches).toContainEqual(expect.objectContaining({ phase: "DEVELOP", reason: "call_failed" }));
  });

  it("uses shared evidence for a global baseline without creating an arbitrary local overlay", async () => {
    fixture.database.transaction((db) => {
      db.prepare(`INSERT INTO workbenches
        (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES ('b','B','p','','','','mem-b','ACTIVE',?,?)`).run(now, now);
      for (let index = 0; index < 10; index += 1) {
        const goalId = `foreign-${String(index)}`;
        db.prepare(`INSERT INTO joi_inbox_messages
          (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
          VALUES (?,?,'private','CONSUMED','b',?,?)`).run(goalId, goalId, now, now);
      }
    });
    for (let index = 0; index < 10; index += 1) store.recordEvidence({
      cause: index < 3 ? "completion" : "none", goalId: `foreign-${String(index)}`, observedAt: now,
      outcome: index < 3 ? "VERIFICATION_FAILED" : "VERIFIED", revisionId: null, workbenchId: "b",
    });
    const subject = service();
    subject.configure("a", 50);
    await subject.handle("evolution:a");
    expect(store.read("a").batch).toMatchObject({ scope: "GLOBAL" });
  });

  it("creates a workbench overlay only after local attributable evidence reaches the gate", async () => {
    store.update("a", (state) => {
      const globalStrategy = { ...baselineStrategy, completion: "evidence_matrix" as const };
      state.revisions = [{ revisionId: "global-r1", parentRevisionId: null, evaluatorVersion: EVOLUTION_EVALUATOR_VERSION,
        monitoredGoals: [], controlGoals: [], scope: "GLOBAL", strategy: globalStrategy, pin,
        evidenceIds: [], prediction: { fixes: [], risks: [] }, module: "completion", status: "ACTIVE", createdAt: now,
        reason: "promoted", baselineSuccesses: 80, candidateSuccesses: 90, evaluatedRuns: 180 }];
      state.sealedBaselineCache = { [`${EVOLUTION_EVALUATOR_VERSION}|${JSON.stringify(pin)}|${JSON.stringify(globalStrategy)}`]: [] };
    });
    for (let index = 0; index < 10; index += 1) {
      const goalId = `local-${String(index)}`;
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES (?,?,'private','CONSUMED','a',?,?)`).run(goalId, goalId, now, now));
      store.recordEvidence({ cause: index < 3 ? "context" : "none", goalId, observedAt: now,
        outcome: index < 3 ? "VERIFICATION_FAILED" : "VERIFIED", revisionId: null, workbenchId: "a" });
    }
    const subject = service();
    subject.configure("a", 50);
    await subject.handle("evolution:a");
    expect(store.read("a").batch).toMatchObject({ scope: "WORKBENCH", parentRevisionId: "global-r1" });
    expect(Object.keys(store.read("a").sealedBaselineCache ?? {})).toHaveLength(1);
  });

  it("cleans stale run-now requests and exposes the revision cap", () => {
    const subject = service();
    subject.configure("a", 50);
    store.update("a", (state) => {
      state.runRequestedAt = "2026-10-09T00:00:00.000Z";
      state.revisions = Array.from({ length: 30 }, (_, index) => ({ revisionId: `r-${String(index)}`, parentRevisionId: null,
        evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, monitoredGoals: [], strategy: baselineStrategy, pin, evidenceIds: [],
        prediction: { fixes: [], risks: [] }, module: "context" as const, status: "REJECTED" as const, createdAt: now,
        reason: "insufficient_gain" as const, baselineSuccesses: 0, candidateSuccesses: 0, evaluatedRuns: 0 }));
    });
    expect(subject.status("a")).toMatchObject({ runRequestedAt: null, reason: "revision_limit_reached" });
    expect(subject.pending()).toEqual([]);
    expect(() => subject.requestRun("a")).toThrow(expect.objectContaining({ code: "evolution_revision_limit" }));
  });

  it("consumes shared evidence with one global watermark across workbenches", () => {
    fixture.database.transaction((db) => {
      db.prepare(`INSERT INTO workbenches
        (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES ('b','B','p','','','','mem-b','ACTIVE',?,?)`).run(now, now);
      for (let index = 0; index < 10; index += 1) {
        const goalId = `shared-${String(index)}`;
        db.prepare(`INSERT INTO joi_inbox_messages
          (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
          VALUES (?,?,'private','CONSUMED','b',?,?)`).run(goalId, goalId, now, now);
      }
    });
    for (let index = 0; index < 10; index += 1) store.recordEvidence({ cause: index < 3 ? "completion" : "none",
      goalId: `shared-${String(index)}`, observedAt: now, outcome: index < 3 ? "VERIFICATION_FAILED" : "VERIFIED", revisionId: null, workbenchId: "b" });
    store.update("a", (state) => { state.batchHistory = [{ batchId: "finished", workbenchId: "a", scope: "GLOBAL", phase: "EVALUATE",
      startedAt: "2026-10-09T00:00:00.000Z", finishedAt: now, reason: "insufficient_gain", calls: 100, tokens: null, revisionId: "r" }]; });
    const subject = service();
    subject.configure("a", 50);
    subject.configure("b", 50);
    expect(subject.overview()).toMatchObject({ poolEvaluable: 0, poolVerificationFailed: 0 });
    expect(subject.pending()).toEqual([]);
  });

  it("rejects a failing local canary and promotes a passing global canary over its predecessor", () => {
    const createdAt = "2026-10-09T00:00:00.000Z";
    const revision = (revisionId: string, scope: "GLOBAL" | "WORKBENCH", status: "ACTIVE" | "CANARY") => ({
      revisionId, parentRevisionId: null, evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, monitoredGoals: [], controlGoals: [], scope,
      strategy: { ...baselineStrategy, completion: "evidence_matrix" as const }, pin, evidenceIds: [], prediction: { fixes: [], risks: [] },
      module: "completion" as const, status, createdAt, reason: status === "ACTIVE" ? "promoted" as const : "canary" as const,
      baselineSuccesses: 80, candidateSuccesses: 90, evaluatedRuns: 180,
    });
    store.update("a", (state) => { state.revisions = [revision("local-canary", "WORKBENCH", "CANARY")]; });
    for (let index = 0; index < 10; index += 1) {
      const goalId = `local-canary-goal-${String(index)}`;
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private','CONSUMED','a',?,?)`).run(goalId, goalId, now, now));
      const revisionId = index < 5 ? "local-canary" : null;
      store.bindGoal("a", goalId, revisionId, pin);
      store.recordEvidence({ cause: index < 2 ? "completion" : "none", goalId, observedAt: now,
        outcome: index < 2 ? "VERIFICATION_FAILED" : "VERIFIED", revisionId, workbenchId: "a" });
    }
    const subject = service();
    expect(subject.status("a")).toMatchObject({ canaryRevisionId: "local-canary" });
    subject.scan();
    expect(store.read("a").revisions[0]).toMatchObject({ status: "REJECTED", reason: "quality_regression" });
    store.update("a", (state) => { const candidate = state.revisions[0]; if (candidate !== undefined) { candidate.status = "CANARY"; candidate.reason = "canary"; } });
    expect(subject.negativeFeedback("a", "local-canary-goal-0").versions[0]).toMatchObject({ status: "REJECTED", reason: "rolled_back" });

    store.update("a", (state) => { state.revisions = [revision("old-global", "GLOBAL", "ACTIVE"), revision("new-global", "GLOBAL", "CANARY")]; });
    for (let index = 0; index < 10; index += 1) {
      const goalId = `global-canary-goal-${String(index)}`;
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private','CONSUMED','a',?,?)`).run(goalId, goalId, now, now));
      const revisionId = index < 5 ? "new-global" : "old-global";
      store.bindGoal("a", goalId, revisionId, pin);
      store.recordEvidence({ cause: "none", goalId, observedAt: now, outcome: "VERIFIED", revisionId, workbenchId: "a" });
    }
    subject.scan();
    expect(store.read("a").revisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ revisionId: "old-global", status: "SUPERSEDED" }),
      expect.objectContaining({ revisionId: "new-global", status: "ACTIVE", reason: "promoted" }),
    ]));
  });

  it("marks the consuming workbench when a global strategy pin needs revalidation", () => {
    fixture.database.transaction((db) => {
      db.prepare(`INSERT INTO workbenches
        (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES ('b','B','p','','','','mem-b','ACTIVE',?,?)`).run(now, now);
      db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES ('b-goal','b-goal','private','CONSUMED','b',?,?)`).run(now, now);
    });
    store.update("a", (state) => { state.revisions = [{ revisionId: "global", parentRevisionId: null, evaluatorVersion: EVOLUTION_EVALUATOR_VERSION,
      monitoredGoals: [], scope: "GLOBAL", strategy: { ...baselineStrategy, completion: "evidence_matrix" }, pin, evidenceIds: [], prediction: { fixes: [], risks: [] },
      module: "completion", status: "ACTIVE", createdAt: now, reason: "promoted", baselineSuccesses: 80, candidateSuccesses: 90, evaluatedRuns: 180 }]; });
    const subject = service();
    expect(subject.strategyForGoal("b", "b-goal", { ...pin, modelRevisionId: "new" }).strategyRevisionId).toBeNull();
    expect(subject.status("b")).toMatchObject({ reason: "revalidation_required", revalidationRequired: true, activeEffective: false });
  });

  it("allows the settings owner to manually roll back an active global strategy", () => {
    const globalRevision = (revisionId: string, status: "ACTIVE" | "SUPERSEDED", parentRevisionId: string | null = null) => ({ revisionId, parentRevisionId,
      evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, monitoredGoals: [], scope: "GLOBAL" as const,
      strategy: { ...baselineStrategy, completion: "evidence_matrix" as const }, pin, evidenceIds: [], prediction: { fixes: [], risks: [] },
      module: "completion" as const, status, createdAt: now, reason: "promoted" as const, baselineSuccesses: 80, candidateSuccesses: 90, evaluatedRuns: 180 });
    store.update("a", (state) => { state.revisions = [globalRevision("previous", "SUPERSEDED"), globalRevision("global", "ACTIVE", "previous")]; });
    const subject = service();
    expect(subject.status("a")).toMatchObject({ activeRevisionId: null, globalRevisionId: "global" });
    expect(subject.rollback("a", "global")).toMatchObject({ globalRevisionId: "previous", reason: "rolled_back" });
    expect(subject.rollback("a", "global")).toMatchObject({ globalRevisionId: "previous", reason: "rolled_back" });
    expect(store.read("a")).toMatchObject({ paused: true, revisions: [
      expect.objectContaining({ revisionId: "previous", status: "ACTIVE" }),
      expect.objectContaining({ revisionId: "global", status: "ROLLED_BACK" }),
    ] });
  });

  it("restores a global predecessor owned by another workbench and rejects stale candidates", () => {
    fixture.database.transaction((db) => db.prepare(`INSERT INTO workbenches
      (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
      VALUES ('b','B','p','','','','mem-b','ACTIVE',?,?)`).run(now, now));
    const revision = (revisionId: string, status: "ACTIVE" | "SUPERSEDED" | "CANARY", parentRevisionId: string | null = null) => ({ revisionId, parentRevisionId,
      evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, monitoredGoals: [], scope: "GLOBAL" as const,
      strategy: { ...baselineStrategy, completion: "evidence_matrix" as const }, pin, evidenceIds: [], prediction: { fixes: [], risks: [] },
      module: "completion" as const, status, createdAt: now, reason: status === "CANARY" ? "canary" as const : "promoted" as const,
      baselineSuccesses: 80, candidateSuccesses: 90, evaluatedRuns: 180 });
    store.update("a", (state) => { state.revisions = [revision("new-global", "ACTIVE", "old-global"), revision("stale-canary", "CANARY")]; });
    store.update("b", (state) => { state.revisions = [revision("old-global", "SUPERSEDED")]; });
    const subject = service();
    expect(subject.rollback("b", "new-global")).toMatchObject({ globalRevisionId: "old-global", reason: "rolled_back" });
    expect(store.read("a").paused).toBe(true);
    expect(store.read("a").revisions.find((entry) => entry.revisionId === "new-global")).toMatchObject({ status: "ROLLED_BACK" });
    expect(store.read("b")).toMatchObject({ paused: true, reason: "rolled_back", revisions: [expect.objectContaining({ revisionId: "old-global", status: "ACTIVE" })] });
    expect(() => subject.rollback("a", "stale-canary")).toThrow("The active strategy has changed.");
  });

  it("projects legacy in-flight batches with safe audit defaults", () => {
    store.update("a", (state) => {
      delete state.batchHistory;
      state.reason = "evaluating";
      state.batch = { id: "legacy", evaluatorVersion: EVOLUTION_EVALUATOR_VERSION, parentStrategy: baselineStrategy,
        parentRevisionId: null, strategy: baselineStrategy, pin, phase: "DEVELOP", evidenceIds: [], rollouts: [] };
    });
    const subject = service();
    expect(subject.overview().batches[0]).toEqual({ batchId: "legacy", workbenchId: "", scope: "WORKBENCH", phase: "DEVELOP",
      startedAt: "", finishedAt: null, reason: "evaluating", calls: 0, tokens: null, revisionId: null });
    expect(subject.status("a")).toMatchObject({ batchHistory: [], currentBatch: { batchId: "legacy", tokens: null } });
  });
});
