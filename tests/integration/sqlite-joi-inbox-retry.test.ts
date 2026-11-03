import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

describe("sqlite joi inbox retry", () => {
  it("re-queues a parked goal, clears the failure markers and refuses live rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-retry-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-retry", text: "分析 Sandcastle" });

      expect(await repository.retry("does-not-exist", {})).toBeNull();
      expect(await repository.retry(accepted.inputId, {})).toBeNull();

      await repository.park(accepted.inputId, { failureCount: 8, reasonCode: "work_dispatch_failed" });
      const retried = await repository.retry(accepted.inputId, {});
      expect(retried).toMatchObject({ body: "分析 Sandcastle", inputId: accepted.inputId, status: "PENDING" });
      expect(retried?.failedAt).toBeUndefined();
      expect(retried?.failureCount).toBeUndefined();
      expect(retried?.failureReasonCode).toBeUndefined();
      expect(retried?.canceledAt).toBeUndefined();
      // Once revived the row is PENDING again and cannot be retried a second time.
      expect(await repository.retry(accepted.inputId, {})).toBeNull();
      expect((await new SqliteJoiHomeFeedRepository(database).load(new Date())).goals[0]).toMatchObject({
        goalId: accepted.inputId,
        status: "ARRANGING",
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("appends supplementary text to the stored body when continuing a terminal goal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-retry-text-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-retry-text", text: "分析 Sandcastle" });
      await repository.park(accepted.inputId, { failureCount: 8, reasonCode: "work_dispatch_failed" });
      const retried = await repository.retry(accepted.inputId, { text: "已修复搭档技能，重新派发" });
      expect(retried?.body).toBe("分析 Sandcastle\n\n[用户补充] 已修复搭档技能，重新派发");
      expect(retried?.status).toBe("PENDING");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("revives canceled and completed goals so the home feed can continue them", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "继续", personaSummary: "persona", projectLabel: "任务", scopeSummary: "终态继续" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });

      const canceled = await inbox.accept({ idempotencyKey: "key-retry-canceled", text: "被取消的目标" });
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, continuation_allowance, created_at, updated_at)
          VALUES (?, ?, '取消前已画出的目标', 'ACTIVE', 2, '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`)
          .run(canceled.inputId, workbench.workbenchId);
      });
      await repository.cancel(canceled.inputId);
      // Cancel closes the map so the goal stops blocking the evolution evidence scan; reviving the
      // goal must re-open it, otherwise the retry would resume without its charted state.
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status FROM joi_harness_maps WHERE goal_input_id = ?").get(canceled.inputId))).toEqual({ status: "CLEARED" });
      const revivedCanceled = await repository.retry(canceled.inputId, {});
      expect(revivedCanceled).toMatchObject({ status: "PENDING" });
      expect(revivedCanceled?.canceledAt).toBeUndefined();
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, cleared_at, feedback_recorded_at FROM joi_harness_maps WHERE goal_input_id = ?").get(canceled.inputId)))
        .toEqual({ status: "ACTIVE", cleared_at: null, feedback_recorded_at: null });

      const completed = await inbox.accept({ idempotencyKey: "key-retry-completed", text: "已完成的目标" });
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_retry_done', ?, ?, 'joi_session:test', 'COMPLETED', '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`).run(completed.inputId, workbench.workbenchId);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(completed.inputId);
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, revision, reviewed_revision,
           cleared_at, feedback_recorded_at, created_at, updated_at)
          VALUES (?, ?, '完成第二阶段', 'CLEARED', 4, 2,
                  '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z',
                  '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`)
          .run(completed.inputId, workbench.workbenchId);
      });
      const followedUp = await repository.retry(completed.inputId, { text: "接着做第二阶段" });
      expect(followedUp).toMatchObject({ status: "PENDING" });
      expect(followedUp?.body).toContain("[用户补充] 接着做第二阶段");
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT status, reviewed_revision,
        cleared_at, feedback_recorded_at FROM joi_harness_maps WHERE goal_input_id = ?`).get(completed.inputId))).toEqual({
        cleared_at: null,
        feedback_recorded_at: null,
        reviewed_revision: 2,
        status: "ACTIVE",
      });
    } finally {
      await fixture.close();
    }
  });

  it("does not close a retried goal using the prior completed result and review", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "续做", personaSummary: "persona", projectLabel: "joi", scopeSummary: "续做" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "retry-stale-outcome", text: "完成第一阶段", workbenchId: workbench.workbenchId });
      const old = fixture.clock.now().toISOString();
      fixture.clock.advance(60_000);
      const reviewId = `joi_harness_review:goal:${goal.inputId}:r1`;
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(goal.inputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('old-goal-turn', ?, ?, 'old-session', 'COMPLETED', 1, ?, ?)`).run(goal.inputId, workbench.workbenchId, old, old);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('old-completed-work', ?, ?, '第一阶段', '{}', 'READ', 'COMPLETED', ?, ?)`)
          .run(workbench.workbenchId, goal.inputId, old, old);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 1, 1, ?)`).run(goal.inputId, old);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES (?, 1, 'COMPLETED', '第一阶段完成', ?, ?)`).run(goal.inputId, old, old);
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, revision, reviewed_revision, created_at, updated_at)
          VALUES (?, ?, '完成目标', 'CLEARED', 2, 1, ?, ?)`).run(goal.inputId, workbench.workbenchId, old, old);
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
          VALUES (?, ?, '旧评审', 'CONSUMED', ?, ?, ?, ?)`).run(reviewId, `review:${goal.inputId}`, workbench.workbenchId, goal.inputId, old, old);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('old-review-turn', ?, ?, 'old-session', 'COMPLETED', ?, ?)`).run(reviewId, workbench.workbenchId, old, old);
      });

      await repository.retry(goal.inputId, { text: "继续第二阶段" });
      await repository.createTurn({
        createdAt: fixture.clock.now().toISOString(), inputId: goal.inputId,
        sessionId: "new-session", turnId: "new-goal-turn", workbenchId: workbench.workbenchId,
      });
      await expect(repository.completeInput(goal.inputId, "new-goal-turn"))
        .rejects.toMatchObject({ code: "joi_goal_followup_without_work" });
      await repository.failTurn(goal.inputId, "new-goal-turn");
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      expect((await harness.listReviewRecoveries()).filter((candidate) => candidate.digest.goalInputId === goal.inputId)).toEqual([]);
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now())).goals
        .find((item) => item.goalId === goal.inputId)?.status).toBe("ARRANGING");
    } finally {
      await fixture.close();
    }
  });

  it("hands an inferred follow-up answer to the user instead of failing the goal", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "续问", personaSummary: "persona", projectLabel: "joi", scopeSummary: "续问" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "retry-inferred-answer", text: "分析当前进度" });
      const old = fixture.clock.now().toISOString();
      fixture.clock.advance(60_000);
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(goal.inputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('old-goal-turn', ?, ?, 'old-session', 'COMPLETED', 1, ?, ?)`).run(goal.inputId, workbench.workbenchId, old, old);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('old-completed-work', ?, ?, '第一阶段', '{}', 'READ', 'COMPLETED', ?, ?)`)
          .run(workbench.workbenchId, goal.inputId, old, old);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 1, 1, ?)`).run(goal.inputId, old);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES (?, 1, 'COMPLETED', '第一阶段完成', ?, ?)`).run(goal.inputId, old, old);
      });

      await repository.retry(goal.inputId, { text: "继续第二阶段" });
      await repository.createTurn({
        createdAt: fixture.clock.now().toISOString(), inputId: goal.inputId,
        sessionId: "new-session", turnId: "new-goal-turn", workbenchId: workbench.workbenchId,
      });
      // A text-only answer without new Work cannot silently finish the goal — but it also
      // must not crash-loop: the answer goes to the user as a confirmation question.
      await repository.completeInput(goal.inputId, "new-goal-turn", {
        completionSummary: "第一阶段的结论如下……剩余待办需要你确认优先级。",
        outcome: "DIRECT_ANSWER",
      });

      expect((await repository.list()).find((record) => record.inputId === goal.inputId)).toMatchObject({
        clarificationReasonCode: "joi_goal_followup_answer_unconfirmed",
        status: "CLARIFICATION_REQUIRED",
      });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(goal.inputId)))
        .toEqual({ status: "WAITING_INPUT" });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status FROM joi_turns WHERE turn_id = 'new-goal-turn'").get()))
        .toEqual({ status: "COMPLETED" });
      // The stale outcome stays untouched until the user confirms.
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT completed_at FROM joi_goal_outcomes WHERE input_id = ?").get(goal.inputId)))
        .toEqual({ completed_at: old });
    } finally {
      await fixture.close();
    }
  });

  it("keeps an earlier result current when the user merely answers a clarification", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "answer-keeps-outcome", text: "已完成阶段" });
      const old = fixture.clock.now().toISOString();
      fixture.clock.advance(60_000);
      fixture.database.transaction((connection) => {
        connection.prepare(`UPDATE joi_inbox_messages
          SET status = 'CONSUMED', last_opened_at = ? WHERE input_id = ?`)
          .run(fixture.clock.now().toISOString(), goal.inputId);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 1, 1, ?)`).run(goal.inputId, old);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES (?, 1, 'COMPLETED', '已完成', ?, ?)`).run(goal.inputId, old, old);
      });
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now())).goals
        .find((item) => item.goalId === goal.inputId)).toMatchObject({
        completionSummary: "已完成",
        status: "COMPLETED",
      });
    } finally {
      await fixture.close();
    }
  });

  it("accepts an explicit direct follow-up and replaces the older completion summary", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "追问", personaSummary: "persona", projectLabel: "joi", scopeSummary: "追问" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "retry-direct-followup", text: "第一阶段", workbenchId: workbench.workbenchId });
      const old = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(goal.inputId);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 1, 1, ?)`).run(goal.inputId, old);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES (?, 1, 'COMPLETED', '旧结论', ?, ?)`).run(goal.inputId, old, old);
      });
      fixture.clock.advance(60_000);
      await repository.retry(goal.inputId, { text: "解释旧结论" });
      await repository.createTurn({
        createdAt: fixture.clock.now().toISOString(), inputId: goal.inputId,
        sessionId: "direct-session", turnId: "direct-followup-turn", workbenchId: workbench.workbenchId,
      });
      await repository.completeInput(goal.inputId, "direct-followup-turn", {
        committedByTool: true, completionSummary: "新的直接回答", outcome: "DIRECT_ANSWER",
      });
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now())).goals
        .find((item) => item.goalId === goal.inputId)).toMatchObject({
        completionSummary: "新的直接回答", status: "COMPLETED",
      });
    } finally {
      await fixture.close();
    }
  });

  it("opens a gate left waiting, so a revived goal is not stranded between the two scans", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-retry-gate", text: "停在一个问题前的目标" });
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(accepted.inputId);
        connection.prepare(`INSERT INTO joi_goal_execution_gates
          (goal_input_id, question_id, question_version, status, reason_code, created_at, updated_at)
          VALUES (?, ?, 1, 'WAITING_INPUT', 'question_required', ?, ?)`)
          .run(accepted.inputId, `goal_question:${accepted.inputId}:v1`, "2026-08-20T09:00:00.000Z", "2026-08-20T09:00:00.000Z");
      });

      await expect(repository.retry(accepted.inputId, { text: "跳过这个问题" })).resolves.toMatchObject({ status: "PENDING" });
      // Retry clears the clarification state, and the gate is the other half of it. Left waiting,
      // the revived goal is refused by the pending-input scan and no longer offered a card by the
      // continuation scan, so nothing would ever pick it up again.
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, resume_input_id FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(accepted.inputId)))
        .toEqual({ resume_input_id: null, status: "OPEN" });
    } finally {
      await fixture.close();
    }
  });

  it("refuses synthetic inputs, dismissed rows and goals with live work", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "守卫", personaSummary: "persona", projectLabel: "任务", scopeSummary: "重试守卫" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });

      // Synthetic orchestration inputs are never user goals.
      const synthetic = await repository.enqueueSystemSignal({ workbenchId: workbench.workbenchId, signalId: "signal-1", type: "test" });
      expect(await repository.retry(synthetic, {})).toBeNull();
      expect((await repository.loadInput(synthetic))?.status).toBe("PENDING");

      // A dismissed card stays gone.
      const dismissed = await inbox.accept({ idempotencyKey: "key-retry-dismissed", text: "会被移除的目标" });
      await repository.park(dismissed.inputId, { failureCount: 8, reasonCode: "work_dispatch_failed" });
      await repository.dismiss(dismissed.inputId);
      expect(await repository.retry(dismissed.inputId, {})).toBeNull();

      // A goal with live work cannot be revived; terminal work does not block it.
      const active = await inbox.accept({ idempotencyKey: "key-retry-active", text: "还有活动工作的目标" });
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_retry_active', ?, ?, 'joi_session:test', 'COMPLETED', '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`).run(active.inputId, workbench.workbenchId);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work_retry_live', ?, ?, '活动工作', '{}', 'READ', 'RUNNING', '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`).run(workbench.workbenchId, active.inputId);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(active.inputId);
      });
      expect(await repository.retry(active.inputId, {})).toBeNull();
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET status = 'COMPLETED' WHERE work_id = 'work_retry_live'",
      ).run());
      expect(await repository.retry(active.inputId, {})).not.toBeNull();
    } finally {
      await fixture.close();
    }
  });
});
