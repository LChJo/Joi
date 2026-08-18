/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiInboxRecord, JoiInboxRepository, JoiInboxStatus } from "../../application/ports/joi-inbox.js";
import type { JoiCoordinatorStore, JoiPendingInput } from "../../application/ports/joi-coordinator.js";
import type { JoiActivityDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import { normalizeCompletionSummary } from "../../application/partners/agent-conversation-presentation.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function mapRow(row: Row): JoiInboxRecord {
  const inputId = row.input_id;
  const idempotencyKey = row.idempotency_key;
  const body = row.body;
  const status = row.status;
  const workbenchId = row.workbench_id;
  const canceledAt = row.canceled_at;
  const clarificationPrompt = row.clarification_prompt;
  const clarificationReasonCode = row.clarification_reason_code;
  const createdAt = row.created_at;
  const dismissedAt = row.dismissed_at;
  const updatedAt = row.updated_at;
  if (typeof inputId !== "string" || typeof idempotencyKey !== "string" || typeof body !== "string"
    || typeof status !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string"
    || (workbenchId !== null && typeof workbenchId !== "string")
    || (canceledAt !== null && canceledAt !== undefined && typeof canceledAt !== "string")
    || (clarificationPrompt !== null && clarificationPrompt !== undefined && typeof clarificationPrompt !== "string")
    || (clarificationReasonCode !== null && clarificationReasonCode !== undefined && typeof clarificationReasonCode !== "string")
    || (dismissedAt !== null && dismissedAt !== undefined && typeof dismissedAt !== "string")) {
    throw new Error("joi_inbox_record_invalid");
  }
  return {
    ...(typeof workbenchId === "string" ? { workbenchId } : {}),
    body,
    ...(typeof canceledAt === "string" ? { canceledAt } : {}),
    ...(typeof clarificationPrompt === "string" ? { clarificationPrompt } : {}),
    ...(typeof clarificationReasonCode === "string" ? { clarificationReasonCode } : {}),
    createdAt,
    ...(typeof dismissedAt === "string" ? { dismissedAt } : {}),
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
        (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        record.inputId, record.idempotencyKey, record.body, record.status, record.workbenchId ?? null, record.createdAt, record.updatedAt,
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
      "SELECT * FROM joi_inbox_messages WHERE dismissed_at IS NULL ORDER BY created_at, input_id",
    ).all()).map((row) => mapRow(row as Row));
  }

  async clarify(inputId: string, patch: { workbenchId?: string; text?: string }): Promise<JoiInboxRecord | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      if (row === undefined) return null;
      const current = mapRow(row);
      if (current.status !== "CLARIFICATION_REQUIRED") return null;
      const now = new Date().toISOString();
      const nextBody = patch.text === undefined ? current.body : `${current.body}\n\n[用户补充] ${patch.text}`;
      const nextWorkbench = patch.workbenchId ?? current.workbenchId;
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET body = ?, workbench_id = ?, status = 'PENDING', clarification_reason_code = NULL,
          clarification_prompt = NULL, updated_at = ?
        WHERE input_id = ? AND status = 'CLARIFICATION_REQUIRED'`).run(nextBody, nextWorkbench ?? null, now, inputId);
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
        SET status = 'CONSUMED', canceled_at = ?, clarification_reason_code = NULL,
          clarification_prompt = NULL, updated_at = ?
        WHERE input_id = ? AND status IN ('PENDING', 'CLARIFICATION_REQUIRED')`).run(now, now, inputId);
      if (result.changes === 0) return null;
      const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      return updated === undefined ? null : mapRow(updated);
    });
  }

  async dismiss(inputId: string): Promise<JoiInboxRecord | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      if (row === undefined) return null;
      const current = mapRow(row);
      if (current.status !== "CONSUMED" || current.dismissedAt !== undefined) return null;
      const activeExecution = connection.prepare(`SELECT 1
        FROM work_items w
        LEFT JOIN partner_runs pr ON pr.work_id = w.work_id
        WHERE w.input_id = ?
          AND (w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED')
            OR pr.status NOT IN ('COMPLETED', 'FAILED', 'UNKNOWN'))
        LIMIT 1`).get(inputId);
      if (activeExecution !== undefined) return null;
      const hasWork = connection.prepare("SELECT 1 FROM work_items WHERE input_id = ? LIMIT 1").get(inputId);
      if (hasWork !== undefined) {
        const currentOutcome = connection.prepare(`SELECT 1 FROM joi_goal_result_sets s
          JOIN joi_goal_outcomes o ON o.input_id = s.original_input_id AND o.result_revision = s.revision
          WHERE s.original_input_id = ? AND s.revision > 0`).get(inputId);
        if (currentOutcome === undefined) return null;
      }
      const now = new Date().toISOString();
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET dismissed_at = ?, updated_at = ?
        WHERE input_id = ? AND status = 'CONSUMED' AND dismissed_at IS NULL`).run(now, now, inputId);
      if (result.changes === 0) return null;
      const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      return updated === undefined ? null : mapRow(updated);
    });
  }

  async listActivity(limit = 100): Promise<JoiActivityDto[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.database.transaction((connection) => connection.prepare(`
      SELECT activity_id, workbench_id, kind, occurred_at, status, work_id FROM (
        SELECT input_id AS activity_id, workbench_id, 'MESSAGE' AS kind, created_at AS occurred_at, status, NULL AS work_id
          FROM joi_inbox_messages
        UNION ALL
        SELECT turn_id, workbench_id, 'TURN', created_at, status, NULL FROM joi_turns
        UNION ALL
        SELECT work_id, workbench_id, 'WORK', created_at, status, work_id FROM work_items
        UNION ALL
        SELECT event_id, workbench_id, 'PARTNER_RESULT', created_at, status, work_id FROM partner_result_events
      ) ORDER BY occurred_at DESC, activity_id DESC LIMIT ?`).all(safeLimit)) as Record<string, unknown>[];
    return rows.map((row) => {
      if (typeof row.activity_id !== "string" || typeof row.kind !== "string"
        || typeof row.occurred_at !== "string" || typeof row.status !== "string") throw new Error("joi_activity_record_invalid");
      return {
        activityId: row.activity_id,
        ...(typeof row.workbench_id === "string" ? { workbenchId: row.workbench_id } : {}),
        kind: row.kind as JoiActivityDto["kind"],
        occurredAt: row.occurred_at,
        status: row.status,
        ...(typeof row.work_id === "string" ? { workId: row.work_id } : {}),
      };
    });
  }

  async loadInput(inputId: string): Promise<JoiPendingInput | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT input_id, body, status, workbench_id, goal_input_id, result_revision FROM joi_inbox_messages WHERE input_id = ?",
    ).get(inputId)) as Row | undefined;
    if (row === undefined) return null;
    if (typeof row.input_id !== "string" || typeof row.body !== "string" || typeof row.status !== "string") {
      throw new Error("joi_inbox_record_invalid");
    }
    if (row.workbench_id !== null && typeof row.workbench_id !== "string") throw new Error("joi_inbox_record_invalid");
    if (row.goal_input_id !== null && row.goal_input_id !== undefined && typeof row.goal_input_id !== "string") throw new Error("joi_inbox_record_invalid");
    if (row.result_revision !== null && row.result_revision !== undefined && typeof row.result_revision !== "number") throw new Error("joi_inbox_record_invalid");
    const attachments = this.database.transaction((connection) => connection.prepare(`SELECT a.attachment_id, a.filename, a.mime_type, a.size
      FROM joi_inbox_attachments ia JOIN joi_attachments a ON a.attachment_id = ia.attachment_id
      WHERE ia.input_id = ? ORDER BY a.created_at, a.attachment_id`).all(inputId)) as Record<string, unknown>[];
    return {
      ...(typeof row.workbench_id === "string" ? { workbenchId: row.workbench_id } : {}),
      ...(attachments.length === 0 ? {} : { attachments: attachments.map((attachment) => {
        if (typeof attachment.attachment_id !== "string" || typeof attachment.filename !== "string"
          || typeof attachment.mime_type !== "string" || typeof attachment.size !== "number") throw new Error("joi_attachment_record_invalid");
        return { attachmentId: attachment.attachment_id, filename: attachment.filename, mimeType: attachment.mime_type, size: attachment.size };
      }) }),
      body: row.body,
      ...(typeof row.goal_input_id === "string" ? { goalInputId: row.goal_input_id } : {}),
      inputId: row.input_id,
      ...(typeof row.result_revision === "number" ? { resultRevision: row.result_revision } : {}),
      status: row.status as JoiPendingInput["status"],
    };
  }

  async enqueuePartnerResult(event: { workbenchId: string; eventId: string; resultId: string; status: string; summary: string; workId: string }): Promise<string | null> {
    return this.database.transaction((connection) => {
      const source = connection.prepare(`SELECT r.created_at, w.input_id FROM work_results r
        JOIN work_items w ON w.work_id = r.work_id
        JOIN partner_result_events e ON e.run_id = r.run_id AND e.status = r.status
        WHERE r.result_id = ? AND r.workbench_id = ? AND r.work_id = ? AND r.status = ?
          AND r.is_authoritative = 1 AND e.event_id = ?`).get(
        event.resultId, event.workbenchId, event.workId, event.status,
        event.eventId,
      ) as { created_at?: unknown; input_id?: unknown } | undefined;
      if (typeof source?.created_at !== "string" || typeof source.input_id !== "string") throw new Error("partner_result_event_not_found");
      const goalInputId = source.input_id;
      connection.prepare(`INSERT OR IGNORE INTO joi_goal_result_sets
        (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 0, 0, ?)`)
        .run(goalInputId, source.created_at);
      const member = connection.prepare(`INSERT OR IGNORE INTO joi_goal_result_members
        (original_input_id, event_id, revision) VALUES (?, ?, 1)`).run(goalInputId, event.eventId);
      if (member.changes > 0) {
        connection.prepare(`UPDATE joi_goal_result_sets SET revision = revision + 1, updated_at = ?
          WHERE original_input_id = ?`).run(source.created_at, goalInputId);
        const revisionRow = connection.prepare(`SELECT revision FROM joi_goal_result_sets
          WHERE original_input_id = ?`).get(goalInputId) as { revision?: unknown } | undefined;
        if (typeof revisionRow?.revision !== "number") throw new Error("goal_result_revision_invalid");
        connection.prepare(`UPDATE joi_goal_result_members SET revision = ?
          WHERE original_input_id = ? AND event_id = ?`).run(revisionRow.revision, goalInputId, event.eventId);
      }
      const resultSet = connection.prepare(`SELECT revision, synthesized_revision FROM joi_goal_result_sets
        WHERE original_input_id = ?`).get(goalInputId) as { revision?: unknown; synthesized_revision?: unknown } | undefined;
      if (typeof resultSet?.revision !== "number" || typeof resultSet.synthesized_revision !== "number") throw new Error("goal_result_set_invalid");
      if (resultSet.synthesized_revision >= resultSet.revision) return null;
      const active = connection.prepare(`SELECT 1 FROM work_items
        WHERE input_id = ? AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1`).get(goalInputId);
      if (active !== undefined) return null;
      const results = connection.prepare(`SELECT r.result_id, r.work_id, r.status, r.summary
        FROM joi_goal_result_members m
        JOIN partner_result_events e ON e.event_id = m.event_id
        JOIN work_results r ON r.run_id = e.run_id AND r.status = e.status AND r.is_authoritative = 1
        WHERE m.original_input_id = ? AND m.revision <= ?
        ORDER BY m.revision, m.event_id`).all(goalInputId, resultSet.revision) as Row[];
      const inputId = `joi_result_input:goal:${goalInputId}`;
      const body = [
        "All currently planned work for one original user goal is terminal and ready for synthesis.",
        `goalInputId=${goalInputId}`,
        `resultRevision=${String(resultSet.revision)}`,
        ...results.map((row) => `resultId=${String(row.result_id)} workId=${String(row.work_id)} status=${String(row.status)} summary=${String(row.summary).slice(0, 320)}`),
        "Use work_read_result only if the bounded summary is insufficient.",
        "Synthesize one concise, opinionated completion update for the user, call turn_complete with RESULT_SYNTHESIZED, and do not dump raw per-Agent output.",
      ].join("\n");
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, goal_input_id, result_revision, created_at, updated_at)
        VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)
        ON CONFLICT(input_id) DO UPDATE SET body = excluded.body, status = 'PENDING',
          result_revision = excluded.result_revision, updated_at = excluded.updated_at
        WHERE excluded.result_revision > COALESCE(joi_inbox_messages.result_revision, 0)`).run(
        inputId, `partner_result_goal:${goalInputId}`, body, event.workbenchId, goalInputId, resultSet.revision,
        source.created_at, source.created_at,
      );
      connection.prepare(`UPDATE joi_goal_result_sets SET synthetic_input_id = ? WHERE original_input_id = ?`)
        .run(inputId, goalInputId);
      return inputId;
    });
  }

  async enqueueSystemSignal(input: { workbenchId: string; signalId: string; type: string }): Promise<string> {
    const inputId = `joi_signal_input:${input.signalId}`;
    const now = new Date().toISOString();
    this.database.transaction((connection) => connection.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
      (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
      VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`
    ).run(
      inputId,
      `system_signal:${input.signalId}`,
      `A persisted Workbench-scoped system signal is ready for orchestration.\ntype=${input.type}\nsignalId=${input.signalId}`,
      input.workbenchId,
      now,
      now,
    ));
    return inputId;
  }

  async requireClarification(inputId: string, reasonCode: string, prompt?: string): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = ?, clarification_prompt = ?, updated_at = ?
        WHERE input_id = ? AND status <> 'CONSUMED'`).run(
        reasonCode, prompt ?? null, new Date().toISOString(), inputId,
      );
    });
  }

  async createTurn(input: {
    workbenchId: string;
    createdAt: string;
    inputId: string;
    modelRevisionId: string;
    sessionId: string;
    sourceRevisionId: string;
    turnId: string;
  }): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, source_revision_id, model_revision_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`).run(
        input.turnId, input.inputId, input.workbenchId, input.sessionId, input.sourceRevisionId,
        input.modelRevisionId, input.createdAt, input.createdAt,
      );
      connection.prepare(`UPDATE joi_inbox_messages SET status = 'ROUTED', workbench_id = ?, updated_at = ?
        WHERE input_id = ? AND status <> 'CONSUMED'`).run(input.workbenchId, input.createdAt, input.inputId);
    });
  }

  async completeInput(inputId: string, turnId: string, completion?: { completionSummary: string }) {
    return this.database.transaction((connection) => {
      const now = new Date().toISOString();
      connection.prepare("UPDATE joi_turns SET status = 'COMPLETED', updated_at = ? WHERE turn_id = ?").run(now, turnId);
      const synthesis = connection.prepare(`SELECT goal_input_id, result_revision FROM joi_inbox_messages
        WHERE input_id = ?`).get(inputId) as { goal_input_id?: unknown; result_revision?: unknown } | undefined;
      if (typeof synthesis?.goal_input_id === "string" && typeof synthesis.result_revision === "number") {
        const current = connection.prepare(`SELECT revision FROM joi_goal_result_sets
          WHERE original_input_id = ?`).get(synthesis.goal_input_id) as { revision?: unknown } | undefined;
        if (typeof current?.revision !== "number") throw new Error("goal_result_set_invalid");
        if (current.revision !== synthesis.result_revision || completion === undefined) {
          connection.prepare(`UPDATE joi_inbox_messages SET status = 'PENDING', updated_at = ? WHERE input_id = ?`)
            .run(now, inputId);
          return { goalInputId: synthesis.goal_input_id, goalOutcomePersisted: false, resultRevision: synthesis.result_revision };
        }
        const summary = normalizeCompletionSummary(completion.completionSummary);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(input_id) DO UPDATE SET result_revision = excluded.result_revision,
            completion_summary = excluded.completion_summary, completed_at = excluded.completed_at,
            updated_at = excluded.updated_at
          WHERE excluded.result_revision >= joi_goal_outcomes.result_revision`).run(
          synthesis.goal_input_id, synthesis.result_revision, summary, now, now,
        );
        connection.prepare(`UPDATE joi_goal_result_sets SET synthesized_revision = ?, updated_at = ?
          WHERE original_input_id = ? AND revision = ?`).run(
          synthesis.result_revision, now, synthesis.goal_input_id, synthesis.result_revision,
        );
        connection.prepare(`UPDATE partner_result_events SET consumed_at = ? WHERE event_id IN (
          SELECT event_id FROM joi_goal_result_members WHERE original_input_id = ? AND revision <= ?
        ) AND consumed_at IS NULL`).run(now, synthesis.goal_input_id, synthesis.result_revision);
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = ?
          WHERE input_id = ? AND status <> 'CLARIFICATION_REQUIRED'`).run(now, inputId);
        return { goalInputId: synthesis.goal_input_id, goalOutcomePersisted: true, resultRevision: synthesis.result_revision };
      }
      connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = ?
        WHERE input_id = ? AND status <> 'CLARIFICATION_REQUIRED'`).run(now, inputId);
      connection.prepare("UPDATE partner_result_events SET consumed_at = ? WHERE input_id = ? AND consumed_at IS NULL").run(now, inputId);
      return undefined;
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
