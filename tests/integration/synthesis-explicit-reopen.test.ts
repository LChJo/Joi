import { enqueueGoalResultSynthesis } from "../../src/main/infrastructure/persistence/sqlite-goal-result-synthesis.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";

describe("AC-43/48 explicit synthesis reconsideration", () => {
  it.each(["pending-input", "live-turn"] as const)("rejects retry when the goal has a %s before its first committed synthesis", async kind => {
    const fixture = await createGoalEvidenceFixture([{}]);
    try {
      fixture.database.transaction(db => {
        db.prepare("UPDATE joi_inbox_messages SET status='CONSUMED' WHERE input_id=?").run(fixture.inputId);
        db.prepare("UPDATE joi_turns SET status=? WHERE turn_id='synthesis-turn'").run(kind === "live-turn" ? "RUNNING" : "COMPLETED");
        if (kind === "pending-input") db.prepare("UPDATE joi_inbox_messages SET status='PENDING' WHERE input_id=?").run(fixture.inputId);
      });
      expect(await fixture.inbox.retry("goal", {})).toBeNull();
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM joi_inbox_messages WHERE input_id='goal'").get())?.status).toBe("CONSUMED");
    } finally { await fixture.close(); }
  });
  it.each([
    { outcome: "RESULT_BLOCKED", requirementsRevision: 0 }, { outcome: "RESULT_CONTINUE", requirementsRevision: 0 },
    { outcome: "RESULT_BLOCKED", requirementsRevision: 1 }, { outcome: "RESULT_CONTINUE", requirementsRevision: 1 },
  ] as const)("reconsiders $outcome at q$requirementsRevision once per explicit retry without repeating Work", async ({ outcome, requirementsRevision }) => {
    const fixture = await createGoalEvidenceFixture([{}]);
    try {
      if (requirementsRevision > 0) fixture.database.transaction(db => {
        db.prepare("INSERT INTO joi_goal_requirements (goal_input_id,workbench_id,revision,processed_source_revision) VALUES ('goal',?,1,0)").run(fixture.workbenchId);
        db.prepare("INSERT INTO joi_goal_requirement_snapshots (goal_input_id,revision,requirements_json) VALUES ('goal',1,'[]')").run();
        db.prepare("UPDATE joi_inbox_messages SET requirements_revision=1 WHERE input_id=?").run(fixture.inputId);
        db.prepare("UPDATE joi_turns SET requirements_revision=1 WHERE turn_id='synthesis-turn'").run();
      });
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { completionSummary: "FIRST_REVIEW", outcome });
      const enqueue = () => fixture.database.transaction(db => enqueueGoalResultSynthesis(db, "goal", fixture.workbenchId, fixture.clock.now().toISOString()));
      expect(enqueue()).toBeNull();
      fixture.clock.advance(1000);
      expect(await fixture.inbox.retry("goal", {})).toMatchObject({ inputId: "goal", status: "CONSUMED" });
      const owner = fixture.database.transaction(db => db.prepare("SELECT synthetic_input_id FROM joi_goal_result_sets WHERE original_input_id='goal'").get()?.synthetic_input_id);
      expect(typeof owner).toBe("string");
      expect(owner).not.toBe(fixture.inputId);
      expect(enqueue()).toBe(owner);
      expect(await fixture.inbox.retry("goal", {})).toBeNull();
      const pending = fixture.database.transaction(db => db.prepare("SELECT input_id FROM joi_inbox_messages WHERE status='PENDING'").all());
      expect(pending).toEqual([{ input_id: owner }]);
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now())).goals.find(goal => goal.goalId === "goal")?.status).toBe("FINALIZING");
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_items").get())?.n).toBe(1);
      await fixture.inbox.createTurn({ inputId: String(owner), workbenchId: fixture.workbenchId, turnId: "reconsider-turn", sessionId: "reconsider-session", createdAt: fixture.clock.now().toISOString(),
        ...(requirementsRevision === 0 ? {} : { requirementsRevision }) });
      const committed = await fixture.inbox.completeInput(String(owner), "reconsider-turn", { completionSummary: "RECONSIDERED_DELIVERABLE", outcome: "RESULT_SYNTHESIZED" });
      expect(committed).toMatchObject({ goalOutcomePersisted: true, resultRevision: 1, disposition: "COMPLETED" });
      expect(enqueue()).toBeNull();
      expect(fixture.database.transaction(db => db.prepare("SELECT completion_summary FROM joi_goal_outcomes WHERE input_id='goal'").get())?.completion_summary).toBe("RECONSIDERED_DELIVERABLE");
      expect(fixture.database.transaction(db => db.prepare("SELECT completion_summary FROM joi_goal_outcome_history WHERE goal_input_id='goal'").get())?.completion_summary).toBe("FIRST_REVIEW");
      await fixture.inbox.completeInput(String(owner), "reconsider-turn", { completionSummary: "DUPLICATE_OVERWRITE", outcome: "RESULT_BLOCKED" });
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { completionSummary: "LATE_OLD_DELIVERY", outcome });
      expect(fixture.database.transaction(db => db.prepare("SELECT completion_summary FROM joi_goal_outcomes WHERE input_id='goal'").get())?.completion_summary).toBe("RECONSIDERED_DELIVERABLE");
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM joi_inbox_messages WHERE input_id=?").get(String(owner)))?.status).toBe("CONSUMED");
    } finally { await fixture.close(); }
  });
  it("distinguishes successive explicit retries when the clock remains at one millisecond", async () => {
    const fixture = await createGoalEvidenceFixture([{}]);
    try {
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { completionSummary: "FIRST_REVIEW", outcome: "RESULT_BLOCKED" });
      const owners = [fixture.inputId];
      for (let index = 0; index < 2; index += 1) {
        expect(await fixture.inbox.retry("goal", {})).toMatchObject({ status: "CONSUMED" });
        const owner = String(fixture.database.transaction(db => db.prepare("SELECT synthetic_input_id FROM joi_goal_result_sets WHERE original_input_id='goal'").get()?.synthetic_input_id));
        expect(owners).not.toContain(owner);
        owners.push(owner);
        const turnId = `retry-turn-${String(index)}`;
        await fixture.inbox.createTurn({ inputId: owner, workbenchId: fixture.workbenchId, turnId, sessionId: "retry-session", createdAt: fixture.clock.now().toISOString() });
        expect(await fixture.inbox.completeInput(owner, turnId, { completionSummary: `Review ${String(index)}`, outcome: "RESULT_BLOCKED" })).toMatchObject({ goalOutcomePersisted: true });
        expect(fixture.database.transaction(db => enqueueGoalResultSynthesis(db, "goal", fixture.workbenchId, fixture.clock.now().toISOString()))).toBeNull();
      }
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_items").get())?.n).toBe(1);
    } finally { await fixture.close(); }
  });
});
