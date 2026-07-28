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
    if (item.workspaceRef === undefined) return { allowed: true };
    const workspaceRef = item.workspaceRef;
    const conflict = this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT 1 FROM workspace_leases
       WHERE workspace_ref = ? AND expires_at > ? AND (access_mode = 'WRITE' OR ? = 'WRITE') LIMIT 1`
    ).get(workspaceRef, this.dependencies.clock.now().toISOString(), item.accessMode));
    return conflict === undefined
      ? { allowed: true }
      : { allowed: false, reason: "workspace_lease_conflict" };
  }
}
