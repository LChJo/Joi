import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("sqlite joi inbox clarify", () => {
  it("re-queues a clarified input with the chosen Avatar and refuses non-clarification rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-clarify-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      database.transaction((connection) => connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "av-1", "前端搭档", "pr-1", "persona", "scope", "proj", "ns-1", "ACTIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      ));
      const accepted = await inbox.accept({ idempotencyKey: "key-1", text: "研究登录改造" });

      expect(await repository.clarify("does-not-exist", { avatarId: "av-1" })).toBeNull();
      expect(await repository.clarify(accepted.inputId, { avatarId: "av-1" })).toBeNull();

      await repository.requireClarification(accepted.inputId, "avatar_selection_invalid");
      const clarified = await repository.clarify(accepted.inputId, { avatarId: "av-1" });
      expect(clarified).toMatchObject({ avatarId: "av-1", body: "研究登录改造", inputId: accepted.inputId, status: "PENDING" });
      expect(clarified?.clarificationReasonCode).toBeUndefined();
      expect(await repository.clarify(accepted.inputId, { text: "too late" })).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("appends supplementary text to the stored body before re-queuing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-clarify-text-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-2", text: "归属？" });
      await repository.requireClarification(accepted.inputId, "avatar_selection_invalid");
      const clarified = await repository.clarify(accepted.inputId, { text: "是登录模块" });
      expect(clarified?.body).toBe("归属？\n\n[用户补充] 是登录模块");
      expect(clarified?.status).toBe("PENDING");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
