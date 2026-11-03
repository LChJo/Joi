import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkbenchChangeService } from "../../src/main/application/joi/workbench-change-service.js";
import { SqliteWorkbenchChangeRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-change-repository.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

describe("Workbench destructive change confirmation", () => {
  it("never archives or merges before confirmation and preserves source facts after merge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workbench-change-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      const now = "2026-07-15T12:00:00.000Z";
      database.transaction((connection) => {
        const insert = connection.prepare(`INSERT INTO workbenches
          (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
           memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`);
        insert.run("workbench-source", "Source", "persona-source", "private source persona", "source scope", "Source project", "memory-source", "source task", now, now);
        insert.run("workbench-target", "Target", "persona-target", "target persona", "target scope", "Target project", "memory-target", "target task", now, now);
      });
      const service = new WorkbenchChangeService({
        clock: new TestClock(now), ids: new TestIds(), repository: new SqliteWorkbenchChangeRepository(database),
      });

      const rejected = await service.suggestArchive({ workbenchId: "workbench-source", reason: "No longer used", turnId: "turn-1" });
      expect(rejected.status).toBe("PENDING");
      expect(database.transaction((connection) => connection.prepare("SELECT status FROM workbenches WHERE workbench_id = 'workbench-source'").get())).toEqual({ status: "ACTIVE" });
      await service.decide({ decision: "REJECT", requestId: rejected.requestId });
      expect(database.transaction((connection) => connection.prepare("SELECT status FROM workbenches WHERE workbench_id = 'workbench-source'").get())).toEqual({ status: "ACTIVE" });

      const merge = await service.suggestMerge({
        reason: "These contexts are now one", sourceWorkbenchId: "workbench-source", targetWorkbenchId: "workbench-target", turnId: "turn-2",
      });
      expect(await service.listPending()).toEqual([merge]);
      const confirmed = await service.decide({ decision: "CONFIRM", requestId: merge.requestId });
      expect(confirmed.status).toBe("CONFIRMED");
      expect(database.transaction((connection) => connection.prepare("SELECT status, persona_summary, task_summary FROM workbenches WHERE workbench_id = 'workbench-source'").get())).toEqual({
        persona_summary: "private source persona", status: "ARCHIVED", task_summary: "source task",
      });
      expect(database.transaction((connection) => connection.prepare("SELECT source_workbench_id, target_workbench_id FROM workbench_merges").get())).toEqual({
        source_workbench_id: "workbench-source", target_workbench_id: "workbench-target",
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses confirmation while the source Workbench owns nonterminal work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workbench-change-work-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      const now = "2026-07-15T12:00:00.000Z";
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO workbenches
          (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES ('workbench-busy', 'Busy', 'persona', 'persona', 'scope', 'project', 'memory', '', 'ACTIVE', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('input-running', 'key-running', 'Running', 'ROUTED', 'workbench-busy', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-running', 'input-running', 'workbench-busy', 'session-running', 'RUNNING', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-running', 'workbench-busy', 'input-running', 'Running', '{}', 'READ', 'RUNNING', ?, ?)`).run(now, now);
      });
      const service = new WorkbenchChangeService({ clock: new TestClock(now), ids: new TestIds(), repository: new SqliteWorkbenchChangeRepository(database) });
      const request = await service.suggestArchive({ workbenchId: "workbench-busy", reason: "cleanup", turnId: "turn" });
      await expect(service.decide({ decision: "CONFIRM", requestId: request.requestId })).rejects.toMatchObject({ code: "workbench_change_active_work" });
      expect((await service.listPending()).map((item) => item.requestId)).toContain(request.requestId);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
