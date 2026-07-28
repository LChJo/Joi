/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiInboxRecord, JoiInboxRepository, JoiInboxStatus } from "../../application/ports/joi-inbox.js";
import type { JoiCoordinatorStore, JoiPendingInput } from "../../application/ports/joi-coordinator.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function mapRow(row: Row): JoiInboxRecord {
  const inputId = row.input_id;
  const idempotencyKey = row.idempotency_key;
  const body = row.body;
  const status = row.status;
  const avatarId = row.avatar_id;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  if (typeof inputId !== "string" || typeof idempotencyKey !== "string" || typeof body !== "string"
    || typeof status !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string"
    || (avatarId !== null && typeof avatarId !== "string")) throw new Error("joi_inbox_record_invalid");
  return {
    ...(typeof avatarId === "string" ? { avatarId } : {}),
    body,
    createdAt,
    idempotencyKey,
    inputId,
    status: status as JoiInboxStatus,
    updatedAt,
  };
}

export class SqliteJoiInboxRepository implements JoiInboxRepository, JoiCoordinatorStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async create(record: JoiInboxRecord): Promise<JoiInboxRecord> {
    return this.database.transaction((connection) => {
      const existing = connection.prepare("SELECT * FROM joi_inbox_messages WHERE idempotency_key = ?").get(record.idempotencyKey) as Row | undefined;
      if (existing !== undefined) return mapRow(existing);
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        record.inputId, record.idempotencyKey, record.body, record.status, record.avatarId ?? null, record.createdAt, record.updatedAt,
      );
      return record;
    });
  }

  async list(): Promise<JoiInboxRecord[]> {
    return this.database.transaction((connection) => connection.prepare(
      "SELECT * FROM joi_inbox_messages ORDER BY created_at, input_id",
    ).all()).map((row) => mapRow(row as Row));
  }

  async loadInput(inputId: string): Promise<JoiPendingInput | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT input_id, body, status FROM joi_inbox_messages WHERE input_id = ?",
    ).get(inputId)) as Row | undefined;
    if (row === undefined) return null;
    if (typeof row.input_id !== "string" || typeof row.body !== "string" || typeof row.status !== "string") {
      throw new Error("joi_inbox_record_invalid");
    }
    return { body: row.body, inputId: row.input_id, status: row.status as JoiPendingInput["status"] };
  }

  async requireClarification(inputId: string, reasonCode: string): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = ?, updated_at = ?
        WHERE input_id = ? AND status <> 'CONSUMED'`).run(
        reasonCode, new Date().toISOString(), inputId,
      );
    });
  }

  async createTurn(input: {
    avatarId: string;
    createdAt: string;
    inputId: string;
    modelRevisionId: string;
    sessionId: string;
    sourceRevisionId: string;
    turnId: string;
  }): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, avatar_id, session_id, source_revision_id, model_revision_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`).run(
        input.turnId, input.inputId, input.avatarId, input.sessionId, input.sourceRevisionId,
        input.modelRevisionId, input.createdAt, input.createdAt,
      );
      connection.prepare(`UPDATE joi_inbox_messages SET status = 'ROUTED', avatar_id = ?, updated_at = ?
        WHERE input_id = ? AND status <> 'CONSUMED'`).run(input.avatarId, input.createdAt, input.inputId);
    });
  }

  async completeInput(inputId: string, turnId: string): Promise<void> {
    this.database.transaction((connection) => {
      const now = new Date().toISOString();
      connection.prepare("UPDATE joi_turns SET status = 'COMPLETED', updated_at = ? WHERE turn_id = ?").run(now, turnId);
      connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = ? WHERE input_id = ?").run(now, inputId);
    });
  }

  async failTurn(inputId: string, turnId: string): Promise<void> {
    this.database.transaction((connection) => {
      const now = new Date().toISOString();
      connection.prepare("UPDATE joi_turns SET status = 'FAILED', updated_at = ? WHERE turn_id = ?").run(now, turnId);
      connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'PENDING', updated_at = ? WHERE input_id = ? AND status <> 'CONSUMED'`).run(now, inputId);
    });
  }
}
