import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

describe("sqlite joi inbox dismiss", () => {
  it("dismisses only terminal inputs and hides them from list()", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-dismiss-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const completed = await inbox.accept({ idempotencyKey: "key-1", text: "已完成的事" });
      const canceled = await inbox.accept({ idempotencyKey: "key-2", text: "被取消的事" });
      const live = await inbox.accept({ idempotencyKey: "key-3", text: "排队中的事" });
      await repository.completeInput(completed.inputId, "turn-ghost");
      await repository.cancel(canceled.inputId);

      expect(await repository.dismiss("does-not-exist")).toBeNull();
      expect(await repository.dismiss(live.inputId)).toBeNull();

      const dismissedCompleted = await repository.dismiss(completed.inputId);
      expect(dismissedCompleted).toMatchObject({ inputId: completed.inputId, status: "CONSUMED" });
      expect(typeof dismissedCompleted?.dismissedAt).toBe("string");
      const dismissedCanceled = await repository.dismiss(canceled.inputId);
      expect(typeof dismissedCanceled?.dismissedAt).toBe("string");
      expect(await repository.dismiss(completed.inputId)).toBeNull();

      const listed = (await repository.list()).map((record) => record.inputId);
      expect(listed).toContain(live.inputId);
      expect(listed).not.toContain(completed.inputId);
      expect(listed).not.toContain(canceled.inputId);
      expect((await repository.loadInput(completed.inputId))?.status).toBe("CONSUMED");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lets the service dismiss a canceled input once and rejects live ones", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-dismiss-service-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-4", text: "取消后移除" });
      const live = await inbox.accept({ idempotencyKey: "key-5", text: "还活着" });
      await inbox.cancel({ inputId: accepted.inputId });

      const dismissed = await inbox.dismiss({ inputId: accepted.inputId });
      expect(dismissed).toMatchObject({ canceled: true, status: "CONSUMED" });
      await expect(inbox.dismiss({ inputId: accepted.inputId })).rejects.toMatchObject({ code: "joi_dismiss_unavailable" });
      await expect(inbox.dismiss({ inputId: live.inputId })).rejects.toMatchObject({ code: "joi_dismiss_unavailable" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("closes the harness map of a dismissed goal that dispatched Work", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "忽略清图", personaSummary: "persona", projectLabel: "任务", scopeSummary: "忽略时关闭清图" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-dismiss-map", text: "带产出的目标" });
      const now = "2026-09-23T09:00:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_dismiss_map', ?, ?, 'joi_session:test', 'COMPLETED', ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED', workbench_id = ? WHERE input_id = ?").run(workbench.workbenchId, accepted.inputId);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work_dismiss_map', ?, ?, '产出报告', '{}', 'READ', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, accepted.inputId, now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 1, 1, ?)`).run(accepted.inputId, now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at) VALUES (?, 1, '报告已产出。', ?, ?)`).run(accepted.inputId, now, now);
        // A destination plus dispatched Work puts this map out of reach of every clearing path:
        // review and AUTO_CLEAR need a COMPLETED disposition matching the reviewed revision, and
        // trivial clear needs a goal that dispatched nothing at all.
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, revision, continuation_allowance, created_at, updated_at)
          VALUES (?, ?, '产出定稿报告', 'ACTIVE', 3, 2, ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
      });

      expect(await repository.dismiss(accepted.inputId)).toMatchObject({ status: "CONSUMED" });
      // A dismissed goal cannot be retried, so dismiss is the last chance to close its map; leaving
      // it ACTIVE would keep the goal out of the evolution evidence scan forever.
      const dismissedMap = fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, cleared_at, feedback_recorded_at FROM joi_harness_maps WHERE goal_input_id = ?")
        .get(accepted.inputId)) as { status: string; cleared_at: string | null; feedback_recorded_at: string | null };
      expect(dismissedMap.status).toBe("CLEARED");
      expect(typeof dismissedMap.cleared_at).toBe("string");
      expect(typeof dismissedMap.feedback_recorded_at).toBe("string");
    } finally {
      await fixture.close();
    }
  });

  it("keeps a consumed goal visible while any related Work is non-terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-dismiss-work-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench-dismiss', 'A', 'persona-dismiss', 'persona', 'scope', 'project', 'memory-dismiss', 'ACTIVE', ?, ?)`)
        .run("2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"));
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const goal = await inbox.accept({ workbenchId: "workbench-dismiss", idempotencyKey: "key-work", text: "仍在执行" });
      database.transaction((connection) => connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES ('turn-dismiss', ?, 'workbench-dismiss', 'session-dismiss', 'RUNNING', ?, ?)`)
        .run(goal.inputId, "2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"));
      await repository.completeInput(goal.inputId, "turn-dismiss");
      database.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-dismiss', 'workbench-dismiss', ?, '执行中', '{}', 'READ', 'RUNNING', ?, ?)`)
        .run(goal.inputId, "2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"));

      expect(await repository.dismiss(goal.inputId)).toBeNull();
      database.transaction((connection) => connection.prepare("UPDATE work_items SET status = 'COMPLETED' WHERE work_id = 'work-dismiss'").run());
      expect(await repository.dismiss(goal.inputId)).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
