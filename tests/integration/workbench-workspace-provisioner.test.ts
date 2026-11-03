import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkbenchWorkspaceProvisioner } from "../../src/main/infrastructure/persistence/workbench-workspace-provisioner.js";
import { WorkbenchRegistryService } from "../../src/main/application/joi/workbench-registry-service.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

const outboxRecord = {
  attemptCount: 0,
  availableAt: "2026-08-02T00:00:00.000Z",
  createdAt: "2026-08-02T00:00:00.000Z",
  kind: "workbench.workspace.provision",
  outboxId: "provision-test",
  payload: { workbenchId: "workbench-workspace", workspaceRef: "workbench_workspace:workbench-workspace" },
  status: "PENDING" as const,
};

describe("WorkbenchWorkspaceProvisioner", () => {
  it("assigns the frontend debugging environment label during Workbench creation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workbench-naming-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      let sequence = 0;
      const workbench = await new WorkbenchRegistryService({
        clock: { now: () => new Date("2026-08-02T00:00:00.000Z") },
        ids: { next: (prefix: string) => `${prefix}_${String(++sequence)}` },
        repository: new LegacyLifeStoreAdapter(database),
      }).create({ name: "前端调试分析", personaSummary: "前端上下文", projectLabel: "数字生活", scopeSummary: "前端调试与分析" });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT display_name FROM workbench_workspace_bindings WHERE workbench_id = ?",
      ).get(workbench.workbenchId))).toEqual({ display_name: "aimanadebug" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("creates a managed directory idempotently, records failures, and supports retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workbench-workspace-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
         memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench-workspace', 'A', 'persona-workspace', 'persona', 'scope', 'project', 'memory-workspace',
                'ACTIVE', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z')`).run());
      database.transaction((connection) => connection.prepare(`UPDATE workbench_workspace_bindings
        SET display_name = 'aimanadebug' WHERE workbench_id = 'workbench-workspace'`).run());

      const userData = path.join(root, "user-data");
      const provisioner = new WorkbenchWorkspaceProvisioner({ database, userDataDirectory: userData });
      await provisioner.handle(outboxRecord);
      const first = database.transaction((connection) => connection.prepare(`SELECT b.status, r.root_path
        FROM workbench_workspace_bindings b JOIN workbench_workspace_roots r ON r.workspace_ref = b.workspace_ref
        WHERE b.workbench_id = 'workbench-workspace'`).get()) as { root_path: string; status: string };
      expect(first.status).toBe("READY");
      expect(path.basename(first.root_path)).toBe("aimanadebug");
      await expect(stat(first.root_path)).resolves.toMatchObject({});
      await provisioner.handle(outboxRecord);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT root_path FROM workbench_workspace_roots WHERE workspace_ref = 'workbench_workspace:workbench-workspace'",
      ).get())).toEqual({ root_path: first.root_path });

      await writeFile(path.join(first.root_path, "old-generation.txt"), "old", "utf8");
      await provisioner.handle({ ...outboxRecord, outboxId: "provision-rebuild" });
      const rebuilt = database.transaction((connection) => connection.prepare(
        "SELECT root_path FROM workbench_workspace_roots WHERE workspace_ref = 'workbench_workspace:workbench-workspace'",
      ).get()) as { root_path: string };
      expect(rebuilt.root_path).not.toBe(first.root_path);
      await expect(stat(path.join(rebuilt.root_path, "old-generation.txt"))).rejects.toMatchObject({ code: "ENOENT" });

      const blockedRoot = path.join(root, "not-a-directory");
      await writeFile(blockedRoot, "blocked", "utf8");
      await expect(new WorkbenchWorkspaceProvisioner({ database, userDataDirectory: blockedRoot }).handle(outboxRecord))
        .rejects.toThrow("workbench_workspace_provision_failed");
      expect(database.transaction((connection) => connection.prepare(
        "SELECT failure_reason_code, status FROM workbench_workspace_bindings WHERE workbench_id = 'workbench-workspace'",
      ).get())).toEqual({ failure_reason_code: "workbench_workspace_provision_failed", status: "FAILED" });

      await provisioner.handle(outboxRecord);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT failure_reason_code, status FROM workbench_workspace_bindings WHERE workbench_id = 'workbench-workspace'",
      ).get())).toEqual({ failure_reason_code: null, status: "READY" });

      database.transaction((connection) => connection.prepare(
        "UPDATE workbench_workspace_bindings SET kind = 'BOUND', status = 'READY' WHERE workbench_id = 'workbench-workspace'",
      ).run());
      await provisioner.handle({ ...outboxRecord, outboxId: "stale-managed-provision" });
      expect(database.transaction((connection) => connection.prepare(
        "SELECT root_path FROM workbench_workspace_roots WHERE workspace_ref = 'workbench_workspace:workbench-workspace'",
      ).get())).toEqual({ root_path: first.root_path });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
