import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

describe("sqlite joi inbox cancel", () => {
  it("parks scheduler failures without claiming that the user canceled them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-park-failure-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-failure", text: "执行一次任务" });

      const parked = await repository.park(accepted.inputId, { failureCount: 8, reasonCode: "unsafe_reasoning_tool" });
      if (parked === null) throw new Error("parked input missing");
      expect(parked).toMatchObject({
        failureCount: 8, failureReasonCode: "unsafe_reasoning_tool", status: "CONSUMED",
      });
      expect(typeof parked.failedAt).toBe("string");
      expect(parked.canceledAt).toBeUndefined();
      expect((await new SqliteJoiHomeFeedRepository(database).load(new Date())).goals[0]).toMatchObject({
        failure: {
          attempts: 8,
          executionStarted: false,
          reasonCode: "unsafe_reasoning_tool",
          suggestedAction: "RESTART_OR_UPDATE",
        },
        status: "FAILED",
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cancels a clarification input and refuses rows that already left the queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-cancel-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-1", text: "研究登录改造" });

      expect(await repository.cancel("does-not-exist")).toBeNull();
      const canceledRecord = await repository.cancel(accepted.inputId);
      expect(canceledRecord).toMatchObject({ inputId: accepted.inputId, status: "CONSUMED" });
      expect(typeof canceledRecord?.canceledAt).toBe("string");
      expect(await repository.cancel(accepted.inputId)).toBeNull();

      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid");
      expect((await repository.loadInput(accepted.inputId))?.status).toBe("CONSUMED");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cancels a pending input and the service rejects a non-cancelable one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-cancel-pending-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-2", text: "归属？" });
      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });
      await expect(inbox.cancel({ inputId: accepted.inputId })).rejects.toMatchObject({ code: "joi_cancel_unavailable" });
      expect(await repository.clarify(accepted.inputId, { text: "too late" })).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("revives a consumed goal input when a partner question arrives and routes the answer back", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "验证", personaSummary: "persona", projectLabel: "技能", scopeSummary: "验证" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-question", text: "验证搜索技能" });
      // Consume the goal the way a finished turn would, without pulling in model-source FKs.
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_question', ?, ?, 'joi_session:test', 'COMPLETED', '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`).run(accepted.inputId, workbench.workbenchId);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(accepted.inputId);
      });
      expect((await repository.loadInput(accepted.inputId))?.status).toBe("CONSUMED");

      // The partner paused with a blocking question after the goal turn had completed.
      await repository.requireClarification(accepted.inputId, "question_required", "搭档『验证搭档』在执行工作『搜索验证』时暂停并提问：\nTavily API Key 是什么？");
      const raised = (await repository.list()).find((entry) => entry.inputId === accepted.inputId);
      expect(raised).toMatchObject({ clarificationReasonCode: "question_required", status: "CLARIFICATION_REQUIRED" });

      // The user's answer appends to the original request and re-enters the scheduler.
      const answered = await repository.clarify(accepted.inputId, { text: "key 在 ~/.openclaw/.env" });
      expect(answered).toMatchObject({ status: "PENDING" });
      expect(answered?.body).toContain("[用户补充] key 在 ~/.openclaw/.env");

      // A stale orphan-turn sweep must never swallow the card while the user is thinking.
      await repository.requireClarification(accepted.inputId, "question_required", "第二个问题？");
      await repository.failTurn(accepted.inputId, "turn_stale");
      expect((await repository.loadInput(accepted.inputId))?.status).toBe("CLARIFICATION_REQUIRED");
    } finally {
      await fixture.close();
    }
  });

  it("cascades goal cancellation onto not-yet-final work so waiting work cannot block synthesis", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "级联", personaSummary: "persona", projectLabel: "任务", scopeSummary: "取消" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-cascade", text: "两个任务" });
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_cascade', ?, ?, 'joi_session:test', 'COMPLETED', '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`).run(accepted.inputId, workbench.workbenchId);
        const insertWork = connection.prepare(`
          INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', ?, '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`);
        insertWork.run("work_waiting", workbench.workbenchId, accepted.inputId, "等待回答", "WAITING");
        insertWork.run("work_done", workbench.workbenchId, accepted.inputId, "已完成", "COMPLETED");
      });

      const canceled = await repository.cancel(accepted.inputId);
      expect(canceled).toMatchObject({ status: "CONSUMED" });
      const statuses = fixture.database.transaction((connection) => connection.prepare(
        "SELECT work_id, status FROM work_items ORDER BY work_id",
      ).all()) as { status: string; work_id: string }[];
      expect(statuses).toEqual([
        { status: "COMPLETED", work_id: "work_done" },
        { status: "CANCELED", work_id: "work_waiting" },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
