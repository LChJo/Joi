import { SqliteUsageStore } from "../../src/main/infrastructure/persistence/sqlite-usage-store";
import { StatisticsService } from "../../src/main/application/statistics/statistics-service";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("numeric usage ledger", () => {
  let fixture: RuntimeFixture;
  let store: SqliteUsageStore;
  let service: StatisticsService;
  const now = "2026-09-22T00:00:00.000Z";
  const query = { from: "2026-09-22", to: "2026-09-22", timeZone: "UTC" };
  beforeEach(async () => { fixture = await createRuntimeFixture(); store = new SqliteUsageStore(fixture.database, () => now); service = new StatisticsService({ store, now: () => now, id: () => fixture.ids.next("usage") }); });
  afterEach(async () => { await fixture.close(); });
  it("persists cumulative per-model snapshots without duplicate totals, and recovers unknown interruptions", () => {
    const session = service.begin({ engine: "claude-code", purpose: "partner", modelId: "first" });
    expect(service.query(query).overview).toMatchObject({ records: 1, unknownRecords: 1 });
    const tokens = { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, reasoning: null };
    session.record({ key: "first", modelId: "first", tokens });
    session.record({ key: "first", modelId: "first", tokens: { ...tokens, input: 110 } });
    session.record({ key: "second", modelId: "second", tokens });
    session.finish("failed");
    expect(service.query(query).overview).toMatchObject({ total: 250, records: 2, unknownRecords: 0, failedRecords: 2 });
    service.begin({ engine: "a2a", purpose: "partner" });
    service.recover();
    expect(service.query(query).overview).toMatchObject({ total: 250, records: 3, unknownRecords: 1 });
    expect(new SqliteUsageStore(fixture.database, () => "2027-01-01T00:00:00Z").snapshot(now, "2026-09-23T00:00:00Z").collectedSince).toBe(now);
    expect(JSON.stringify(service.query(query))).not.toContain("tokens_json");
  });
  it("isolates storage faults from execution but exposes degradation", () => {
    vi.spyOn(store, "begin").mockImplementationOnce(() => { throw new Error("private path"); });
    const session = service.begin({ engine: "pi", purpose: "orchestration" });
    expect(() => session.record({ key: "m", tokens: null })).not.toThrow();
    expect(() => session.finish("failed")).not.toThrow();
    expect(service.query(query).collectionDegraded).toBe(true);
    expect(JSON.stringify(service.query(query))).not.toContain("private");
    const restored = new StatisticsService({ store, now: () => now, id: () => "restored" });
    expect(restored.query(query).collectionDegraded).toBe(true);
  });
  it("derives goal ownership, preserves archived workbenches and counts completed goals once", () => {
    fixture.database.transaction((db) => {
      for (const id of ["a", "b"]) db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES (?,?,'p','private persona','','',?,'ACTIVE',?,?)`).run(id, `Workbench ${id}`, id, now, now);
      for (const id of ["g", "waiting", "failed"]) db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'private body','CONSUMED','a',?,?)`).run(id, id, now, now);
      db.prepare(`INSERT INTO joi_goal_outcomes(input_id,result_revision,disposition,completion_summary,completed_at,updated_at) VALUES ('g',1,'COMPLETED','private summary',?,?)`).run(now, now);
      db.prepare(`INSERT INTO joi_goal_result_sets(original_input_id,revision,synthesized_revision,updated_at) VALUES ('g',1,1,?)`).run(now);
      db.prepare(`UPDATE joi_inbox_messages SET status = 'CLARIFICATION_REQUIRED' WHERE input_id = 'waiting'`).run();
      db.prepare(`UPDATE joi_inbox_messages SET failed_at = ? WHERE input_id = 'failed'`).run(now);
      db.prepare(`INSERT INTO joi_turns(turn_id,input_id,workbench_id,session_id,status,created_at,updated_at) VALUES ('t','g','a','s','COMPLETED',?,?)`).run(now, now);
      db.prepare(`INSERT INTO work_items(work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at) VALUES('w','a','g','private work','{}','READ','COMPLETED',?,?)`).run(now, now);
    });
    for (const goalId of ["g", "g", "waiting", "failed"]) {
      const session = service.begin({ engine: "pi", purpose: "partner", workbenchId: "a", goalId });
      session.record({ key: "1", tokens: { input: 20, output: 10, cacheRead: null, cacheWrite: null, reasoning: null } }); session.finish("completed");
    }
    service.begin({ engine: "codex", purpose: "partner", workId: "w" }).finish("completed");
    service.begin({ engine: "pi", purpose: "partner", workbenchId: "b", goalId: "g" }).finish("completed");
    const before = service.query(query);
    expect(before.overview).toMatchObject({ total: 120, completedGoals: 1 });
    expect(before.workbenches.find((w) => w.workbenchId === "a")).toMatchObject({ completedGoals: 1, waitingGoals: 1, failedGoals: 1 });
    expect(before.goals.find((g) => g.goalId === "g")?.records).toBe(3);
    expect(JSON.stringify(before)).not.toContain("private");
    fixture.database.transaction((db) => db.prepare("UPDATE workbenches SET status = 'ARCHIVED' WHERE workbench_id = 'a'").run());
    expect(service.query(query).workbenches.find((w) => w.workbenchId === "a")?.archived).toBe(true);
    expect(service.query({ ...query, workbenchId: "b" }).goals).toEqual([]);
  });
  it("does not count a completed result layer as a finished goal while review or continuation is active", () => {
    fixture.database.transaction((db) => {
      db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('a','A','p','','','','m','ACTIVE',?,?)`).run(now, now);
      db.prepare(`INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES ('g','g','private','CONSUMED','a',?,?)`).run(now, now);
      db.prepare(`INSERT INTO joi_goal_outcomes(input_id,result_revision,disposition,completion_summary,completed_at,updated_at) VALUES ('g',1,'COMPLETED','private',?,?)`).run(now, now);
      db.prepare(`INSERT INTO joi_goal_result_sets(original_input_id,revision,synthesized_revision,updated_at) VALUES ('g',1,1,?)`).run(now);
      db.prepare(`INSERT INTO joi_harness_maps(goal_input_id,workbench_id,destination,status,created_at,updated_at) VALUES ('g','a','Review me','ACTIVE',?,?)`).run(now, now);
    });
    service.begin({ engine: "pi", purpose: "orchestration", workbenchId: "a", goalId: "g" }).finish("completed");
    expect(service.query(query).overview.completedGoals).toBe(0);
    expect(service.query(query).goals[0]?.status).toBe("running");
    fixture.database.transaction((db) => db.prepare("UPDATE joi_harness_maps SET status='CLEARED'").run());
    expect(service.query(query).overview.completedGoals).toBe(1);
    fixture.database.transaction((db) => db.prepare("UPDATE joi_goal_outcomes SET disposition='CONTINUE'").run());
    expect(service.query(query).overview.completedGoals).toBe(0);
  });
  it("keeps measured consumption if a late failure supplies no usage, and rejects invalid counts", () => {
    const session = service.begin({ engine: "pi", purpose: "probe" });
    session.record({ key: "response", tokens: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null } });
    session.record({ key: "response", tokens: null });
    session.finish("canceled"); session.finish("completed");
    expect(service.query(query).overview.total).toBe(6);
    expect(store.snapshot(now, "2026-09-23T00:00:00.000Z").records[0]?.status).toBe("canceled");
    const invalid = service.begin({ engine: "pi", purpose: "probe" });
    invalid.record({ key: "response", tokens: { input: -1, output: 2, cacheRead: null, cacheWrite: null, reasoning: null } }); invalid.finish("failed");
    expect(service.query(query).overview).toMatchObject({ total: 6, unknownRecords: 1 });
  });
});
