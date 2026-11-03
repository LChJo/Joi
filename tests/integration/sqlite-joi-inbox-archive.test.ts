import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

async function withDatabase<T>(prefix: string, run: (database: Awaited<ReturnType<typeof openRuntimeDatabase>>, repository: SqliteJoiInboxRepository, inbox: JoiInboxService) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
  try {
    const repository = new SqliteJoiInboxRepository(database);
    return await run(database, repository, new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository }));
  } finally {
    database.close();
    await rm(root, { force: true, recursive: true });
  }
}

describe("sqlite joi inbox archive", () => {
  it("archives only terminal inputs and leaves list() alone", async () => {
    await withDatabase("joi-archive-", async (_database, repository, inbox) => {
      const completed = await inbox.accept({ idempotencyKey: "key-1", text: "已完成的事" });
      const live = await inbox.accept({ idempotencyKey: "key-2", text: "排队中的事" });
      await repository.completeInput(completed.inputId, "turn-ghost");

      expect(await repository.archive("does-not-exist")).toBeNull();
      expect(await repository.archive(live.inputId)).toBeNull();

      const archived = await repository.archive(completed.inputId);
      expect(archived).toMatchObject({ inputId: completed.inputId, status: "CONSUMED" });
      expect(typeof archived?.archivedAt).toBe("string");
      expect(await repository.archive(completed.inputId)).toBeNull();

      // Unlike a removal, an archived goal is still a live fact: it survives in the inbox listing
      // and in a backup, which is what makes unarchiving possible at all.
      const listed = await repository.list();
      expect(listed.map((record) => record.inputId)).toContain(live.inputId);
      expect(listed.find((record) => record.inputId === completed.inputId)?.archivedAt).toBeDefined();
    });
  });

  it("keeps archiving out of reach while any related Work is non-terminal", async () => {
    await withDatabase("joi-archive-work-", async (database, repository, inbox) => {
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench-archive', 'A', 'persona-archive', 'persona', 'scope', 'project', 'memory-archive', 'ACTIVE', ?, ?)`)
        .run("2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"));
      const goal = await inbox.accept({ workbenchId: "workbench-archive", idempotencyKey: "key-work", text: "仍在执行" });
      database.transaction((connection) => connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES ('turn-archive', ?, 'workbench-archive', 'session-archive', 'RUNNING', ?, ?)`)
        .run(goal.inputId, "2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"));
      await repository.completeInput(goal.inputId, "turn-archive");
      database.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-archive', 'workbench-archive', ?, '执行中', '{}', 'READ', 'RUNNING', ?, ?)`)
        .run(goal.inputId, "2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z"));

      expect(await repository.archive(goal.inputId)).toBeNull();
      database.transaction((connection) => connection.prepare("UPDATE work_items SET status = 'COMPLETED' WHERE work_id = 'work-archive'").run());
      // A terminal Work with no finalized outcome is still archivable — that is the whole point of
      // offering archiving one step earlier than removal.
      expect(await repository.archive(goal.inputId)).toMatchObject({ inputId: goal.inputId });
    });
  });

  it("unarchives, and round-trips through the service", async () => {
    await withDatabase("joi-archive-service-", async (_database, repository, inbox) => {
      const accepted = await inbox.accept({ idempotencyKey: "key-3", text: "归档再放回" });
      await repoComplete(repository, accepted.inputId);

      await expect(inbox.unarchive({ inputId: accepted.inputId })).rejects.toMatchObject({ code: "joi_unarchive_unavailable" });
      await inbox.archive({ inputId: accepted.inputId });
      const restored = await inbox.unarchive({ inputId: accepted.inputId });
      expect(restored).toMatchObject({ inputId: accepted.inputId });
      const listed = await repository.list();
      expect(listed.find((record) => record.inputId === accepted.inputId)?.archivedAt).toBeUndefined();
      await expect(inbox.unarchive({ inputId: accepted.inputId })).rejects.toMatchObject({ code: "joi_unarchive_unavailable" });
    });
  });

  it("rejects archiving a live goal through the service", async () => {
    await withDatabase("joi-archive-live-", async (_database, _repository, inbox) => {
      const live = await inbox.accept({ idempotencyKey: "key-4", text: "还活着" });
      await expect(inbox.archive({ inputId: live.inputId })).rejects.toMatchObject({ code: "joi_archive_unavailable" });
    });
  });

  it("clears the archive marker when the goal is continued again", async () => {
    await withDatabase("joi-archive-retry-", async (_database, repository, inbox) => {
      const accepted = await inbox.accept({ idempotencyKey: "key-5", text: "归档后继续" });
      await repoComplete(repository, accepted.inputId);
      await repository.archive(accepted.inputId);
      expect((await repository.list()).find((record) => record.inputId === accepted.inputId)?.archivedAt).toBeDefined();

      // Retrying revives the goal, and a revived goal has to come back to the home feed: leaving the
      // marker set would keep a running task invisible behind the archive.
      expect(await repository.retry(accepted.inputId, { text: "再补一轮" })).not.toBeNull();
      expect((await repository.list()).find((record) => record.inputId === accepted.inputId)?.archivedAt).toBeUndefined();
    });
  });
});

/** `completeInput` is the only way a test can put a goal into the terminal state archiving requires. */
async function repoComplete(repository: SqliteJoiInboxRepository, inputId: string): Promise<void> {
  await repository.completeInput(inputId, `turn-${inputId}`);
}
