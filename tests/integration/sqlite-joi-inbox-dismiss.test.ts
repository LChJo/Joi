import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

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

  it("keeps a consumed goal visible while any related Work is non-terminal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-dismiss-work-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES ('avatar-dismiss', 'A', 'persona-dismiss', 'persona', 'scope', 'project', 'memory-dismiss', 'ACTIVE', ?, ?)`)
        .run("2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"));
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const goal = await inbox.accept({ avatarId: "avatar-dismiss", idempotencyKey: "key-work", text: "仍在执行" });
      database.transaction((connection) => connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
        VALUES ('turn-dismiss', ?, 'avatar-dismiss', 'session-dismiss', 'RUNNING', ?, ?)`)
        .run(goal.inputId, "2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"));
      await repository.completeInput(goal.inputId, "turn-dismiss");
      database.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, avatar_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-dismiss', 'avatar-dismiss', ?, '执行中', '{}', 'READ', 'RUNNING', ?, ?)`)
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
