/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { AvatarWorkspaceRepository, AvatarWorkspaceSummary } from "../../application/ports/avatar-context.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function mapRow(row: Row | undefined): AvatarWorkspaceSummary | null {
  if (row === undefined) return null;
  if (typeof row.workspace_ref !== "string" || typeof row.kind !== "string" || typeof row.status !== "string" || typeof row.display_name !== "string") {
    throw new Error("avatar_workspace_record_invalid");
  }
  return {
    displayName: row.display_name,
    ...(typeof row.failure_reason_code === "string" ? { failureReasonCode: row.failure_reason_code } : {}),
    kind: row.kind as AvatarWorkspaceSummary["kind"],
    status: row.status as AvatarWorkspaceSummary["status"],
    workspaceRef: row.workspace_ref,
  };
}

export class SqliteAvatarWorkspaceRepository implements AvatarWorkspaceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async getWorkspace(avatarId: string): Promise<AvatarWorkspaceSummary | null> {
    return mapRow(this.database.transaction((connection) => connection.prepare(`SELECT workspace_ref, kind, status,
      display_name, failure_reason_code FROM avatar_workspace_bindings WHERE avatar_id = ?`).get(avatarId)));
  }

  async hasNonTerminalFileWork(avatarId: string): Promise<boolean> {
    const row = this.database.transaction((connection) => connection.prepare(`SELECT 1 FROM work_items w
      JOIN work_access_policies p ON p.work_id = w.work_id
      WHERE w.avatar_id = ? AND p.access_mode IN ('READ', 'WRITE')
        AND w.status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING') LIMIT 1`).get(avatarId));
    return row !== undefined;
  }

  async bindExisting(input: { avatarId: string; displayName: string; rootPath: string; updatedAt: string }): Promise<AvatarWorkspaceSummary> {
    const ref = `avatar_workspace:${input.avatarId}`;
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO avatar_workspace_bindings
        (avatar_id, workspace_ref, kind, status, display_name, created_at, updated_at)
        VALUES (?, ?, 'BOUND', 'READY', ?, ?, ?)
        ON CONFLICT(avatar_id) DO UPDATE SET kind = 'BOUND', status = 'READY', display_name = excluded.display_name,
          failure_reason_code = NULL, updated_at = excluded.updated_at`).run(
        input.avatarId, ref, input.displayName, input.updatedAt, input.updatedAt,
      );
      connection.prepare(`INSERT INTO avatar_workspace_roots (workspace_ref, root_path, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(workspace_ref) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`
      ).run(ref, input.rootPath, input.updatedAt, input.updatedAt);
    });
    const result = await this.getWorkspace(input.avatarId);
    if (result === null) throw new Error("avatar_workspace_bind_failed");
    return result;
  }

  async requestManagedRebuild(input: { avatarId: string; outboxId: string; updatedAt: string }): Promise<AvatarWorkspaceSummary> {
    const ref = `avatar_workspace:${input.avatarId}`;
    this.database.transaction((connection) => {
      const name = connection.prepare("SELECT name FROM avatars WHERE avatar_id = ? AND status = 'ACTIVE'").get(input.avatarId) as { name?: unknown } | undefined;
      if (typeof name?.name !== "string") throw new Error("avatar_not_found");
      connection.prepare("DELETE FROM avatar_workspace_roots WHERE workspace_ref = ?").run(ref);
      connection.prepare(`INSERT INTO avatar_workspace_bindings
        (avatar_id, workspace_ref, kind, status, display_name, created_at, updated_at)
        VALUES (?, ?, 'MANAGED', 'PROVISIONING', ?, ?, ?)
        ON CONFLICT(avatar_id) DO UPDATE SET kind = 'MANAGED', status = 'PROVISIONING',
          display_name = excluded.display_name, failure_reason_code = NULL, updated_at = excluded.updated_at`).run(
        input.avatarId, ref, `${name.name} 工作区`, input.updatedAt, input.updatedAt,
      );
      connection.prepare(`INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
        VALUES (?, 'avatar.workspace.provision', ?, 'PENDING', 0, ?, ?)`
      ).run(input.outboxId, JSON.stringify({ avatarId: input.avatarId, workspaceRef: ref }), input.updatedAt, input.updatedAt);
    });
    const result = await this.getWorkspace(input.avatarId);
    if (result === null) throw new Error("avatar_workspace_rebuild_failed");
    return result;
  }
}
