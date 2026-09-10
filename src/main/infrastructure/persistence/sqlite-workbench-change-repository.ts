/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { WorkbenchChangeRepository, WorkbenchChangeRequest } from "../../application/ports/workbench-change.js";
import { DomainError } from "../../domain/errors.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("workbench_change_record_invalid");
  return value;
}

function requestFrom(row: Row): WorkbenchChangeRequest {
  const kind = text(row, "kind");
  const status = text(row, "status");
  if ((kind !== "ARCHIVE" && kind !== "MERGE") || !["PENDING", "CONFIRMED", "REJECTED"].includes(status)) {
    throw new Error("workbench_change_record_invalid");
  }
  return {
    createdAt: text(row, "created_at"),
    ...(typeof row.decided_at === "string" ? { decidedAt: row.decided_at } : {}),
    kind,
    reason: text(row, "reason"),
    requestId: text(row, "request_id"),
    sourceWorkbenchId: text(row, "source_workbench_id"),
    status: status as WorkbenchChangeRequest["status"],
    ...(typeof row.target_workbench_id === "string" ? { targetWorkbenchId: row.target_workbench_id } : {}),
    turnId: text(row, "turn_id"),
  };
}

const SELECT_REQUEST = `SELECT request_id, kind, source_workbench_id, target_workbench_id, reason, turn_id,
  status, created_at, decided_at FROM workbench_change_requests`;

export class SqliteWorkbenchChangeRepository implements WorkbenchChangeRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async create(request: WorkbenchChangeRequest): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`INSERT INTO workbench_change_requests
      (request_id, kind, source_workbench_id, target_workbench_id, reason, turn_id, status, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL)`).run(
      request.requestId, request.kind, request.sourceWorkbenchId, request.targetWorkbenchId ?? null,
      request.reason, request.turnId, request.createdAt,
    ));
  }

  async decide(requestId: string, decision: "CONFIRM" | "REJECT", decidedAt: string): Promise<WorkbenchChangeRequest> {
    return this.database.transaction((connection) => this.#decide(connection, requestId, decision, decidedAt));
  }

  async archiveConfirmed(request: WorkbenchChangeRequest): Promise<WorkbenchChangeRequest> {
    return this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO workbench_change_requests
        (request_id, kind, source_workbench_id, reason, turn_id, status, created_at)
        VALUES (?, 'ARCHIVE', ?, ?, ?, 'PENDING', ?) ON CONFLICT(request_id) DO NOTHING`)
        .run(request.requestId, request.sourceWorkbenchId, request.reason, request.turnId, request.createdAt);
      return this.#decide(connection, request.requestId, "CONFIRM", request.createdAt);
    });
  }

  #decide(connection: DatabaseSync, requestId: string, decision: "CONFIRM" | "REJECT", decidedAt: string): WorkbenchChangeRequest {
    const row = connection.prepare(`${SELECT_REQUEST} WHERE request_id = ?`).get(requestId) as Row | undefined;
    if (row === undefined) throw new DomainError("workbench_change_not_found", "Workbench change request was not found.");
    const request = requestFrom(row);
    if (request.status === (decision === "CONFIRM" ? "CONFIRMED" : "REJECTED")) return request;
    if (request.status !== "PENDING") throw new DomainError("workbench_change_already_decided", "Workbench change request was already decided.");
    if (decision === "CONFIRM") {
      const activeWork = connection.prepare(`SELECT COUNT(*) AS count FROM work_items
        WHERE workbench_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING')`).get(request.sourceWorkbenchId) as { count: number };
      if (activeWork.count > 0) throw new DomainError("workbench_change_active_work", "Workbench still owns nonterminal work.");
      const source = connection.prepare("SELECT status FROM workbenches WHERE workbench_id = ?").get(request.sourceWorkbenchId) as { status: string } | undefined;
      if (source?.status !== "ACTIVE") throw new DomainError("workbench_change_source_not_active", "Source Workbench is not active.");
      if (request.kind === "MERGE") {
        const targetWorkbenchId = request.targetWorkbenchId;
        if (targetWorkbenchId === undefined) throw new Error("workbench_change_record_invalid");
        const target = connection.prepare("SELECT status FROM workbenches WHERE workbench_id = ?").get(targetWorkbenchId) as { status: string } | undefined;
        if (target?.status !== "ACTIVE") throw new DomainError("workbench_change_target_not_active", "Target Workbench is not active.");
        connection.prepare(`INSERT INTO workbench_merges
          (request_id, source_workbench_id, target_workbench_id, created_at) VALUES (?, ?, ?, ?)`
        ).run(request.requestId, request.sourceWorkbenchId, targetWorkbenchId, decidedAt);
      }
      connection.prepare("UPDATE workbenches SET status = 'ARCHIVED', updated_at = ? WHERE workbench_id = ?")
        .run(decidedAt, request.sourceWorkbenchId);
    }
    const status = decision === "CONFIRM" ? "CONFIRMED" : "REJECTED";
    connection.prepare("UPDATE workbench_change_requests SET status = ?, decided_at = ? WHERE request_id = ?")
      .run(status, decidedAt, requestId);
    return requestFrom(connection.prepare(`${SELECT_REQUEST} WHERE request_id = ?`).get(requestId) as Row);
  }

  async get(requestId: string): Promise<WorkbenchChangeRequest | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare(`${SELECT_REQUEST} WHERE request_id = ?`).get(requestId) as Row | undefined;
      return row === undefined ? null : requestFrom(row);
    });
  }

  async isActive(workbenchId: string): Promise<boolean> {
    return this.database.transaction((connection) => (connection.prepare(
      "SELECT 1 AS found FROM workbenches WHERE workbench_id = ? AND status = 'ACTIVE'",
    ).get(workbenchId) as { found: number } | undefined) !== undefined);
  }

  async listPending(): Promise<WorkbenchChangeRequest[]> {
    return this.database.transaction((connection) => connection.prepare(
      `${SELECT_REQUEST} WHERE status = 'PENDING' ORDER BY created_at, request_id`,
    ).all().map((row) => requestFrom(row as Row)));
  }
}
