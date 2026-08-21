/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { WorkbenchWorkspaceRepository, WorkbenchWorkspaceSummary } from "../../application/ports/workbench-context.js";
import { workbenchWorkspaceDisplayName } from "../../domain/workbench/workbench-naming.js";
import { DomainError } from "../../domain/errors.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function mapRow(row: Row | undefined): WorkbenchWorkspaceSummary | null {
  if (row === undefined) return null;
  if (typeof row.workspace_ref !== "string" || typeof row.kind !== "string" || typeof row.status !== "string" || typeof row.display_name !== "string") {
    throw new Error("workbench_workspace_record_invalid");
  }
  return {
    displayName: row.display_name,
    ...(typeof row.failure_reason_code === "string" ? { failureReasonCode: row.failure_reason_code } : {}),
    kind: row.kind as WorkbenchWorkspaceSummary["kind"],
    status: row.status as WorkbenchWorkspaceSummary["status"],
    workspaceRef: row.workspace_ref,
  };
}

export class SqliteWorkbenchWorkspaceRepository implements WorkbenchWorkspaceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getWorkspace(workbenchId: string): Promise<WorkbenchWorkspaceSummary | null> {
    return mapRow(this.database.transaction((connection) => connection.prepare(`SELECT workspace_ref, kind, status,
      display_name, failure_reason_code FROM workbench_workspace_bindings WHERE workbench_id = ?`).get(workbenchId)));
  }

  async hasNonTerminalFileWork(workbenchId: string): Promise<boolean> {
    const row = this.database.transaction((connection) => connection.prepare(`SELECT 1 FROM work_items w
      JOIN work_access_policies p ON p.work_id = w.work_id
      WHERE w.workbench_id = ? AND p.access_mode IN ('READ', 'WRITE')
        AND w.status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING') LIMIT 1`).get(workbenchId));
    return row !== undefined;
  }

  async bindExisting(input: { workbenchId: string; displayName: string; rootPath: string; updatedAt: string }): Promise<WorkbenchWorkspaceSummary> {
    const ref = `workbench_workspace:${input.workbenchId}`;
    try {
      this.database.transaction((connection) => {
        const conflict = connection.prepare(`SELECT b.workbench_id FROM workbench_workspace_roots r
          JOIN workbench_workspace_bindings b ON b.workspace_ref = r.workspace_ref
          WHERE r.root_path = ? AND r.workspace_ref <> ? LIMIT 1`).get(input.rootPath, ref) as { workbench_id?: unknown } | undefined;
        if (typeof conflict?.workbench_id === "string" && conflict.workbench_id !== input.workbenchId) {
          throw new DomainError("workbench_workspace_already_bound", "This workspace is already bound to another Workbench.");
        }
        connection.prepare(`INSERT INTO workbench_workspace_bindings
          (workbench_id, workspace_ref, kind, status, display_name, created_at, updated_at)
          VALUES (?, ?, 'BOUND', 'READY', ?, ?, ?)
          ON CONFLICT(workbench_id) DO UPDATE SET kind = 'BOUND', status = 'READY', display_name = excluded.display_name,
            failure_reason_code = NULL, updated_at = excluded.updated_at`).run(
          input.workbenchId, ref, input.displayName, input.updatedAt, input.updatedAt,
        );
        connection.prepare(`INSERT INTO workbench_workspace_roots (workspace_ref, root_path, created_at, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(workspace_ref) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`
        ).run(ref, input.rootPath, input.updatedAt, input.updatedAt);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("workbench_workspace_roots.root_path")) {
        throw new DomainError("workbench_workspace_already_bound", "This workspace is already bound to another Workbench.");
      }
      throw error;
    }
    const result = await this.getWorkspace(input.workbenchId);
    if (result === null) throw new Error("workbench_workspace_bind_failed");
    return result;
  }

  async requestManagedRebuild(input: { workbenchId: string; outboxId: string; updatedAt: string }): Promise<WorkbenchWorkspaceSummary> {
    const ref = `workbench_workspace:${input.workbenchId}`;
    this.database.transaction((connection) => {
      const workbench = connection.prepare("SELECT name, project_label, scope_summary FROM workbenches WHERE workbench_id = ? AND status = 'ACTIVE'").get(input.workbenchId) as { name?: unknown; project_label?: unknown; scope_summary?: unknown } | undefined;
      if (typeof workbench?.name !== "string" || typeof workbench.project_label !== "string" || typeof workbench.scope_summary !== "string") throw new Error("workbench_not_found");
      const displayName = workbenchWorkspaceDisplayName({ name: workbench.name, projectLabel: workbench.project_label, scopeSummary: workbench.scope_summary });
      connection.prepare("DELETE FROM workbench_workspace_roots WHERE workspace_ref = ?").run(ref);
      connection.prepare(`INSERT INTO workbench_workspace_bindings
        (workbench_id, workspace_ref, kind, status, display_name, created_at, updated_at)
        VALUES (?, ?, 'MANAGED', 'PROVISIONING', ?, ?, ?)
        ON CONFLICT(workbench_id) DO UPDATE SET kind = 'MANAGED', status = 'PROVISIONING',
          display_name = excluded.display_name, failure_reason_code = NULL, updated_at = excluded.updated_at`).run(
        input.workbenchId, ref, displayName, input.updatedAt, input.updatedAt,
      );
      connection.prepare(`INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
        VALUES (?, 'workbench.workspace.provision', ?, 'PENDING', 0, ?, ?)`
      ).run(input.outboxId, JSON.stringify({ workbenchId: input.workbenchId, workspaceRef: ref }), input.updatedAt, input.updatedAt);
    });
    const result = await this.getWorkspace(input.workbenchId);
    if (result === null) throw new Error("workbench_workspace_rebuild_failed");
    return result;
  }
}
