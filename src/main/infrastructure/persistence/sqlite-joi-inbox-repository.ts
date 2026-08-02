/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiInboxRecord, JoiInboxRepository, JoiInboxStatus } from "../../application/ports/joi-inbox.js";
import type { JoiCoordinatorStore, JoiPendingInput } from "../../application/ports/joi-coordinator.js";
import type { JoiActivityDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";

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
  const canceledAt = row.canceled_at;
  const clarificationReasonCode = row.clarification_reason_code;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  if (typeof inputId !== "string" || typeof idempotencyKey !== "string" || typeof body !== "string"
    || typeof status !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string"
    || (avatarId !== null && typeof avatarId !== "string")
    || (canceledAt !== null && canceledAt !== undefined && typeof canceledAt !== "string")
    || (clarificationReasonCode !== null && clarificationReasonCode !== undefined && typeof clarificationReasonCode !== "string")) {
    throw new Error("joi_inbox_record_invalid");
  }
  return {
    ...(typeof avatarId === "string" ? { avatarId } : {}),
    body,
    ...(typeof canceledAt === "string" ? { canceledAt } : {}),
    ...(typeof clarificationReasonCode === "string" ? { clarificationReasonCode } : {}),
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
      for (const attachmentId of record.attachmentIds ?? []) {
        const attachment = connection.prepare(`SELECT a.attachment_id,
          (SELECT input_id FROM joi_inbox_attachments ia WHERE ia.attachment_id = a.attachment_id) AS input_id
          FROM joi_attachments a WHERE a.attachment_id = ?`).get(attachmentId) as { attachment_id?: unknown; input_id?: unknown } | undefined;
        if (typeof attachment?.attachment_id !== "string") throw new DomainError("joi_attachment_not_found", "Attachment was not found.");
        if (typeof attachment.input_id === "string") throw new DomainError("joi_attachment_already_bound", "Attachment is already bound to another input.");
        connection.prepare("INSERT INTO joi_inbox_attachments (input_id, attachment_id) VALUES (?, ?)").run(record.inputId, attachmentId);
      }
      return record;
    });
  }

  async list(): Promise<JoiInboxRecord[]> {
    return this.database.transaction((connection) => connection.prepare(
      "SELECT * FROM joi_inbox_messages ORDER BY created_at, input_id",
    ).all()).map((row) => mapRow(row as Row));
  }

  async clarify(inputId: string, patch: { avatarId?: string; text?: string }): Promise<JoiInboxRecord | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      if (row === undefined) return null;
      const current = mapRow(row);
      if (current.status !== "CLARIFICATION_REQUIRED") return null;
      const now = new Date().toISOString();
      const nextBody = patch.text === undefined ? current.body : `${current.body}\n\n[用户补充] ${patch.text}`;
      const nextAvatar = patch.avatarId ?? current.avatarId;
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET body = ?, avatar_id = ?, status = 'PENDING', clarification_reason_code = NULL, updated_at = ?
        WHERE input_id = ? AND status = 'CLARIFICATION_REQUIRED'`).run(nextBody, nextAvatar ?? null, now, inputId);
      if (result.changes === 0) return null;
      const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      return updated === undefined ? null : mapRow(updated);
    });
  }

  async cancel(inputId: string): Promise<JoiInboxRecord | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      if (row === undefined) return null;
      const current = mapRow(row);
      if (current.status !== "PENDING" && current.status !== "CLARIFICATION_REQUIRED") return null;
      const now = new Date().toISOString();
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CONSUMED', canceled_at = ?, clarification_reason_code = NULL, updated_at = ?
        WHERE input_id = ? AND status IN ('PENDING', 'CLARIFICATION_REQUIRED')`).run(now, now, inputId);
      if (result.changes === 0) return null;
      const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      return updated === undefined ? null : mapRow(updated);
    });
  }

  async listActivity(limit = 100): Promise<JoiActivityDto[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.database.transaction((connection) => connection.prepare(`
      SELECT activity_id, avatar_id, kind, occurred_at, status, work_id FROM (
        SELECT input_id AS activity_id, avatar_id, 'MESSAGE' AS kind, created_at AS occurred_at, status, NULL AS work_id
          FROM joi_inbox_messages
        UNION ALL
        SELECT turn_id, avatar_id, 'TURN', created_at, status, NULL FROM joi_turns
        UNION ALL
        SELECT work_id, avatar_id, 'WORK', created_at, status, work_id FROM work_items
        UNION ALL
        SELECT event_id, avatar_id, 'PARTNER_RESULT', created_at, status, work_id FROM partner_result_events
      ) ORDER BY occurred_at DESC, activity_id DESC LIMIT ?`).all(safeLimit)) as Record<string, unknown>[];
    return rows.map((row) => {
      if (typeof row.activity_id !== "string" || typeof row.kind !== "string"
        || typeof row.occurred_at !== "string" || typeof row.status !== "string") throw new Error("joi_activity_record_invalid");
      return {
        activityId: row.activity_id,
        ...(typeof row.avatar_id === "string" ? { avatarId: row.avatar_id } : {}),
        kind: row.kind as JoiActivityDto["kind"],
        occurredAt: row.occurred_at,
        status: row.status,
        ...(typeof row.work_id === "string" ? { workId: row.work_id } : {}),
      };
    });
  }

  async loadInput(inputId: string): Promise<JoiPendingInput | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT input_id, body, status, avatar_id FROM joi_inbox_messages WHERE input_id = ?",
    ).get(inputId)) as Row | undefined;
    if (row === undefined) return null;
    if (typeof row.input_id !== "string" || typeof row.body !== "string" || typeof row.status !== "string") {
      throw new Error("joi_inbox_record_invalid");
    }
    if (row.avatar_id !== null && typeof row.avatar_id !== "string") throw new Error("joi_inbox_record_invalid");
    const attachments = this.database.transaction((connection) => connection.prepare(`SELECT a.attachment_id, a.filename, a.mime_type, a.size
      FROM joi_inbox_attachments ia JOIN joi_attachments a ON a.attachment_id = ia.attachment_id
      WHERE ia.input_id = ? ORDER BY a.created_at, a.attachment_id`).all(inputId)) as Record<string, unknown>[];
    return {
      ...(typeof row.avatar_id === "string" ? { avatarId: row.avatar_id } : {}),
      ...(attachments.length === 0 ? {} : { attachments: attachments.map((attachment) => {
        if (typeof attachment.attachment_id !== "string" || typeof attachment.filename !== "string"
          || typeof attachment.mime_type !== "string" || typeof attachment.size !== "number") throw new Error("joi_attachment_record_invalid");
        return { attachmentId: attachment.attachment_id, filename: attachment.filename, mimeType: attachment.mime_type, size: attachment.size };
      }) }),
      body: row.body,
      inputId: row.input_id,
      status: row.status as JoiPendingInput["status"],
    };
  }

  async enqueuePartnerResult(event: { avatarId: string; eventId: string; resultId: string; status: string; summary: string; workId: string }): Promise<string> {
    const inputId = `joi_result_input:${event.eventId}`;
    this.database.transaction((connection) => {
      const source = connection.prepare(`SELECT created_at FROM work_results
        WHERE result_id = ? AND avatar_id = ? AND work_id = ? AND status = ?`).get(
        event.resultId, event.avatarId, event.workId, event.status,
      ) as { created_at?: unknown } | undefined;
      if (typeof source?.created_at !== "string") throw new Error("partner_result_event_not_found");
      const body = [
        "A partner result is ready for orchestration.",
        `resultId=${event.resultId}`,
        `workId=${event.workId}`,
        `status=${event.status}`,
        `summary=${event.summary.slice(0, 320)}`,
        "Use work.read_result only if the bounded summary is insufficient.",
        "Decide whether to integrate, wait, ask the user, or reassign using a different partner revision.",
      ].join("\n");
      connection.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
        VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`).run(
        inputId, `partner_result:${event.eventId}`, body, event.avatarId, source.created_at, source.created_at,
      );
      connection.prepare("UPDATE partner_result_events SET input_id = ? WHERE event_id = ? AND input_id IS NULL")
        .run(inputId, event.eventId);
    });
    return inputId;
  }

  async enqueueSystemSignal(input: { avatarId: string; signalId: string; type: string }): Promise<string> {
    const inputId = `joi_signal_input:${input.signalId}`;
    const now = new Date().toISOString();
    this.database.transaction((connection) => connection.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
      (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`
    ).run(
      inputId,
      `system_signal:${input.signalId}`,
      `A persisted Avatar-scoped system signal is ready for orchestration.\ntype=${input.type}\nsignalId=${input.signalId}`,
      input.avatarId,
      now,
      now,
    ));
    return inputId;
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
      connection.prepare("UPDATE partner_result_events SET consumed_at = ? WHERE input_id = ? AND consumed_at IS NULL").run(now, inputId);
    });
  }

  async recordTurnProgress(turnId: string, progress: { formalOutputStarted: boolean; sideEffectStarted: boolean }): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`UPDATE joi_turns
      SET formal_output_started = MAX(formal_output_started, ?), side_effect_started = MAX(side_effect_started, ?), updated_at = ?
      WHERE turn_id = ?`).run(
      progress.formalOutputStarted ? 1 : 0,
      progress.sideEffectStarted ? 1 : 0,
      new Date().toISOString(),
      turnId,
    ));
  }

  async updateTurnSource(turnId: string, sourceRevisionId: string, modelRevisionId: string): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`UPDATE joi_turns
      SET source_revision_id = ?, model_revision_id = ?, updated_at = ? WHERE turn_id = ?`).run(
      sourceRevisionId, modelRevisionId, new Date().toISOString(), turnId,
    ));
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
