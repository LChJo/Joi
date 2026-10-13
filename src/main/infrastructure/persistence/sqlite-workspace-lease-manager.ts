/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { realpathSync } from "node:fs";
import { decideWorkspaceAdmission } from "../../domain/work/workspace-write-scheduling.js";

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

  async acquire(input: { accessMode: WorkAccessMode; workId: string; workspaceRef: string; preserveQueue?: boolean; admit?: (connection: DatabaseSync) => (() => void) | null }): Promise<WorkspaceLease | null> {
    return this.dependencies.database.transaction(connection => {
      const commit = input.admit?.(connection);
      if (commit === null) return null;
      const lease = this.#acquire(connection, input);
      if (lease !== null) commit?.();
      return lease;
    });
  }

  #acquire(connection: DatabaseSync, input: { accessMode: WorkAccessMode; workId: string; workspaceRef: string; preserveQueue?: boolean }): WorkspaceLease | null {
    const now = this.dependencies.clock.now();
    const nowText = now.toISOString();
    const expiresAt = new Date(now.getTime() + (this.dependencies.leaseMilliseconds ?? 10 * 60_000)).toISOString();
    const owner = this.dependencies.owner ?? `joi:${input.workId}`;

    connection.prepare("DELETE FROM workspace_leases WHERE expires_at <= ?").run(nowText);
    const rootKey = this.#rootKey(connection, input);
    const hasRootKey = connection.prepare("PRAGMA table_info(workspace_leases)").all().some(row => row.name === "root_key");
    const owned = connection.prepare("SELECT generation, access_mode FROM workspace_leases WHERE workspace_ref = ? AND work_id = ?")
      .get(input.workspaceRef, input.workId);
    if (owned?.access_mode === "WRITE" && input.accessMode === "WRITE") {
      connection.prepare("UPDATE workspace_leases SET expires_at = ? WHERE workspace_ref = ? AND work_id = ?").run(expiresAt, input.workspaceRef, input.workId);
      return { accessMode: "WRITE", expiresAt, generation: Number(owned.generation), owner, workId: input.workId, workspaceRef: input.workspaceRef };
    }
    const held = connection.prepare(`SELECT work_id, workspace_ref, access_mode, ${hasRootKey ? "root_key" : "NULL AS root_key"} FROM workspace_leases WHERE work_id <> ?`)
      .all(input.workId).filter(row => (typeof row.root_key === "string" ? row.root_key : this.#rootKey(connection, { workId: String(row.work_id), workspaceRef: String(row.workspace_ref) })) === rootKey);
    const queueAvailable = connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspace_write_waiters'").get() !== undefined;
    if (queueAvailable && connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'work_items'").get() !== undefined) {
      connection.prepare(`DELETE FROM workspace_write_waiters WHERE work_id IN (SELECT work_id FROM work_items WHERE status IN ('CANCELED','FAILED','COMPLETED'))`).run();
    }
    const first = queueAvailable ? connection.prepare("SELECT work_id FROM workspace_write_waiters WHERE root_key = ? ORDER BY sequence LIMIT 1").get(rootKey) : undefined;
    if (!decideWorkspaceAdmission({ access: input.accessMode === "WRITE" ? "WRITE" : "READ",
      otherReaders: held.filter(row => row.access_mode !== "WRITE").length,
      writerHeld: held.some(row => row.access_mode === "WRITE"),
      earlierWriter: first !== undefined && (input.accessMode !== "WRITE" || first.work_id !== input.workId),
    })) return null;
    const current = connection.prepare("SELECT generation FROM workspace_leases WHERE workspace_ref = ? AND work_id = ?")
      .get(input.workspaceRef, input.workId) as { generation?: unknown } | undefined;
    const hasGenerations = connection.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspace_lease_generations'").get() !== undefined;
    const prior = hasGenerations ? connection.prepare("SELECT generation FROM workspace_lease_generations WHERE work_id = ?").get(input.workId) : current;
    const generation = typeof prior?.generation === "number" ? prior.generation + 1 : 1;
    if (hasGenerations) connection.prepare(`INSERT INTO workspace_lease_generations VALUES (?, ?)
      ON CONFLICT(work_id) DO UPDATE SET generation = excluded.generation`).run(input.workId, generation);
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
    if (hasRootKey) connection.prepare("UPDATE workspace_leases SET root_key = ? WHERE work_id = ? AND workspace_ref = ?").run(rootKey, input.workId, input.workspaceRef);
    if (queueAvailable && input.accessMode === "WRITE" && !input.preserveQueue) connection.prepare("DELETE FROM workspace_write_waiters WHERE work_id = ?").run(input.workId);
    return { accessMode: input.accessMode, expiresAt, generation, owner, workId: input.workId, workspaceRef: input.workspaceRef };
  }

  /**
   * Extends a still-live lease for the owning work. Returns null when the lease row is
   * missing or already expired; callers must treat that as lost workspace exclusivity.
   */
  async renew(input: { workId: string; workspaceRef: string; generation?: number }): Promise<WorkspaceLease | null> {
    const now = this.dependencies.clock.now();
    const nowText = now.toISOString();
    const expiresAt = new Date(now.getTime() + (this.dependencies.leaseMilliseconds ?? 10 * 60_000)).toISOString();
    return this.dependencies.database.transaction((connection) => {
      const updated = connection.prepare(`UPDATE workspace_leases
        SET expires_at = ?
      WHERE work_id = ? AND workspace_ref = ? AND expires_at > ? AND (? IS NULL OR generation = ?)`).run(
        expiresAt, input.workId, input.workspaceRef, nowText, input.generation ?? null, input.generation ?? null,
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

  /** The checkpoint must be durable and all tool operations settled before this transaction. */
  async requestWrite(input: { workId: string; workspaceRef: string; generation: number }, persistCheckpoint?: (connection: DatabaseSync) => void): Promise<WorkspaceLease | null> {
    return this.dependencies.database.transaction(connection => {
      persistCheckpoint?.(connection);
      const rootKey = this.#rootKey(connection, input);
      connection.prepare(`INSERT OR IGNORE INTO workspace_write_waiters (work_id, workspace_ref, root_key, generation)
        VALUES (?, ?, ?, ?)`).run(input.workId, input.workspaceRef, rootKey, input.generation);
      const upgraded = this.#acquire(connection, { ...input, accessMode: "WRITE", preserveQueue: true });
      if (upgraded === null) connection.prepare("DELETE FROM workspace_leases WHERE work_id = ?").run(input.workId);
      return upgraded;
    });
  }

  async cancelWait(workId: string): Promise<void> {
    this.dependencies.database.transaction(connection => connection.prepare("DELETE FROM workspace_write_waiters WHERE work_id = ?").run(workId));
  }

  #rootKey(connection: DatabaseSync, input: { workId: string; workspaceRef: string }): string {
    const row = connection.prepare(`SELECT COALESCE(
      (SELECT root_path FROM work_run_directories WHERE work_id = ?),
      (SELECT root_path FROM workbench_workspace_roots WHERE workspace_ref = ?), ?) AS root`).get(input.workId, input.workspaceRef, input.workspaceRef);
    let root = String(row?.root);
    try { root = realpathSync(root); } catch { /* Opaque legacy refs use lexical normalization. */ }
    if (/^[a-z]:[\\/]/iu.test(root) || root.startsWith("\\\\")) return path.win32.normalize(root).replace(/[\\/]+$/u, "").toLowerCase();
    return path.normalize(root).replace(/[\\/]+$/u, "") || path.parse(root).root;
  }

  async release(workId: string, generation?: number): Promise<void> {
    this.dependencies.database.transaction((connection) => {
      connection.prepare("DELETE FROM workspace_leases WHERE work_id = ? AND (? IS NULL OR generation = ?)").run(workId, generation ?? null, generation ?? null);
    });
  }
}
