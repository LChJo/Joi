import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { OutboxDispatcher } from "../../src/main/application/operations/outbox-dispatcher";
import { DEFAULT_EVOLUTION_DAILY_CALL_LIMIT } from "../../src/shared/evolution";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("evolution durable state", () => {
  let fixture: RuntimeFixture;
  let store: SqliteEvolutionStore;
  beforeEach(async () => {
    fixture = await createRuntimeFixture();
    store = new SqliteEvolutionStore(fixture.database);
    fixture.database.transaction((db) => {
      for (const id of ["a", "b"]) db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES (?, 'A',?,'','','',?,'ACTIVE','2026-09-22','2026-09-22')`).run(id, id, id);
      db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES ('g','g','private','CONSUMED','a','2026-09-22','2026-09-22')`).run();
    });
  });
  afterEach(async () => { await fixture.close(); });
  it("defaults to the low preset, persists settings, and rejects foreign goals", () => {
    expect(store.read("a").dailyCallLimit).toBe(DEFAULT_EVOLUTION_DAILY_CALL_LIMIT);
    store.update("a", (state) => { state.dailyCallLimit = 12; });
    expect(new SqliteEvolutionStore(fixture.database).read("a").dailyCallLimit).toBe(12);
    expect(store.read("b").dailyCallLimit).toBe(DEFAULT_EVOLUTION_DAILY_CALL_LIMIT);
    expect(() => store.bindGoal("b", "g", null)).toThrow();
    expect(store.bindGoal("a", "g", null)).toBeNull();
    expect(store.bindGoal("a", "g", "later")).toBeNull();
  });
  it("records each goal once per change and keeps evidence private to its workbench", () => {
    const evidence = { goalId: "g", workbenchId: "a", revisionId: null, outcome: "UNEVALUABLE" as const, observedAt: "2026-09-22" };
    expect(store.recordEvidence(evidence)).toBe("UNEVALUABLE");
    expect(store.recordEvidence(evidence)).toBeNull();
    expect(store.evidence("a")).toEqual([evidence]);
    expect(store.evidence("b")).toEqual([]);
    expect(store.evidenceSeeds()).toEqual([]);
  });
  it("upgrades a stale classification without downgrading or re-arming a consumed verdict", () => {
    const at = (observedAt: string, outcome: "UNEVALUABLE" | "CANCELED" | "VERIFIED" | "VERIFICATION_FAILED") =>
      ({ goalId: "g", workbenchId: "a", revisionId: null, outcome, observedAt });
    const classified = () => (fixture.database.transaction((db) => db.prepare(
      "SELECT classified_at FROM evolution_evidence WHERE goal_id = 'g'").get()) as { classified_at: string }).classified_at;
    // Sampled before its first Work was dispatched: no outcome and no work_items yet, so UNEVALUABLE.
    expect(store.recordEvidence(at("2026-09-22T01:00:00.000Z", "UNEVALUABLE"))).toBe("UNEVALUABLE");
    // The verification failures that follow must still be able to replace that snapshot.
    expect(store.recordEvidence(at("2026-09-22T05:00:00.000Z", "VERIFICATION_FAILED"))).toBe("VERIFICATION_FAILED");
    expect(store.evidence("a")).toEqual([{ goalId: "g", workbenchId: "a", revisionId: null, outcome: "VERIFICATION_FAILED", observedAt: "2026-09-22T05:00:00.000Z" }]);
    // Canceling afterwards must not erase the failure signal, and must not move observed_at: that
    // timestamp is the verdict window, so a batch that already consumed the failure stays consumed.
    // The refused downgrade reports the outcome that was kept, not the one that was offered.
    expect(store.recordEvidence(at("2026-09-22T09:00:00.000Z", "CANCELED"))).toBe("VERIFICATION_FAILED");
    expect(store.evidence("a")[0]).toMatchObject({ outcome: "VERIFICATION_FAILED", observedAt: "2026-09-22T05:00:00.000Z" });
    // classified_at advanced, so the goal is not re-sampled until its facts move again.
    expect(classified()).toBe("2026-09-22T09:00:00.000Z");
    expect(store.recordEvidence(at("2026-09-22T09:00:00.000Z", "CANCELED"))).toBeNull();
  });
  it("re-admits a goal migration 059 marked unsampled, but never rewrites a real revision pin", () => {
    const pinRow = () => fixture.database.transaction((db) => db.prepare(
      "SELECT revision_id, eligible FROM evolution_goal_pins WHERE goal_id = 'g'").get());
    // 059 backfilled every then-existing goal as eligible = 0, including goals still in flight
    // whose whole outcome landed afterwards. Binding such a goal again re-admits it.
    fixture.database.transaction((db) => db.prepare(
      "INSERT INTO evolution_goal_pins(goal_id,workbench_id,revision_id,eligible) VALUES ('g','a',NULL,0)").run());
    expect(store.bindGoal("a", "g", "rev-1")).toBeNull();
    expect(pinRow()).toEqual({ revision_id: null, eligible: 1 });
    // A goal already bound to a real revision was sampled under that strategy: first bind wins, so
    // the outcome stays attributable to exactly one revision.
    fixture.database.transaction((db) => db.prepare(
      "UPDATE evolution_goal_pins SET revision_id = 'rev-9', eligible = 0 WHERE goal_id = 'g'").run());
    expect(store.bindGoal("a", "g", null)).toBe("rev-9");
    expect(pinRow()).toEqual({ revision_id: "rev-9", eligible: 0 });
  });
  it("aggregates the trigger pool across workbenches and honors the verdict window", () => {
    fixture.database.transaction((db) => db.prepare(
      "INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES ('h','h','private','CONSUMED','b','2026-09-22','2026-09-22')").run());
    expect(store.evidenceTotals(null)).toEqual({ evaluable: 0, verificationFailed: 0 });
    const record = (goalId: string, workbenchId: string, outcome: "VERIFIED" | "VERIFICATION_FAILED" | "UNEVALUABLE", observedAt: string) =>
      store.recordEvidence({ goalId, workbenchId, revisionId: null, outcome, observedAt });
    record("g", "a", "VERIFIED", "2026-09-22T01:00:00.000Z");
    record("h", "b", "VERIFICATION_FAILED", "2026-09-22T02:00:00.000Z");
    // Neither workbench holds enough evidence alone; the pool is shared because evaluation runs on
    // synthetic scenarios identical for every workbench.
    expect(store.evidence("a")).toHaveLength(1);
    expect(store.evidence("b")).toHaveLength(1);
    expect(store.evidenceTotals(null)).toEqual({ evaluable: 2, verificationFailed: 1 });
    // A verdict consumes the evidence observed before it.
    expect(store.evidenceTotals("2026-09-22T01:30:00.000Z")).toEqual({ evaluable: 1, verificationFailed: 1 });
    expect(store.evidenceTotals("2026-09-22T03:00:00.000Z")).toEqual({ evaluable: 0, verificationFailed: 0 });
    // Non-evaluable outcomes never count toward the trigger.
    fixture.database.transaction((db) => db.prepare(
      "INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES ('k','k','private','CONSUMED','a','2026-09-22','2026-09-22')").run());
    record("k", "a", "UNEVALUABLE", "2026-09-22T04:00:00.000Z");
    expect(store.evidenceTotals(null)).toEqual({ evaluable: 2, verificationFailed: 1 });
  });
  it("writes the model outbox atomically and rolls back failed mutations", () => {
    store.update("a", (state) => { state.call = { id: "evo-call", state: "RUNNING", createdAt: "2026-09-22" }; });
    expect(fixture.database.transaction((db) => db.prepare("SELECT kind,status FROM outbox WHERE outbox_id = 'evo-call'").get())).toMatchObject({ kind: "evolution.model", status: "CLAIMED" });
    expect(() => store.update("a", (state) => { state.dailyCallLimit = 99; throw new Error("rollback"); })).toThrow();
    expect(store.read("a").dailyCallLimit).toBe(DEFAULT_EVOLUTION_DAILY_CALL_LIMIT);
    store.update("a", (state) => { assert(state.call); state.call.state = "DONE"; });
    expect(fixture.database.transaction((db) => db.prepare("SELECT status FROM outbox WHERE outbox_id = 'evo-call'").get())).toMatchObject({ status: "DONE" });
  });
  it("keeps audit-only evolution outbox rows out of the generic dispatcher", async () => {
    store.update("a", (state) => { state.call = { id: "evo-audit", state: "PENDING", createdAt: "2026-09-22" }; });
    const clock = { now: () => new Date("2026-09-22T01:00:00.000Z") };
    const auditRow = () => fixture.database.transaction((db) => db.prepare("SELECT status,attempt_count FROM outbox WHERE outbox_id = 'evo-audit'").get());
    // The wiring passes excludeKinds: ["partner.dispatch", "evolution.model"]; the audit row stays untouched.
    const excluded = new OutboxDispatcher({ clock, excludeKinds: ["partner.dispatch", "evolution.model"], handlers: {}, owner: "operations", store: fixture.database.store });
    await excluded.dispatchOnce();
    expect(auditRow()).toMatchObject({ status: "PENDING", attempt_count: 0 });
    // Without the exclusion the dispatcher claims a row it has no handler for.
    const unfiltered = new OutboxDispatcher({ clock, handlers: {}, owner: "operations", store: fixture.database.store });
    await unfiltered.dispatchOnce();
    expect(auditRow()).toMatchObject({ status: "PENDING", attempt_count: 1 });
  });
});
