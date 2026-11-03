import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";

describe("AC-43/48/53 synthesis retry owns its evidence epoch", () => {
  it.each(["CONTINUE", "BLOCKED"] as const)("blocks stale %s harness decisions at scan and write time during explicit reconsideration", async disposition => {
    const fixture = await createGoalEvidenceFixture(disposition === "BLOCKED" ? [{ status: "FAILED", verification: "FAILED" }] : [{}]);
    try {
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { completionSummary: "OLD_VERDICT", outcome: disposition === "CONTINUE" ? "RESULT_CONTINUE" : "RESULT_BLOCKED" });
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      await harness.createMap({ goalInputId: "goal", workbenchId: fixture.workbenchId, now: fixture.clock.now().toISOString() });
      fixture.database.transaction(db => db.prepare("UPDATE joi_harness_maps SET continuation_allowance=0 WHERE goal_input_id='goal'").run());
      const continuation = (await harness.listContinuationDecisionSeeds())[0];
      const recovery = (await harness.listWorkRecoverySeeds())[0];
      if (disposition === "CONTINUE") expect(continuation).toBeDefined(); else expect(recovery).toBeDefined();
      fixture.clock.advance(1000);
      expect(await fixture.inbox.retry("goal", {})).toMatchObject({ status: "CONSUMED" });
      expect(await harness.listContinuationDecisionSeeds()).toEqual([]);
      expect(await harness.listWorkRecoverySeeds()).toEqual([]);
      // Even an outcome timestamp refreshed by recovery cannot displace an unfinished synthesis.
      fixture.database.transaction(db => db.prepare("UPDATE joi_goal_outcomes SET completed_at=(SELECT reopened_at FROM joi_inbox_messages WHERE input_id='goal') WHERE input_id='goal'").run());
      expect(await harness.listContinuationDecisionSeeds()).toEqual([]);
      expect(await harness.listWorkRecoverySeeds()).toEqual([]);
      if (continuation !== undefined) expect(await harness.requestContinuationDecision({ seed: continuation, now: fixture.clock.now().toISOString() })).toBe(false);
      if (recovery !== undefined) expect(await harness.enqueueWorkRecovery({ seed: recovery, now: fixture.clock.now().toISOString() })).toBeNull();
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_user_action_requests").get())?.n).toBe(0);
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_items").get())?.n).toBe(1);
    } finally { await fixture.close(); }
  });

  it("does not reopen a cleared map using a conclusion preceding the explicit synthesis retry", async () => {
    const fixture = await createGoalEvidenceFixture([{}]);
    try {
      await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { completionSummary: "OLD_VERDICT", outcome: "RESULT_CONTINUE" });
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      await harness.createMap({ goalInputId: "goal", workbenchId: fixture.workbenchId, now: fixture.clock.now().toISOString() });
      fixture.database.transaction(db => db.prepare("UPDATE joi_harness_maps SET status='CLEARED' WHERE goal_input_id='goal'").run());
      const seed = (await harness.listUnreviewedClearedMaps())[0];
      assert(seed);
      expect(await harness.listFeedbackTargets()).toHaveLength(1);
      fixture.clock.advance(1000);
      await fixture.inbox.retry("goal", {});
      expect(await harness.listUnreviewedClearedMaps()).toEqual([]);
      expect(await harness.reopenUnreviewedMap({ seed, now: fixture.clock.now().toISOString() })).toBe(false);
      expect(await harness.listFeedbackTargets()).toEqual([]);
      expect(await harness.recordCompletionFeedback({ workbenchId: fixture.workbenchId, goalInputId: "goal", entry: "STALE_FEEDBACK", now: fixture.clock.now().toISOString() })).toBe(false);
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM joi_harness_maps WHERE goal_input_id='goal'").get())?.status).toBe("CLEARED");
    } finally { await fixture.close(); }
  });
});
