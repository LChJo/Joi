import { appendGoalRequirementSource, SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture.js";

async function seed(fixture: RuntimeFixture) {
  const wb = await fixture.workbenchRegistry.create({ name: "Evidence", personaSummary: "Careful", projectLabel: "Test", scopeSummary: "Test" });
  const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const now = fixture.clock.now().toISOString();
  await inbox.create({ inputId: "goal", idempotencyKey: "goal", body: "Return evidence.", status: "CONSUMED", workbenchId: wb.workbenchId, createdAt: now, updatedAt: now });
  await inbox.createTurn({ inputId: "goal", turnId: "history", sessionId: "history", workbenchId: wb.workbenchId, createdAt: now });
  await inbox.recordTurnProgress("history", { formalOutputStarted: true, sideEffectStarted: true });
  await inbox.completeInput("goal", "history");
  const requirements = new SqliteGoalRequirementsRepository(fixture.database);
  await requirements.ensure({ goalInputId: "goal", workbenchId: wb.workbenchId });
  await requirements.readSource({ goalInputId: "goal", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 });
  await requirements.update({ goalInputId: "goal", workbenchId: wb.workbenchId, expectedRevision: 0, processedSourceRevision: 1,
    upserts: [{ id: "objective", text: "Return evidence.", kind: "OBJECTIVE", scope: "GLOBAL", mandatory: true, source: { sourceRevision: 1, start: 0, end: 16 } }], retirements: [] });
  fixture.database.transaction(db => {
    db.prepare(`INSERT INTO work_items(work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
      VALUES ('work',?,'goal','Evidence','{}','READ','COMPLETED',?,?)`).run(wb.workbenchId, now, now);
    db.prepare(`INSERT INTO joi_goal_result_sets(original_input_id,revision,synthesized_revision,synthesized_requirements_revision,updated_at)
      VALUES ('goal',1,1,1,?)`).run(now);
    db.prepare(`INSERT INTO joi_goal_outcomes(input_id,result_revision,requirements_revision,disposition,completion_summary,completed_at,updated_at)
      VALUES ('goal',1,1,'COMPLETED','Established evidence',?,?)`).run(now, now);
    appendGoalRequirementSource(db, "goal", "Check new evidence.", "ROUTINE", "routine-execution");
  });
  fixture.clock.advance(1_000);
  await inbox.createTurn({ inputId: "goal", turnId: "failed", sessionId: "current", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString() });
  return { inbox, wb, requirements };
}

describe("failed requirement processing with historical results", () => {
  it("records an idempotent failure receipt and explicitly retries against the retained evidence", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { inbox, requirements, wb } = await seed(fixture);
      await inbox.failTurn("goal", "failed", { reasonCode: "joi_turn_outcome_uncommitted" });
      const failedAt = fixture.clock.now().toISOString();
      expect((await inbox.list()).find(row => row.inputId === "goal")).toMatchObject({ status: "CONSUMED", failedAt, failureCount: 1, failureReasonCode: "joi_turn_outcome_uncommitted" });
      expect((await fixture.joiHomeFeed.load()).goals[0]).toMatchObject({ status: "FAILED", failure: { attempts: 1 }, work: { completed: 1 } });
      fixture.clock.advance(1_000);
      await inbox.failTurn("goal", "failed", { reasonCode: "joi_turn_outcome_uncommitted" });
      expect((await inbox.list()).find(row => row.inputId === "goal")).toMatchObject({ failedAt, failureCount: 1 });
      expect(await inbox.retry("goal", {})).toMatchObject({ status: "PENDING" });
      expect((await inbox.list()).find(row => row.inputId === "goal")?.failedAt).toBeUndefined();
      expect((await fixture.joiHomeFeed.load()).goals[0]?.status).toBe("ARRANGING");
      await expect(requirements.assertReady("goal", 1)).rejects.toMatchObject({ code: "goal_requirements_pending" });
      expect(await requirements.load("goal", wb.workbenchId)).toMatchObject({ revision: 1, processedSourceRevision: 1 });
      expect(fixture.database.transaction(db => db.prepare("SELECT completion_summary FROM joi_goal_outcomes WHERE input_id='goal'").get())?.completion_summary).toBe("Established evidence");
    } finally { await fixture.close(); }
  });

  it.each(["stopped", "live-turn", "queued-child", "live-work", "question", "ready"] as const)("projects historical %s state without replaying execution", async state => {
    const fixture = await createRuntimeFixture();
    try {
      const { inbox, wb, requirements } = await seed(fixture);
      fixture.database.transaction(db => db.prepare("UPDATE joi_turns SET status='FAILED' WHERE turn_id='failed'").run());
      if (state === "live-turn") await inbox.createTurn({ inputId: "goal", turnId: "live", sessionId: "live", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString() });
      if (state === "queued-child") fixture.database.transaction(db => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,goal_input_id,status,workbench_id,created_at,updated_at)
        VALUES ('child','child','Process requirements','goal','PENDING',?,?,?)`).run(wb.workbenchId, fixture.clock.now().toISOString(), fixture.clock.now().toISOString()));
      if (state === "live-work") fixture.database.transaction(db => db.prepare("UPDATE work_items SET status='RUNNING' WHERE work_id='work'").run());
      if (state === "question") await inbox.requireClarification("goal", "question_required", "Which evidence?");
      if (state === "ready") {
        await requirements.readSource({ goalInputId: "goal", workbenchId: wb.workbenchId, sourceRevision: 2, offset: 0 });
        await requirements.update({ goalInputId: "goal", workbenchId: wb.workbenchId, expectedRevision: 1, processedSourceRevision: 2, upserts: [], retirements: [] });
      }
      const before = fixture.database.transaction(db => db.prepare("SELECT total_changes() AS n").get())?.n;
      const goal = (await fixture.joiHomeFeed.load()).goals[0];
      expect(goal?.status).toBe(state === "stopped" ? "FAILED" : state === "live-work" ? "RUNNING" : state === "question" ? "NEEDS_ATTENTION" : state === "ready" ? "COMPLETED" : "FINALIZING");
      if (state === "stopped") expect(goal?.failure).toMatchObject({ reasonCode: "joi_task_turn_failed" });
      expect(fixture.database.transaction(db => db.prepare("SELECT total_changes() AS n").get())?.n).toBe(before);
      expect((await inbox.list()).find(row => row.inputId === "goal")?.failedAt).toBeUndefined();
      if (state !== "stopped") {
        await inbox.failTurn("goal", "failed", { reasonCode: "joi_turn_outcome_uncommitted" });
        expect((await inbox.list()).find(row => row.inputId === "goal")?.failedAt).toBeUndefined();
      }
    } finally { await fixture.close(); }
  });
});
