/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { DispatchPolicyGate, DispatchPolicyResult, PartnerDispatchPin } from "../../application/ports/work-orchestration.js";
import type { Clock } from "../../application/ports/runtime-store.js";
import { evaluateDispatchPolicy } from "../../application/work/dispatch-policy.js";
import type { WorkItem } from "../../domain/work/work.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export class SqliteDispatchPolicyGate implements DispatchPolicyGate {
  constructor(private readonly dependencies: { clock: Clock; database: TransactionalDatabase }) {}

  async evaluate(item: WorkItem, _pin: PartnerDispatchPin): Promise<Pick<DispatchPolicyResult, "allowed" | "reason">> {
    const row = this.dependencies.database.transaction((connection) => connection.prepare(`SELECT p.kind,
      b.workspace_ref, b.status AS workspace_status, b.kind AS workspace_kind
      FROM partner_revisions r JOIN partners p ON p.partner_id = r.partner_id
      LEFT JOIN workbench_workspace_bindings b ON b.workbench_id = ?
      WHERE r.partner_revision_id = ?`).get(item.workbenchId, _pin.partnerRevisionId)) as { kind?: unknown; workspace_ref?: unknown; workspace_status?: unknown; workspace_kind?: unknown } | undefined;
    const workspaceRef = typeof row?.workspace_ref === "string" ? row.workspace_ref : undefined;
    return evaluateDispatchPolicy(item.accessMode, {
      leaseConflict: workspaceRef !== undefined && row?.workspace_kind === "BOUND" && this.leaseConflict(workspaceRef, row.kind === "LOCAL_PI" ? "READ" : item.accessMode),
      partnerKind: typeof row?.kind === "string" ? row.kind : "",
      ...(row?.workspace_kind === "MANAGED" || row?.workspace_kind === "BOUND" ? { workspaceKind: row.workspace_kind } : {}),
      ...(workspaceRef === undefined ? {} : { workspaceRef }),
      ...(typeof row?.workspace_status === "string" ? { workspaceStatus: row.workspace_status } : {}),
    });
  }

  private leaseConflict(workspaceRef: string, accessMode: WorkItem["accessMode"]): boolean {
    const conflict = this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT 1 FROM workspace_leases
       WHERE workspace_ref = ? AND expires_at > ? AND (access_mode = 'WRITE' OR ? = 'WRITE') LIMIT 1`
    ).get(workspaceRef, this.dependencies.clock.now().toISOString(), accessMode));
    return conflict !== undefined;
  }
}
