import type { DatabaseSync } from "node:sqlite";

import type { A2aGatewayService } from "../../application/a2a/a2a-gateway-service.js";
import type { OutboxRecord } from "../../application/ports/runtime-store.js";
import type { InvocationStatus } from "../../application/ports/a2a-ports.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

interface DispatchRow {
  action_id: string;
  agent_connection_id: string | null;
  avatar_id: string;
  dispatch_attempt_id: string;
  invocation_id: string | null;
  kind: "A2A" | "LOCAL_PI";
  status: string;
  title: string;
  work_id: string;
}

function terminal(status: string): boolean {
  return ["COMPLETED", "FAILED", "WAITING_INPUT", "WAITING_AUTH", "UNKNOWN"].includes(status);
}

function mapStatus(status: InvocationStatus): { attempt: string; work: string } {
  switch (status) {
    case "COMPLETED": return { attempt: "COMPLETED", work: "COMPLETED" };
    case "INPUT_REQUIRED": return { attempt: "WAITING_INPUT", work: "WAITING" };
    case "AUTH_REQUIRED": return { attempt: "WAITING_AUTH", work: "WAITING" };
    case "ACCEPTED":
    case "WORKING": return { attempt: "RUNNING", work: "RUNNING" };
    case "CREATED":
    case "SENDING":
    case "SENT_NO_ACCEPT":
    case "WAITING_RETRY": return { attempt: "DISPATCHED", work: "READY" };
    case "CANCELED": return { attempt: "FAILED", work: "CANCELED" };
    case "FAILED": return { attempt: "FAILED", work: "FAILED" };
    case "UNKNOWN_REQUIRES_REVIEW": return { attempt: "UNKNOWN", work: "WAITING" };
  }
}

export class SqliteA2aPartnerDispatchHandler {
  constructor(private readonly dependencies: {
    database: TransactionalDatabase;
    gateway: Pick<A2aGatewayService, "recover" | "startWithResult">;
  }) {}

  async handle(record: OutboxRecord): Promise<void> {
    const dispatchAttemptId = record.payload.dispatchAttemptId;
    const actionId = record.payload.actionId;
    if (typeof dispatchAttemptId !== "string" || typeof actionId !== "string") throw new Error("partner_dispatch_payload_invalid");
    const row = this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT a.dispatch_attempt_id, a.action_id, a.status, w.work_id, w.avatar_id, w.title,
             p.kind, p.legacy_agent_connection_id AS agent_connection_id,
             (SELECT invocation_id FROM invocations WHERE message_id = a.action_id) AS invocation_id
        FROM dispatch_attempts a
        JOIN work_items w ON w.work_id = a.work_id
        JOIN partner_revisions r ON r.partner_revision_id = a.partner_revision_id
        JOIN partners p ON p.partner_id = r.partner_id
       WHERE a.dispatch_attempt_id = ?`).get(dispatchAttemptId)) as DispatchRow | undefined;
    if (row?.action_id !== actionId) throw new Error("partner_dispatch_attempt_invalid");
    if (terminal(row.status)) return;
    if (row.kind !== "A2A" || row.agent_connection_id === null) {
      this.#saveResult(row, { attempt: "FAILED", work: "FAILED" });
      return;
    }
    const agentConnectionId = row.agent_connection_id;
    const invocation = row.invocation_id === null
      ? (await this.dependencies.gateway.startWithResult({
        agentConnectionId,
        capacity: { lane: "collaborator", lifeId: row.avatar_id },
        messageId: row.action_id,
        parts: [
          { kind: "text", text: row.title },
          { data: { actionId: row.action_id, avatarId: row.avatar_id, sourceBoundary: "joi-work", workId: row.work_id }, kind: "data" },
        ],
      })).invocation
      : await this.dependencies.gateway.recover(row.invocation_id);
    this.#saveResult(row, mapStatus(invocation.status));
  }

  #saveResult(row: DispatchRow, status: { attempt: string; work: string }): void {
    this.dependencies.database.transaction((connection) => {
      const now = new Date().toISOString();
      connection.prepare("UPDATE dispatch_attempts SET status = ?, updated_at = ? WHERE dispatch_attempt_id = ?")
        .run(status.attempt, now, row.dispatch_attempt_id);
      connection.prepare("UPDATE work_items SET status = ?, updated_at = ? WHERE work_id = ?")
        .run(status.work, now, row.work_id);
    });
  }
}
