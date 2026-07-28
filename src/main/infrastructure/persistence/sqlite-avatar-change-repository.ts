/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { AvatarChangeRepository, AvatarChangeRequest } from "../../application/ports/avatar-change.js";
import { DomainError } from "../../domain/errors.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("avatar_change_record_invalid");
  return value;
}

function requestFrom(row: Row): AvatarChangeRequest {
  const kind = text(row, "kind");
  const status = text(row, "status");
  if ((kind !== "ARCHIVE" && kind !== "MERGE") || !["PENDING", "CONFIRMED", "REJECTED"].includes(status)) {
    throw new Error("avatar_change_record_invalid");
  }
  return {
    createdAt: text(row, "created_at"),
    ...(typeof row.decided_at === "string" ? { decidedAt: row.decided_at } : {}),
    kind,
    reason: text(row, "reason"),
    requestId: text(row, "request_id"),
    sourceAvatarId: text(row, "source_avatar_id"),
    status: status as AvatarChangeRequest["status"],
    ...(typeof row.target_avatar_id === "string" ? { targetAvatarId: row.target_avatar_id } : {}),
    turnId: text(row, "turn_id"),
  };
}

const SELECT_REQUEST = `SELECT request_id, kind, source_avatar_id, target_avatar_id, reason, turn_id,
  status, created_at, decided_at FROM avatar_change_requests`;

export class SqliteAvatarChangeRepository implements AvatarChangeRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async create(request: AvatarChangeRequest): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`INSERT INTO avatar_change_requests
      (request_id, kind, source_avatar_id, target_avatar_id, reason, turn_id, status, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, NULL)`).run(
      request.requestId, request.kind, request.sourceAvatarId, request.targetAvatarId ?? null,
      request.reason, request.turnId, request.createdAt,
    ));
  }

  async decide(requestId: string, decision: "CONFIRM" | "REJECT", decidedAt: string): Promise<AvatarChangeRequest> {
    return this.database.transaction((connection) => {
      const row = connection.prepare(`${SELECT_REQUEST} WHERE request_id = ?`).get(requestId) as Row | undefined;
      if (row === undefined) throw new DomainError("avatar_change_not_found", "Avatar change request was not found.");
      const request = requestFrom(row);
      if (request.status !== "PENDING") throw new DomainError("avatar_change_already_decided", "Avatar change request was already decided.");
      if (decision === "CONFIRM") {
        const activeWork = connection.prepare(`SELECT COUNT(*) AS count FROM work_items
          WHERE avatar_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING')`).get(request.sourceAvatarId) as { count: number };
        if (activeWork.count > 0) throw new DomainError("avatar_change_active_work", "Avatar still owns nonterminal work.");
        const source = connection.prepare("SELECT status FROM avatars WHERE avatar_id = ?").get(request.sourceAvatarId) as { status: string } | undefined;
        if (source?.status !== "ACTIVE") throw new DomainError("avatar_change_source_not_active", "Source Avatar is not active.");
        if (request.kind === "MERGE") {
          const targetAvatarId = request.targetAvatarId;
          if (targetAvatarId === undefined) throw new Error("avatar_change_record_invalid");
          const target = connection.prepare("SELECT status FROM avatars WHERE avatar_id = ?").get(targetAvatarId) as { status: string } | undefined;
          if (target?.status !== "ACTIVE") throw new DomainError("avatar_change_target_not_active", "Target Avatar is not active.");
          connection.prepare(`INSERT INTO avatar_merges
            (request_id, source_avatar_id, target_avatar_id, created_at) VALUES (?, ?, ?, ?)`
          ).run(request.requestId, request.sourceAvatarId, targetAvatarId, decidedAt);
        }
        connection.prepare("UPDATE avatars SET status = 'ARCHIVED', updated_at = ? WHERE avatar_id = ?")
          .run(decidedAt, request.sourceAvatarId);
      }
      const status = decision === "CONFIRM" ? "CONFIRMED" : "REJECTED";
      connection.prepare("UPDATE avatar_change_requests SET status = ?, decided_at = ? WHERE request_id = ?")
        .run(status, decidedAt, requestId);
      return requestFrom(connection.prepare(`${SELECT_REQUEST} WHERE request_id = ?`).get(requestId) as Row);
    });
  }

  async get(requestId: string): Promise<AvatarChangeRequest | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare(`${SELECT_REQUEST} WHERE request_id = ?`).get(requestId) as Row | undefined;
      return row === undefined ? null : requestFrom(row);
    });
  }

  async isActive(avatarId: string): Promise<boolean> {
    return this.database.transaction((connection) => (connection.prepare(
      "SELECT 1 AS found FROM avatars WHERE avatar_id = ? AND status = 'ACTIVE'",
    ).get(avatarId) as { found: number } | undefined) !== undefined);
  }

  async listPending(): Promise<AvatarChangeRequest[]> {
    return this.database.transaction((connection) => connection.prepare(
      `${SELECT_REQUEST} WHERE status = 'PENDING' ORDER BY created_at, request_id`,
    ).all().map((row) => requestFrom(row as Row)));
  }
}
