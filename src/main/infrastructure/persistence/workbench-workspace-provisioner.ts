import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { DurableUiEventEmitter, OutboxRecord } from "../../application/ports/runtime-store.js";
import { workspaceDirectoryName } from "../../domain/workbench/workbench-naming.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export class WorkbenchWorkspaceProvisioner {
  constructor(private readonly dependencies: { database: TransactionalDatabase; events?: DurableUiEventEmitter; userDataDirectory: string }) {}

  async handle(record: OutboxRecord): Promise<void> {
    const workbenchId = record.payload.workbenchId;
    const workspaceRef = record.payload.workspaceRef;
    if (typeof workbenchId !== "string" || typeof workspaceRef !== "string") throw new Error("workbench_workspace_outbox_invalid");
    const managedDirectoryName = (): string | null => this.dependencies.database.transaction((connection) => {
      const binding = connection.prepare("SELECT kind, display_name FROM workbench_workspace_bindings WHERE workbench_id = ? AND workspace_ref = ?")
        .get(workbenchId, workspaceRef) as { kind?: unknown; display_name?: unknown } | undefined;
      if (binding?.kind !== "MANAGED" || typeof binding.display_name !== "string") return null;
      return workspaceDirectoryName(binding.display_name);
    });
    const directoryName = managedDirectoryName();
    if (directoryName === null) return;
    const key = createHash("sha256").update(workbenchId).digest("hex").slice(0, 24);
    const generation = createHash("sha256").update(record.outboxId).digest("hex").slice(0, 16);
    const rootPath = path.join(this.dependencies.userDataDirectory, "workbenches", key, "workspaces", generation, directoryName);
    try {
      await mkdir(rootPath, { recursive: true });
      const applied = this.dependencies.database.transaction((connection) => {
        const binding = connection.prepare("SELECT kind FROM workbench_workspace_bindings WHERE workbench_id = ? AND workspace_ref = ?")
          .get(workbenchId, workspaceRef) as { kind?: unknown } | undefined;
        if (binding?.kind !== "MANAGED") return false;
        const now = new Date().toISOString();
        connection.prepare(`INSERT INTO workbench_workspace_roots (workspace_ref, root_path, created_at, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(workspace_ref) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`
        ).run(workspaceRef, rootPath, now, now);
        connection.prepare(`UPDATE workbench_workspace_bindings SET status = 'READY', failure_reason_code = NULL, updated_at = ?
          WHERE workbench_id = ? AND workspace_ref = ? AND kind = 'MANAGED'`).run(now, workbenchId, workspaceRef);
        return true;
      });
      if (!applied) return;
    } catch {
      this.dependencies.database.transaction((connection) => connection.prepare(`UPDATE workbench_workspace_bindings
        SET status = 'FAILED', failure_reason_code = 'workbench_workspace_provision_failed', updated_at = ?
        WHERE workbench_id = ? AND workspace_ref = ? AND kind = 'MANAGED'`).run(new Date().toISOString(), workbenchId, workspaceRef));
      try {
        await this.dependencies.events?.emit("workbench.workspace.changed", workbenchId, {
          workbenchId, failureReasonCode: "workbench_workspace_provision_failed", kind: "MANAGED", status: "FAILED",
        });
      } catch { /* Keep the outbox error stable; retry will attempt the durable event again. */ }
      throw new Error("workbench_workspace_provision_failed");
    }
    await this.dependencies.events?.emit("workbench.workspace.changed", workbenchId, { workbenchId, kind: "MANAGED", status: "READY" });
  }
}
