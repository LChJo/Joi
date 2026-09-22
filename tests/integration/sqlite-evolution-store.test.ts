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
  it("records each goal once and keeps evidence private to its workbench", () => {
    const evidence = { goalId: "g", workbenchId: "a", revisionId: null, outcome: "UNEVALUABLE" as const, observedAt: "2026-09-22" };
    expect(store.recordEvidence(evidence)).toBe(true);
    expect(store.recordEvidence(evidence)).toBe(false);
    expect(store.evidence("a")).toEqual([evidence]);
    expect(store.evidence("b")).toEqual([]);
    expect(store.evidenceSeeds()).toEqual([]);
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
