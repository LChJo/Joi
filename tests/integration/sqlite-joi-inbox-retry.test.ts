import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

describe("sqlite joi inbox retry", () => {
  it("re-queues a parked goal, clears the failure markers and refuses live rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-retry-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
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
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
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
