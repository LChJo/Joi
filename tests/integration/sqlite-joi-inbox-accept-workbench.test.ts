import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

describe("sqlite joi inbox accept workbench", () => {
  it("persists a user-chosen Workbench on accept and leaves autonomous inputs unscoped", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-accept-workbench-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "workbench-1", "前端搭档", "pr-1", "persona", "scope", "proj", "ns-1", "ACTIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      ));
      const targeted = await inbox.accept({ workbenchId: " workbench-1 ", idempotencyKey: "key-targeted", text: "发布一版" });
      const autonomous = await inbox.accept({ idempotencyKey: "key-autonomous", text: "研究登录改造" });

      expect(targeted).toMatchObject({ workbenchId: "workbench-1", status: "PENDING" });
      expect(autonomous.workbenchId).toBeUndefined();
      expect(await repository.loadInput(targeted.inputId)).toMatchObject({ workbenchId: "workbench-1" });
      await expect(inbox.accept({ workbenchId: "x".repeat(161), idempotencyKey: "key-too-long", text: "bad" }))
        .rejects.toMatchObject({ code: "joi_workbench_invalid" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
