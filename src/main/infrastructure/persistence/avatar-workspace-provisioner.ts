import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { DurableUiEventEmitter, OutboxRecord } from "../../application/ports/runtime-store.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export class AvatarWorkspaceProvisioner {
  constructor(private readonly dependencies: { database: TransactionalDatabase; events?: DurableUiEventEmitter; userDataDirectory: string }) {}

  async handle(record: OutboxRecord): Promise<void> {
    const avatarId = record.payload.avatarId;
    const workspaceRef = record.payload.workspaceRef;
    if (typeof avatarId !== "string" || typeof workspaceRef !== "string") throw new Error("avatar_workspace_outbox_invalid");
    const isCurrentManaged = (): boolean => this.dependencies.database.transaction((connection) => {
      const binding = connection.prepare("SELECT kind FROM avatar_workspace_bindings WHERE avatar_id = ? AND workspace_ref = ?")
        .get(avatarId, workspaceRef) as { kind?: unknown } | undefined;
      return binding?.kind === "MANAGED";
    });
    if (!isCurrentManaged()) return;
    const key = createHash("sha256").update(avatarId).digest("hex").slice(0, 24);
    const generation = createHash("sha256").update(record.outboxId).digest("hex").slice(0, 16);
    const rootPath = path.join(this.dependencies.userDataDirectory, "avatars", key, "workspaces", generation);
    try {
      await mkdir(rootPath, { recursive: true });
      const applied = this.dependencies.database.transaction((connection) => {
        const binding = connection.prepare("SELECT kind FROM avatar_workspace_bindings WHERE avatar_id = ? AND workspace_ref = ?")
          .get(avatarId, workspaceRef) as { kind?: unknown } | undefined;
        if (binding?.kind !== "MANAGED") return false;
        const now = new Date().toISOString();
        connection.prepare(`INSERT INTO avatar_workspace_roots (workspace_ref, root_path, created_at, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(workspace_ref) DO UPDATE SET root_path = excluded.root_path, updated_at = excluded.updated_at`
        ).run(workspaceRef, rootPath, now, now);
        connection.prepare(`UPDATE avatar_workspace_bindings SET status = 'READY', failure_reason_code = NULL, updated_at = ?
          WHERE avatar_id = ? AND workspace_ref = ? AND kind = 'MANAGED'`).run(now, avatarId, workspaceRef);
        return true;
      });
      if (!applied) return;
    } catch {
      this.dependencies.database.transaction((connection) => connection.prepare(`UPDATE avatar_workspace_bindings
        SET status = 'FAILED', failure_reason_code = 'avatar_workspace_provision_failed', updated_at = ?
        WHERE avatar_id = ? AND workspace_ref = ? AND kind = 'MANAGED'`).run(new Date().toISOString(), avatarId, workspaceRef));
      try {
        await this.dependencies.events?.emit("avatar.workspace.changed", avatarId, {
          avatarId, failureReasonCode: "avatar_workspace_provision_failed", kind: "MANAGED", status: "FAILED",
        });
      } catch { /* Keep the outbox error stable; retry will attempt the durable event again. */ }
      throw new Error("avatar_workspace_provision_failed");
    }
    await this.dependencies.events?.emit("avatar.workspace.changed", avatarId, { avatarId, kind: "MANAGED", status: "READY" });
  }
}
