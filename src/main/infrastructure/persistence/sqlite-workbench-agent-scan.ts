/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type {
  WorkbenchAgentScan,
  WorkbenchPartnerKey,
  WorkbenchPendingConfirmation,
  WorkbenchUnsynthesizedResult,
} from "../../application/ports/workbench-agent-scan.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function textValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("workbench_agent_scan_row_invalid");
  return value;
}

const TERMINAL_RUN_STATUSES = "('COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')";

export class SqliteWorkbenchAgentScan implements WorkbenchAgentScan {
  constructor(private readonly database: TransactionalDatabase) {}

  async listPartnerKeys(workbenchId: string): Promise<WorkbenchPartnerKey[]> {
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT partner_id FROM (
        SELECT rev.partner_id AS partner_id
          FROM dispatch_attempts a
          JOIN partner_revisions rev ON rev.partner_revision_id = a.partner_revision_id
          JOIN work_items w ON w.work_id = a.work_id
         WHERE w.workbench_id = ? AND a.status NOT IN ${TERMINAL_RUN_STATUSES}
        UNION
        SELECT i.partner_id FROM partner_instances i
         WHERE i.workbench_id = ? AND i.status <> 'DISPOSED'
        UNION
        SELECT rev2.partner_id
          FROM partner_runs pr
          JOIN partner_revisions rev2 ON rev2.partner_revision_id = pr.partner_revision_id
         WHERE pr.workbench_id = ? AND pr.status NOT IN ${TERMINAL_RUN_STATUSES}
        UNION
        SELECT s.partner_id FROM workbench_agent_sessions s
         WHERE s.workbench_id = ? AND s.dismissed_at IS NULL
      ) ORDER BY partner_id`).all(workbenchId, workbenchId, workbenchId, workbenchId)) as Row[])
      .map((row) => ({ partnerId: textValue(row, "partner_id") }));
  }

  async listPendingConfirmations(workbenchId: string): Promise<WorkbenchPendingConfirmation[]> {
    const clarifications = (this.database.transaction((connection) => connection.prepare(`
      SELECT input_id, clarification_reason_code FROM joi_inbox_messages
       WHERE workbench_id = ? AND status = 'CLARIFICATION_REQUIRED' AND dismissed_at IS NULL
       ORDER BY created_at, input_id`).all(workbenchId)) as Row[])
      .map((row): WorkbenchPendingConfirmation => ({
        kind: "clarification",
        ...(typeof row.clarification_reason_code === "string" ? { reasonCode: row.clarification_reason_code } : {}),
        referenceId: textValue(row, "input_id"),
      }));
    const changes = (this.database.transaction((connection) => connection.prepare(`
      SELECT request_id FROM workbench_change_requests
       WHERE status = 'PENDING' AND (source_workbench_id = ? OR target_workbench_id = ?)
       ORDER BY created_at, request_id`).all(workbenchId, workbenchId)) as Row[])
      .map((row): WorkbenchPendingConfirmation => ({ kind: "workbench_change", referenceId: textValue(row, "request_id") }));
    const waiting = (this.database.transaction((connection) => connection.prepare(`
      SELECT run_id, status FROM partner_runs
       WHERE workbench_id = ? AND status IN ('WAITING_INPUT', 'WAITING_AUTH')
       ORDER BY updated_at, run_id`).all(workbenchId)) as Row[])
      .map((row): WorkbenchPendingConfirmation => ({
        kind: "partner_waiting",
        reasonCode: textValue(row, "status"),
        referenceId: textValue(row, "run_id"),
      }));
    return [...clarifications, ...changes, ...waiting];
  }

  async listUnsynthesizedResults(workbenchId: string): Promise<WorkbenchUnsynthesizedResult[]> {
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT r.result_id, r.work_id, r.status, r.summary, e.event_id,
             rev.partner_id, w.title, pr.kind, pr.action_id, r.instance_id,
             (SELECT invocation_id FROM invocations WHERE message_id = pr.action_id) AS invocation_id
        FROM work_results r
        JOIN partner_result_events e ON e.run_id = r.run_id AND e.status = r.status
        JOIN work_items w ON w.work_id = r.work_id
        JOIN partner_runs pr ON pr.run_id = r.run_id
        JOIN partner_revisions rev ON rev.partner_revision_id = pr.partner_revision_id
       WHERE r.workbench_id = ? AND r.is_authoritative = 1 AND r.is_late = 0
         AND NOT EXISTS (SELECT 1 FROM joi_goal_result_members m WHERE m.event_id = e.event_id)
       ORDER BY r.created_at, r.result_id LIMIT 50`).all(workbenchId)) as Row[])
      .map((row) => {
        const kind = textValue(row, "kind");
        const actionId = textValue(row, "action_id");
        const instanceId = typeof row.instance_id === "string" ? row.instance_id : null;
        const invocationId = typeof row.invocation_id === "string" ? row.invocation_id : null;
        const sessionDataSource = kind === "LOCAL_PI"
          ? (instanceId === null ? `local_pi:${actionId}` : `partner_instance_messages:${instanceId}`)
          : (invocationId === null ? `a2a:${actionId}` : `a2a_invocations:${invocationId}`);
        return {
          workbenchId,
          eventId: textValue(row, "event_id"),
          partnerId: textValue(row, "partner_id"),
          resultId: textValue(row, "result_id"),
          sessionDataSource,
          status: textValue(row, "status"),
          summary: typeof row.summary === "string" ? row.summary : "",
          title: textValue(row, "title"),
          workId: textValue(row, "work_id"),
        };
      });
  }
}
