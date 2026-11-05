import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";

describe("AC-44/48/66 harness clear behind a user gate", () => {
  it.each((["WAITING_INPUT", "REVIEWING", "OPEN", "MISSING"] as const).flatMap(gateStatus =>
    (["RUNNING", "WAITING"] as const).map(turnStatus => ({ gateStatus, turnStatus }))))(
    "clears with gate=$gateStatus and review=$turnStatus only when the user gate permits it",
    async ({ gateStatus, turnStatus }) => {
      const fixture = await createGoalEvidenceFixture([{}]);
      try {
        const harness = new SqliteJoiHarnessRepository(fixture.database);
        const now = fixture.clock.now().toISOString();
        await harness.createMap({ workbenchId: fixture.workbenchId, goalInputId: "goal", now });
        await harness.synchronizeWorkPaths({ now });
        await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", {
          outcome: "RESULT_SYNTHESIZED", completionSummary: "Verified synthetic finding.",
        });
        const [digest] = await harness.listReviewDigests();
        if (digest === undefined) throw new Error("Review digest missing.");
        const reviewInputId = await harness.enqueueReview({ digest, now });
        if (reviewInputId === null) throw new Error("Review input missing.");
        await fixture.inbox.createTurn({ inputId: reviewInputId, workbenchId: fixture.workbenchId,
          sessionId: "review-session", turnId: "review-turn", createdAt: now });

        if (gateStatus !== "MISSING") {
          await fixture.inbox.requireClarification(reviewInputId, "question_required", "Synthetic review question.");
          if (gateStatus !== "WAITING_INPUT") fixture.database.transaction(db => {
            db.prepare("UPDATE joi_goal_execution_gates SET status=? WHERE goal_input_id='goal'").run(gateStatus);
            if (gateStatus === "OPEN") db.prepare(`UPDATE joi_inbox_messages SET status='CONSUMED',
              clarification_reason_code=NULL, clarification_prompt=NULL WHERE input_id='goal'`).run();
          });
        }
        fixture.database.transaction(db => db.prepare("UPDATE joi_turns SET status=? WHERE turn_id='review-turn'").run(turnStatus));
        const before = fixture.database.transaction(db => ({
          map: db.prepare("SELECT status, revision, cleared_at FROM joi_harness_maps WHERE goal_input_id='goal'").get(),
          gate: db.prepare("SELECT status, question_id, question_version FROM joi_goal_execution_gates WHERE goal_input_id='goal'").get(),
        }));

        const allowed = gateStatus === "OPEN" || gateStatus === "MISSING";
        expect(await harness.clearMap({ goalInputId: "goal", turnId: "review-turn" })).toBe(allowed);
        const after = fixture.database.transaction(db => ({
          map: db.prepare("SELECT status, revision, cleared_at FROM joi_harness_maps WHERE goal_input_id='goal'").get(),
          gate: db.prepare("SELECT status, question_id, question_version FROM joi_goal_execution_gates WHERE goal_input_id='goal'").get(),
        }));
        expect(after.gate).toEqual(before.gate);
        if (allowed) expect(after.map?.status).toBe("CLEARED");
        else expect(after.map).toEqual(before.map);
      } finally { await fixture.close(); }
    },
  );
});
