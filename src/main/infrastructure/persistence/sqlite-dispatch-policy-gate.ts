/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { DispatchPolicyGate, PartnerDispatchPin } from "../../application/ports/work-orchestration.js";
import type { Clock } from "../../application/ports/runtime-store.js";
import type { WorkItem } from "../../domain/work/work.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export class SqliteDispatchPolicyGate implements DispatchPolicyGate {
  constructor(private readonly dependencies: { clock: Clock; database: TransactionalDatabase }) {}

  async evaluate(item: WorkItem, _pin: PartnerDispatchPin): Promise<{ allowed: boolean; reason?: string }> {
    const facts = this.dependencies.database.transaction((connection) => connection.prepare(`SELECT p.kind,
      b.workspace_ref, b.status AS workspace_status
      FROM partner_revisions r JOIN partners p ON p.partner_id = r.partner_id
      LEFT JOIN avatar_workspace_bindings b ON b.avatar_id = ?
      WHERE r.partner_revision_id = ?`).get(item.avatarId, _pin.partnerRevisionId)) as {
        kind?: unknown; workspace_ref?: unknown; workspace_status?: unknown;
      } | undefined;
    if (item.accessMode === "NONE") return { allowed: true };
    if (facts?.kind === "A2A") return { allowed: false, reason: "a2a_workspace_access_forbidden" };
    if (facts?.workspace_status !== "READY" || typeof facts.workspace_ref !== "string") {
      return { allowed: false, reason: "avatar_workspace_not_ready" };
    }
    const workspaceRef = facts.workspace_ref;
    const conflict = this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT 1 FROM workspace_leases
       WHERE workspace_ref = ? AND expires_at > ? AND (access_mode = 'WRITE' OR ? = 'WRITE') LIMIT 1`
    ).get(workspaceRef, this.dependencies.clock.now().toISOString(), item.accessMode));
    return conflict === undefined
      ? { allowed: true }
      : { allowed: false, reason: "workspace_lease_conflict" };
  }
}
