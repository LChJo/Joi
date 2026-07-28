import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock } from "../support/runtime-fixture.js";

describe("workspace lease lifecycle", () => {
  it("shares reads, excludes writes, releases terminal work and recovers expired leases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workspace-lease-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO avatars
          (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES ('avatar', 'Avatar', 'persona', 'Persona', 'Scope', 'Project', 'memory', '', 'ACTIVE', ?, ?)`).run(clock.now().toISOString(), clock.now().toISOString());
        const insert = connection.prepare(`INSERT INTO work_items
          (work_id, avatar_id, title, intent_json, access_mode, workspace_ref, status, created_at, updated_at)
          VALUES (?, 'avatar', ?, '{}', ?, 'workspace_ref', 'READY', ?, ?)`);
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
