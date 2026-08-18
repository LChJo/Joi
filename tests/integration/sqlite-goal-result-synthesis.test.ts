import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("goal-level result synthesis", () => {
  it("batches authoritative Agent results, shows finalizing, and completes only after a bounded goal outcome is persisted", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "研究", personaSummary: "persona", projectLabel: "股票", scopeSummary: "分析" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "分析搭档", kind: "local-pi", skills: [], tools: [] });
      const now = "2026-08-05T09:00:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-stock', 'idem-stock', '分析这只股票', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-stock', 'goal-stock', ?, 'joi_session:stock', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        for (const index of [1, 2]) {
          connection.prepare(`INSERT INTO dispatch_plans
            (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
            VALUES (?, 'turn-stock', ?, '[]', ?)`).run(`plan-${String(index)}`, JSON.stringify({ workIds: [`work-${String(index)}`] }), now);
          connection.prepare(`INSERT INTO work_items
            (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
            VALUES (?, ?, 'goal-stock', ?, '{}', 'READ', ?, ?, ?)`)
            .run(`work-${String(index)}`, workbench.workbenchId, `工作 ${String(index)}`, index === 1 ? "COMPLETED" : "RUNNING", now, now);
          connection.prepare(`INSERT INTO dispatch_attempts
            (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(`attempt-${String(index)}`, `plan-${String(index)}`, `work-${String(index)}`, partner.partnerRevisionId,
              `action-${String(index)}`, index === 1 ? "COMPLETED" : "RUNNING", now, now);
          connection.prepare(`INSERT INTO partner_runs
            (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind,
             external_run_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'LOCAL_PI', ?, ?, ?, ?)`)
            .run(`run-${String(index)}`, `attempt-${String(index)}`, `action-${String(index)}`, workbench.workbenchId,
              `work-${String(index)}`, partner.partnerRevisionId, `local:${String(index)}`,
              index === 1 ? "COMPLETED" : "RUNNING", now, now);
        }
      });
      const insertResult = (index: number, createdAt: string) => fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO work_result_bodies (body_ref, body, created_at) VALUES (?, 'PRIVATE RAW RESULT', ?)`)
          .run(`body-${String(index)}`, createdAt);
        connection.prepare(`INSERT INTO work_results
          (result_id, run_id, action_id, workbench_id, work_id, partner_revision_id, status, summary, body_ref,
           artifacts_json, is_late, is_authoritative, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, '[]', 0, 1, ?)`)
          .run(`result-${String(index)}`, `run-${String(index)}`, `action-${String(index)}`, workbench.workbenchId,
            `work-${String(index)}`, partner.partnerRevisionId, `摘要 ${String(index)}`, `body-${String(index)}`, createdAt);
        connection.prepare(`INSERT INTO work_result_verifications (result_id, status, created_at)
          VALUES (?, 'NOT_REQUIRED', ?)`).run(`result-${String(index)}`, createdAt);
        connection.prepare(`INSERT INTO partner_result_events
          (event_id, run_id, workbench_id, work_id, partner_revision_id, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?)`)
          .run(`event-${String(index)}`, `run-${String(index)}`, workbench.workbenchId, `work-${String(index)}`, partner.partnerRevisionId, createdAt);
      });
      const inbox = new SqliteJoiInboxRepository(fixture.database);
      insertResult(1, now);
      await expect(inbox.enqueuePartnerResult({
        workbenchId: workbench.workbenchId, eventId: "event-1", resultId: "result-1", status: "COMPLETED", summary: "摘要 1", workId: "work-1",
      })).resolves.toBeNull();

      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE work_items SET status = 'COMPLETED' WHERE work_id = 'work-2'").run();
        connection.prepare("UPDATE dispatch_attempts SET status = 'COMPLETED' WHERE dispatch_attempt_id = 'attempt-2'").run();
        connection.prepare("UPDATE partner_runs SET status = 'COMPLETED' WHERE run_id = 'run-2'").run();
      });
      insertResult(2, "2026-08-05T09:01:00.000Z");
      const synthesisInputId = await inbox.enqueuePartnerResult({
        workbenchId: workbench.workbenchId, eventId: "event-2", resultId: "result-2", status: "COMPLETED", summary: "摘要 2", workId: "work-2",
      });
      expect(synthesisInputId).toBe("joi_result_input:goal:goal-stock");
      expect(await inbox.loadInput(synthesisInputId ?? "missing")).toMatchObject({
        goalInputId: "goal-stock", resultRevision: 2, status: "PENDING",
      });
      const synthesisBody = (await inbox.loadInput(synthesisInputId ?? "missing"))?.body ?? "";
      expect(synthesisBody).toContain("result-1");
      expect(synthesisBody).toContain("result-2");
      expect(synthesisBody).not.toContain("PRIVATE RAW RESULT");

      const before = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-05T09:01:01.000Z"));
      expect(before.goals[0]).toMatchObject({ canDelete: false, goalId: "goal-stock", status: "FINALIZING" });
      expect(before.thinking).toEqual(expect.arrayContaining([
        expect.objectContaining({ goalId: "goal-stock", phase: "queued" }),
      ]));

      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-synthesis', ?, ?, ?, 'RUNNING', ?, ?)`)
          .run(synthesisInputId, workbench.workbenchId, `joi_synthesis_session:${workbench.workbenchId}`,
            "2026-08-05T09:01:02.000Z", "2026-08-05T09:01:02.000Z");
        connection.prepare("UPDATE joi_inbox_messages SET status = 'ROUTED' WHERE input_id = ?").run(synthesisInputId);
      });
      await inbox.completeInput(synthesisInputId ?? "missing", "turn-synthesis", { completionSummary: "两项分析均已完成，结论已汇总。" });

      const after = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-05T09:01:03.000Z"));
      expect(after.goals[0]).toMatchObject({
        canDelete: true, completionSummary: "两项分析均已完成，结论已汇总。", goalId: "goal-stock", status: "COMPLETED",
      });
      await expect(inbox.enqueuePartnerResult({
        workbenchId: workbench.workbenchId, eventId: "event-2", resultId: "result-2", status: "COMPLETED", summary: "摘要 2", workId: "work-2",
      })).resolves.toBeNull();
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT revision, synthesized_revision FROM joi_goal_result_sets WHERE original_input_id = 'goal-stock'",
      ).get())).toEqual({ revision: 2, synthesized_revision: 2 });
      await expect(inbox.dismiss("goal-stock")).resolves.toMatchObject({ inputId: "goal-stock" });
    } finally {
      await fixture.close();
    }
  });
});
