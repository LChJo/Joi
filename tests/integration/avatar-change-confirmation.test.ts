import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AvatarChangeService } from "../../src/main/application/joi/avatar-change-service.js";
import { SqliteAvatarChangeRepository } from "../../src/main/infrastructure/persistence/sqlite-avatar-change-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("Avatar destructive change confirmation", () => {
  it("never archives or merges before confirmation and preserves source facts after merge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-avatar-change-"));
    const database = await openRuntimeDatabase({
      databasePath: path.join(root, "runtime.sqlite"),
      migrationsDirectory: path.resolve("resources/migrations"),
    });
    try {
      const now = "2026-07-15T12:00:00.000Z";
      database.transaction((connection) => {
        const insert = connection.prepare(`INSERT INTO avatars
          (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
           memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`);
        insert.run("avatar-source", "Source", "persona-source", "private source persona", "source scope", "Source project", "memory-source", "source task", now, now);
        insert.run("avatar-target", "Target", "persona-target", "target persona", "target scope", "Target project", "memory-target", "target task", now, now);
      });
      const service = new AvatarChangeService({
        clock: new TestClock(now), ids: new TestIds(), repository: new SqliteAvatarChangeRepository(database),
      });

      const rejected = await service.suggestArchive({ avatarId: "avatar-source", reason: "No longer used", turnId: "turn-1" });
      expect(rejected.status).toBe("PENDING");
      expect(database.transaction((connection) => connection.prepare("SELECT status FROM avatars WHERE avatar_id = 'avatar-source'").get())).toEqual({ status: "ACTIVE" });
      await service.decide({ decision: "REJECT", requestId: rejected.requestId });
      expect(database.transaction((connection) => connection.prepare("SELECT status FROM avatars WHERE avatar_id = 'avatar-source'").get())).toEqual({ status: "ACTIVE" });

      const merge = await service.suggestMerge({
        reason: "These contexts are now one", sourceAvatarId: "avatar-source", targetAvatarId: "avatar-target", turnId: "turn-2",
      });
      expect(await service.listPending()).toEqual([merge]);
      const confirmed = await service.decide({ decision: "CONFIRM", requestId: merge.requestId });
      expect(confirmed.status).toBe("CONFIRMED");
      expect(database.transaction((connection) => connection.prepare("SELECT status, persona_summary, task_summary FROM avatars WHERE avatar_id = 'avatar-source'").get())).toEqual({
        persona_summary: "private source persona", status: "ARCHIVED", task_summary: "source task",
      });
      expect(database.transaction((connection) => connection.prepare("SELECT source_avatar_id, target_avatar_id FROM avatar_merges").get())).toEqual({
        source_avatar_id: "avatar-source", target_avatar_id: "avatar-target",
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses confirmation while the source Avatar owns nonterminal work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-avatar-change-work-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const now = "2026-07-15T12:00:00.000Z";
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO avatars
          (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES ('avatar-busy', 'Busy', 'persona', 'persona', 'scope', 'project', 'memory', '', 'ACTIVE', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, avatar_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-running', 'avatar-busy', 'Running', '{}', 'READ', 'RUNNING', ?, ?)`).run(now, now);
      });
      const service = new AvatarChangeService({ clock: new TestClock(now), ids: new TestIds(), repository: new SqliteAvatarChangeRepository(database) });
      const request = await service.suggestArchive({ avatarId: "avatar-busy", reason: "cleanup", turnId: "turn" });
      await expect(service.decide({ decision: "CONFIRM", requestId: request.requestId })).rejects.toMatchObject({ code: "avatar_change_active_work" });
      expect((await service.listPending()).map((item) => item.requestId)).toContain(request.requestId);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
