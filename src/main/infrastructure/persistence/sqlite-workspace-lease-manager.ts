/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { Clock } from "../../application/ports/runtime-store.js";
import type { WorkAccessMode } from "../../domain/work/work.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export interface WorkspaceLease {
  accessMode: WorkAccessMode;
  expiresAt: string;
  generation: number;
  owner: string;
  workId: string;
  workspaceRef: string;
}

export class SqliteWorkspaceLeaseManager {
  constructor(private readonly dependencies: {
    clock: Clock;
    database: TransactionalDatabase;
    leaseMilliseconds?: number;
    owner?: string;
  }) {}

  async acquire(input: { accessMode: WorkAccessMode; workId: string; workspaceRef: string }): Promise<WorkspaceLease | null> {
    const now = this.dependencies.clock.now();
    const nowText = now.toISOString();
    const expiresAt = new Date(now.getTime() + (this.dependencies.leaseMilliseconds ?? 10 * 60_000)).toISOString();
    const owner = this.dependencies.owner ?? `joi:${input.workId}`;
    return this.dependencies.database.transaction((connection) => {
      connection.prepare("DELETE FROM workspace_leases WHERE expires_at <= ?").run(nowText);
      const conflict = connection.prepare(`SELECT 1 FROM workspace_leases held
        WHERE held.work_id <> ? AND (held.access_mode = 'WRITE' OR ? = 'WRITE')
          AND (held.workspace_ref = ? OR COALESCE(
            (SELECT root_path FROM work_run_directories WHERE work_id = ?),
            (SELECT root_path FROM workbench_workspace_roots WHERE workspace_ref = ?)
          ) = COALESCE(
            (SELECT root_path FROM work_run_directories WHERE work_id = held.work_id),
            (SELECT root_path FROM workbench_workspace_roots WHERE workspace_ref = held.workspace_ref)
          ))
        LIMIT 1`).get(input.workId, input.accessMode, input.workspaceRef, input.workId, input.workspaceRef);
      if (conflict !== undefined) return null;
      const current = connection.prepare("SELECT generation FROM workspace_leases WHERE workspace_ref = ? AND work_id = ?")
        .get(input.workspaceRef, input.workId) as { generation?: unknown } | undefined;
      const generation = typeof current?.generation === "number" ? current.generation + 1 : 1;
      connection.prepare(`INSERT INTO workspace_leases
        (workspace_ref, work_id, access_mode, lease_owner, generation, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_ref, work_id) DO UPDATE SET
          access_mode = excluded.access_mode,
          lease_owner = excluded.lease_owner,
          generation = excluded.generation,
          expires_at = excluded.expires_at`).run(
        input.workspaceRef, input.workId, input.accessMode, owner, generation, expiresAt,
      );
      return { accessMode: input.accessMode, expiresAt, generation, owner, workId: input.workId, workspaceRef: input.workspaceRef };
    });
  }

  /**
   * Extends a still-live lease for the owning work. Returns null when the lease row is
   * missing or already expired; callers must treat that as lost workspace exclusivity.
   */
  async renew(input: { workId: string; workspaceRef: string }): Promise<WorkspaceLease | null> {
    const now = this.dependencies.clock.now();
    const nowText = now.toISOString();
    const expiresAt = new Date(now.getTime() + (this.dependencies.leaseMilliseconds ?? 10 * 60_000)).toISOString();
    return this.dependencies.database.transaction((connection) => {
      const updated = connection.prepare(`UPDATE workspace_leases
        SET expires_at = ?
      WHERE work_id = ? AND workspace_ref = ? AND expires_at > ?`).run(
        expiresAt, input.workId, input.workspaceRef, nowText,
      );
      if (updated.changes === 0) return null;
      const row = connection.prepare(`SELECT access_mode, lease_owner, generation
        FROM workspace_leases WHERE workspace_ref = ? AND work_id = ?`).get(
        input.workspaceRef, input.workId,
      ) as { access_mode?: unknown; generation?: unknown; lease_owner?: unknown } | undefined;
      if (row === undefined) return null;
      return {
        accessMode: String(row.access_mode) as WorkAccessMode,
        expiresAt,
        generation: typeof row.generation === "number" ? row.generation : 1,
        owner: typeof row.lease_owner === "string" ? row.lease_owner : "",
        workId: input.workId,
        workspaceRef: input.workspaceRef,
      };
    });
  }

  async release(workId: string): Promise<void> {
    this.dependencies.database.transaction((connection) => {
      connection.prepare("DELETE FROM workspace_leases WHERE work_id = ?").run(workId);
    });
  }
}
