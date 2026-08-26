import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock } from "../support/runtime-fixture.js";

describe("workspace lease lifecycle", () => {
  it("coordinates conflicting access across Workbench refs that share one physical root", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE workbench_workspace_roots (workspace_ref TEXT PRIMARY KEY, root_path TEXT NOT NULL);
      CREATE TABLE workspace_leases (
        workspace_ref TEXT NOT NULL, work_id TEXT NOT NULL, access_mode TEXT NOT NULL,
        lease_owner TEXT NOT NULL, generation INTEGER NOT NULL, expires_at TEXT NOT NULL,
        PRIMARY KEY (workspace_ref, work_id)
      );
      INSERT INTO workbench_workspace_roots VALUES
        ('workbench_workspace:a', 'C:\\projects\\shared'),
        ('workbench_workspace:b', 'C:\\projects\\shared');
    `);
    try {
      const clock = new TestClock();
      const leases = new SqliteWorkspaceLeaseManager({
        clock,
        database: { transaction: (operation) => operation(database) },
        leaseMilliseconds: 30_000,
      });
      await expect(leases.acquire({ accessMode: "WRITE", workId: "write_a", workspaceRef: "workbench_workspace:a" }))
        .resolves.toMatchObject({ generation: 1 });
      await expect(leases.acquire({ accessMode: "READ", workId: "read_b", workspaceRef: "workbench_workspace:b" }))
        .resolves.toBeNull();
      clock.advance(31_000);
      await expect(leases.acquire({ accessMode: "WRITE", workId: "write_b", workspaceRef: "workbench_workspace:b" }))
        .resolves.toMatchObject({ generation: 1 });
    } finally {
      database.close();
    }
  });

  it("shares reads, excludes writes, releases terminal work and recovers expired leases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workspace-lease-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO workbenches
          (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES ('workbench', 'Workbench', 'persona', 'Persona', 'Scope', 'Project', 'memory', '', 'ACTIVE', ?, ?)`).run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('input-leases', 'key-leases', 'leases', 'ROUTED', 'workbench', ?, ?)`)
          .run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-leases', 'input-leases', 'workbench', 'session-leases', 'RUNNING', ?, ?)`)
          .run(clock.now().toISOString(), clock.now().toISOString());
        const insert = connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, workspace_ref, status, created_at, updated_at)
          VALUES (?, 'workbench', 'input-leases', ?, '{}', ?, 'workspace_ref', 'READY', ?, ?)`);
        for (const [workId, mode] of [["read_1", "READ"], ["read_2", "READ"], ["write_1", "WRITE"], ["write_2", "WRITE"]] as const) {
          insert.run(workId, workId, mode, clock.now().toISOString(), clock.now().toISOString());
        }
      });
      const leases = new SqliteWorkspaceLeaseManager({ clock, database, leaseMilliseconds: 30_000 });
      await expect(leases.acquire({ accessMode: "READ", workId: "read_1", workspaceRef: "workspace_ref" })).resolves.toMatchObject({ generation: 1 });
      await expect(leases.acquire({ accessMode: "READ", workId: "read_2", workspaceRef: "workspace_ref" })).resolves.toMatchObject({ generation: 1 });
      await expect(leases.acquire({ accessMode: "WRITE", workId: "write_1", workspaceRef: "workspace_ref" })).resolves.toBeNull();
      await leases.release("read_1");
      await leases.release("read_2");
      await expect(leases.acquire({ accessMode: "WRITE", workId: "write_1", workspaceRef: "workspace_ref" })).resolves.toMatchObject({ generation: 1 });
      await expect(leases.acquire({ accessMode: "READ", workId: "read_1", workspaceRef: "workspace_ref" })).resolves.toBeNull();
      clock.advance(31_000);
      await expect(leases.acquire({ accessMode: "WRITE", workId: "write_2", workspaceRef: "workspace_ref" })).resolves.toMatchObject({ generation: 1 });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
