/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiInboxRecord, JoiInboxRepository, JoiInboxStatus } from "../../application/ports/joi-inbox.js";
import type { JoiCoordinatorStore, JoiPendingInput } from "../../application/ports/joi-coordinator.js";
import type { Clock } from "../../application/ports/runtime-store.js";
import type { JoiActivityDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import { normalizeCompletionSummary, sanitizeAgentConversationText } from "../../application/partners/agent-conversation-presentation.js";
import type { JoiInputCompletion } from "../../application/ports/joi-coordinator.js";
import { normalizeJoiFailureReasonCode } from "../../application/joi/joi-input-failure.js";
import { cascadeDependencyCancellation } from "./sqlite-work-dependency-cascade.js";
import { closeHistoricalReviewInTransaction } from "./sqlite-joi-harness-review-closure.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function cancelQueuedWork(connection: DatabaseSync, inputId: string, now: string): void {
  connection.prepare(`UPDATE joi_user_action_requests
    SET status = 'CANCELED', updated_at = ? WHERE input_id = ? AND status IN ('OPEN', 'RESOLVED')`).run(now, inputId);
  // Hard cancel: in-flight work is revoked too. Its run is aborted by the dispatch actor
  // on a later tick; the terminal rows here make any late settle non-authoritative
  // (work_results.record treats a CANCELED work as late) and unclaimable.
  const queuedWorkIds = (connection.prepare(`SELECT work_id FROM work_items
    WHERE input_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING')`).all(inputId) as { work_id?: unknown }[])
    .map((row) => String(row.work_id));
  connection.prepare(`UPDATE work_items SET status = 'CANCELED', updated_at = ?
    WHERE input_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING')`).run(now, inputId);
  // Successors of the canceled Works (possibly owned by other inputs) must not run either.
  for (const workId of queuedWorkIds) {
    cascadeDependencyCancellation(connection, { cancelReason: "input_canceled", now, workId });
  }
  // A canceled queued attempt must not remain claimable by a later AgentActor tick.
  connection.prepare(`UPDATE dispatch_attempts SET status = 'FAILED', updated_at = ?
    WHERE work_id IN (SELECT work_id FROM work_items WHERE input_id = ? AND status = 'CANCELED')
      AND status NOT IN ('COMPLETED', 'FAILED', 'UNKNOWN')`).run(now, inputId);
  connection.prepare(`UPDATE outbox SET status = 'DONE', claim_owner = NULL, claim_until = NULL
    WHERE outbox_id IN (
      SELECT a.outbox_id FROM dispatch_attempts a
      JOIN work_items w ON w.work_id = a.work_id
      WHERE w.input_id = ? AND w.status = 'CANCELED' AND a.outbox_id IS NOT NULL
    ) AND status IN ('PENDING', 'CLAIMED')`).run(inputId);
  connection.prepare(`UPDATE partner_runs SET status = 'FAILED', updated_at = ?
    WHERE status IN ('RUNNING', 'WAITING_INPUT', 'WAITING_AUTH') AND work_id IN (
      SELECT work_id FROM work_items WHERE input_id = ? AND status = 'CANCELED')`).run(now, inputId);
  connection.prepare(`UPDATE dispatch_attempts SET status = 'FAILED', updated_at = ?
    WHERE status IN ('WAITING_INPUT', 'WAITING_AUTH') AND work_id IN (
      SELECT work_id FROM work_items WHERE input_id = ? AND status = 'CANCELED')`).run(now, inputId);
}

/**
 * A review is a derived input, so its successful Turn must close the goal map in
 * the same transaction that consumes the review row. The checks mirror the harness
 * store's clearMap guard and deliberately remain false when the review opened work
 * or left an unresolved path behind.
 */
function clearCompletedReviewMap(connection: DatabaseSync, goalInputId: string, turnId: string, now: string): boolean {
  return connection.prepare(`
    UPDATE joi_harness_maps AS m
       SET status = 'CLEARED', cleared_at = ?, revision = revision + 1, updated_at = ?
     WHERE m.goal_input_id = ? AND m.status = 'ACTIVE'
       AND EXISTS (
         SELECT 1 FROM joi_turns t
         JOIN joi_inbox_messages r ON r.input_id = t.input_id
         JOIN joi_goal_result_sets current_rs ON current_rs.original_input_id = m.goal_input_id
          WHERE t.turn_id = ? AND t.status IN ('RUNNING', 'WAITING')
            AND r.goal_input_id = m.goal_input_id
            AND r.input_id = 'joi_harness_review:goal:' || m.goal_input_id || ':r' || current_rs.revision
            AND current_rs.revision = m.reviewed_revision
       )
       AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = m.goal_input_id
                        AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
       AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.goal_input_id = m.goal_input_id
                        AND p.status = 'OPEN')
       AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = m.goal_input_id
                        AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id))
       AND EXISTS (
         SELECT 1 FROM joi_goal_result_sets rs
         JOIN joi_goal_outcomes o ON o.input_id = rs.original_input_id
                                  AND o.result_revision = rs.revision
          WHERE rs.original_input_id = m.goal_input_id
            AND rs.revision > 0
            AND rs.synthesized_revision = rs.revision
            AND m.reviewed_revision = rs.revision
            AND o.disposition = 'COMPLETED'
       )`).run(now, now, goalInputId, turnId).changes > 0;
}

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
  const failedAt = row.failed_at;
  const failureCount = row.failure_count;
  const failureExecutionStarted = row.failure_execution_started;
  const failureReasonCode = row.failure_reason_code;
  const updatedAt = row.updated_at;
  const automationRoutineId = row.automation_routine_id;
  if (typeof inputId !== "string" || typeof idempotencyKey !== "string" || typeof body !== "string"
    || typeof status !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string"
    || (workbenchId !== null && typeof workbenchId !== "string")
    || (canceledAt !== null && canceledAt !== undefined && typeof canceledAt !== "string")
    || (clarificationPrompt !== null && clarificationPrompt !== undefined && typeof clarificationPrompt !== "string")
    || (clarificationReasonCode !== null && clarificationReasonCode !== undefined && typeof clarificationReasonCode !== "string")
    || (dismissedAt !== null && dismissedAt !== undefined && typeof dismissedAt !== "string")
    || (failedAt !== null && failedAt !== undefined && typeof failedAt !== "string")
    || (failureCount !== null && failureCount !== undefined && (typeof failureCount !== "number" || !Number.isInteger(failureCount) || failureCount < 1))
    || (failureExecutionStarted !== null && failureExecutionStarted !== undefined && failureExecutionStarted !== 0 && failureExecutionStarted !== 1)
    || (failureReasonCode !== null && failureReasonCode !== undefined && typeof failureReasonCode !== "string")
    || (automationRoutineId !== null && automationRoutineId !== undefined && typeof automationRoutineId !== "string")) {
    throw new Error("joi_inbox_record_invalid");
  }
  return {
    ...(typeof workbenchId === "string" ? { workbenchId } : {}),
    ...(typeof automationRoutineId === "string" ? { automationRoutineId } : {}),
    body,
    ...(typeof canceledAt === "string" ? { canceledAt } : {}),
    ...(typeof clarificationPrompt === "string" ? { clarificationPrompt } : {}),
    ...(typeof clarificationReasonCode === "string" ? { clarificationReasonCode } : {}),
    createdAt,
    ...(typeof dismissedAt === "string" ? { dismissedAt } : {}),
    ...(typeof failedAt === "string" ? { failedAt } : {}),
    ...(typeof failureCount === "number" ? { failureCount } : {}),
    ...(failureExecutionStarted === 0 || failureExecutionStarted === 1 ? { failureExecutionStarted: failureExecutionStarted === 1 } : {}),
    ...(typeof failureReasonCode === "string" ? { failureReasonCode: normalizeJoiFailureReasonCode(failureReasonCode) } : {}),
    idempotencyKey,
    inputId,
    status: status as JoiInboxStatus,
    updatedAt,
  };
}

export class SqliteJoiInboxRepository implements JoiInboxRepository, JoiCoordinatorStore {
  readonly #clock: Clock;

  constructor(private readonly database: TransactionalDatabase, clock?: Clock) {
    this.#clock = clock ?? { now: () => new Date() };
  }

  async create(record: JoiInboxRecord): Promise<JoiInboxRecord> {
    return this.database.transaction((connection) => {
      const existing = connection.prepare("SELECT * FROM joi_inbox_messages WHERE idempotency_key = ?").get(record.idempotencyKey) as Row | undefined;
      if (existing !== undefined) return mapRow(existing);
      connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, automation_routine_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        record.inputId, record.idempotencyKey, record.body, record.status, record.workbenchId ?? null, record.automationRoutineId ?? null, record.createdAt, record.updatedAt,
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
      `SELECT i.*, CASE WHEN EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = i.input_id) THEN 1 ELSE 0 END AS failure_execution_started
        FROM joi_inbox_messages i WHERE i.dismissed_at IS NULL ORDER BY i.created_at, i.input_id`,
    ).all()).map((row) => mapRow(row as Row));
  }

  async clarify(inputId: string, patch: { actionChoice?: "RESUME" | "CONTINUE" | "ACCEPT_CURRENT"; expectedReasonCode?: string; workbenchId?: string; text?: string }): Promise<JoiInboxRecord | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      if (row === undefined) return null;
      const current = mapRow(row);
      if (current.status !== "CLARIFICATION_REQUIRED") return null;
      if (patch.expectedReasonCode !== undefined && current.clarificationReasonCode !== patch.expectedReasonCode) return null;
      const action = connection.prepare(`SELECT action_id, kind, result_revision FROM joi_user_action_requests
        WHERE input_id = ? AND status = 'OPEN' ORDER BY created_at, action_id LIMIT 1`).get(inputId) as {
          action_id?: unknown;
          kind?: unknown;
          result_revision?: unknown;
        } | undefined;
      if (action !== undefined) {
        if (typeof action.action_id !== "string" || typeof action.kind !== "string") throw new Error("joi_user_action_invalid");
        if (action.kind === "PARTNER_QUESTION" && patch.text === undefined) return null;
        if (action.kind === "RECOVERY_DECISION" && patch.actionChoice !== "RESUME") return null;
        if (action.kind === "GOAL_CONTINUATION") {
          if (patch.actionChoice !== "CONTINUE" && patch.actionChoice !== "ACCEPT_CURRENT") return null;
          if (typeof action.result_revision !== "number") throw new Error("joi_user_action_invalid");
          const currentOutcome = connection.prepare(`SELECT o.disposition
            FROM joi_goal_result_sets rs
            JOIN joi_goal_outcomes o ON o.input_id = rs.original_input_id AND o.result_revision = rs.revision
            JOIN joi_harness_maps m ON m.goal_input_id = rs.original_input_id
            WHERE rs.original_input_id = ? AND rs.revision = ? AND rs.synthesized_revision = rs.revision
              AND o.disposition = 'CONTINUE' AND m.status = 'ACTIVE'
              AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = rs.original_input_id
                                AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))`).get(inputId, action.result_revision);
          if (currentOutcome === undefined) return null;
          const now = this.#clock.now().toISOString();
          if (patch.actionChoice === "CONTINUE") {
            const authorized = connection.prepare(`UPDATE joi_harness_maps
              SET continuation_allowance = continuation_allowance + 2, revision = revision + 1, updated_at = ?
              WHERE goal_input_id = ? AND status = 'ACTIVE'`).run(now, inputId);
            if (authorized.changes !== 1) throw new Error("joi_goal_continuation_conflict");
          } else {
            const accepted = connection.prepare(`UPDATE joi_goal_outcomes
              SET disposition = 'ACCEPTED_WITH_GAPS', completed_at = ?, updated_at = ?
              WHERE input_id = ? AND result_revision = ? AND disposition = 'CONTINUE'`).run(now, now, inputId, action.result_revision);
            if (accepted.changes !== 1) throw new Error("joi_goal_continuation_conflict");
            const cleared = connection.prepare(`UPDATE joi_harness_maps
              SET status = 'CLEARED', cleared_at = ?, revision = revision + 1, updated_at = ?
              WHERE goal_input_id = ? AND status = 'ACTIVE'`).run(now, now, inputId);
            if (cleared.changes !== 1) throw new Error("joi_goal_continuation_conflict");
          }
          const applied = connection.prepare(`UPDATE joi_user_action_requests
            SET status = 'APPLIED', decision = ?, resolved_at = ?, applied_at = ?, updated_at = ?
            WHERE action_id = ? AND status = 'OPEN'`).run(patch.actionChoice, now, now, now, action.action_id);
          if (applied.changes !== 1) throw new Error("joi_goal_continuation_conflict");
          const consumed = connection.prepare(`UPDATE joi_inbox_messages
            SET status = 'CONSUMED', clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
            WHERE input_id = ? AND status = 'CLARIFICATION_REQUIRED'`).run(now, inputId);
          if (consumed.changes !== 1) throw new Error("joi_goal_continuation_conflict");
          const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
          return updated === undefined ? null : mapRow(updated);
        }
      } else if (patch.actionChoice !== undefined) {
        return null;
      }
      const now = this.#clock.now().toISOString();
      const nextBody = patch.text === undefined ? current.body : `${current.body}\n\n[用户补充] ${patch.text}`;
      const nextWorkbench = patch.workbenchId ?? current.workbenchId;
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET body = ?, workbench_id = ?, status = 'PENDING', clarification_reason_code = NULL,
          clarification_prompt = NULL, updated_at = ?
        WHERE input_id = ? AND status = 'CLARIFICATION_REQUIRED'`).run(nextBody, nextWorkbench ?? null, now, inputId);
      if (result.changes === 0) return null;
      if (action !== undefined) {
        const resolved = connection.prepare(`UPDATE joi_user_action_requests
          SET status = 'RESOLVED', decision = 'RESUME', resolved_at = ?, updated_at = ?
          WHERE action_id = ? AND status = 'OPEN'`).run(now, now, action.action_id as string);
        if (resolved.changes !== 1) throw new Error("joi_user_action_resolution_conflict");
      }
      const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      return updated === undefined ? null : mapRow(updated);
    });
  }

  async cancel(inputId: string): Promise<JoiInboxRecord | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      if (row === undefined) return null;
      const current = mapRow(row);
      const now = this.#clock.now().toISOString();
      if (current.status === "CONSUMED") {
        // A consumed goal can still hold live work: a partner may be mid-run or paused
        // with a question whose answer turn never resumed the work. The home feed offers
        // a cancel affordance on every non-terminal card, so honor it: hard-cancel the
        // goal's not-yet-final work (in-flight runs are aborted by their dispatch actors
        // and converge as non-authoritative late results); otherwise the card could
        // never be canceled or dismissed.
        if (current.dismissedAt !== undefined || current.canceledAt !== undefined || current.failedAt !== undefined) return null;
        const cancelableWork = connection.prepare(`SELECT 1 FROM work_items
          WHERE input_id = ? AND status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING') LIMIT 1`).get(inputId);
        if (cancelableWork === undefined) return null;
        const result = connection.prepare(`UPDATE joi_inbox_messages
          SET canceled_at = ?, clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
          WHERE input_id = ? AND status = 'CONSUMED' AND dismissed_at IS NULL AND canceled_at IS NULL AND failed_at IS NULL`).run(now, now, inputId);
        if (result.changes === 0) return null;
        cancelQueuedWork(connection, inputId, now);
        finishAutomationRun(connection, inputId, "CANCELED", now);
        const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
        return updated === undefined ? null : mapRow(updated);
      }
      // Every remaining status (PENDING, CLARIFICATION_REQUIRED, ROUTED) is cancelable:
      // the CONSUMED branch above already returned for the terminal-row cases.
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CONSUMED', canceled_at = ?, clarification_reason_code = NULL,
          clarification_prompt = NULL, updated_at = ?
        WHERE input_id = ? AND status IN ('PENDING', 'CLARIFICATION_REQUIRED', 'ROUTED')`).run(now, now, inputId);
      if (result.changes === 0) return null;
      // Canceling a goal also cancels its not-yet-final work; a WAITING work would
      // otherwise block the goal's synthesis forever with nobody left to answer it.
      cancelQueuedWork(connection, inputId, now);
      finishAutomationRun(connection, inputId, "CANCELED", now);
      const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      return updated === undefined ? null : mapRow(updated);
    });
  }

  async closeHistoricalReview(inputId: string): Promise<JoiInboxRecord | null> {
    return this.database.transaction((connection) => closeHistoricalReviewInTransaction(connection, inputId));
  }

  async cancelQueued(): Promise<number> {
    return this.database.transaction((connection) => {
      // Emergency stop honors the same hard-cancel semantics as a single cancel: routed
      // goals and goals with in-flight runs are revoked too; their live runs are aborted
      // by their actors and converge as late, non-authoritative results.
      const rows = connection.prepare(`SELECT i.input_id FROM joi_inbox_messages i
        WHERE i.dismissed_at IS NULL AND i.canceled_at IS NULL
          AND (i.status IN ('PENDING', 'CLARIFICATION_REQUIRED', 'ROUTED') OR (
            i.status = 'CONSUMED'
            AND EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = i.input_id AND w.status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING'))
          ))`).all() as { input_id?: unknown }[];
      const now = this.#clock.now().toISOString();
      let canceled = 0;
      for (const row of rows) {
        if (typeof row.input_id !== 'string') continue;
        const result = connection.prepare(`UPDATE joi_inbox_messages
          SET status = 'CONSUMED', canceled_at = ?, clarification_reason_code = NULL,
            clarification_prompt = NULL, updated_at = ?
          WHERE input_id = ? AND dismissed_at IS NULL AND canceled_at IS NULL`).run(now, now, row.input_id);
        if (result.changes === 0) continue;
        cancelQueuedWork(connection, row.input_id, now);
        finishAutomationRun(connection, row.input_id, "CANCELED", now);
        canceled += 1;
      }
      return canceled;
    });
  }

  async park(inputId: string, failure: { failureCount: number; reasonCode: string }): Promise<JoiInboxRecord | null> {
    if (!Number.isInteger(failure.failureCount) || failure.failureCount < 1
      || failure.reasonCode.length > 80 || !/^[A-Za-z0-9_.:-]+$/u.test(failure.reasonCode)) {
      throw new Error("joi_input_failure_invalid");
    }
    return this.database.transaction((connection) => {
      const now = this.#clock.now().toISOString();
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CONSUMED', canceled_at = NULL, failed_at = ?, failure_reason_code = ?,
          failure_count = ?, clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
        WHERE input_id = ? AND status = 'PENDING'`).run(
        now, failure.reasonCode, failure.failureCount, now, inputId,
      );
      if (result.changes === 0) return null;
      finishAutomationRun(connection, inputId, "FAILED", now, failure.reasonCode);
      const updated = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      return updated === undefined ? null : mapRow(updated);
    });
  }

  async readDisplayText(inputId: string): Promise<string | null> {
    const row = this.database.transaction((connection) => connection.prepare(`SELECT body FROM joi_inbox_messages
      WHERE input_id = ? AND dismissed_at IS NULL AND goal_input_id IS NULL
        AND input_id NOT LIKE 'joi_result_input:%' AND input_id NOT LIKE 'joi_harness_review:%'
        AND input_id NOT LIKE 'joi_signal_input:%'`).get(inputId)) as { body?: unknown } | undefined;
    return typeof row?.body === "string" ? sanitizeAgentConversationText(row.body) : null;
  }

  async retry(inputId: string, patch: { text?: string }): Promise<JoiInboxRecord | null> {
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
      if (row === undefined) return null;
      const current = mapRow(row);
      if (current.status !== "CONSUMED" || current.dismissedAt !== undefined) return null;
      // Synthetic orchestration inputs (result synthesis, harness review, system
      // signals) are never user goals and must not be re-queued from the home feed.
      if (inputId.startsWith("joi_result_input:") || inputId.startsWith("joi_harness_review:") || inputId.startsWith("joi_signal_input:")) return null;
      // Reviving a goal while its work is still live would double-dispatch it.
      const activeExecution = connection.prepare(`SELECT 1 FROM work_items
        WHERE input_id = ? AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1`).get(inputId);
      if (activeExecution !== undefined) return null;
      const now = this.#clock.now().toISOString();
      const nextBody = patch.text === undefined ? current.body : `${current.body}\n\n[用户补充] ${patch.text}`;
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET body = ?, status = 'PENDING', canceled_at = NULL, failed_at = NULL, failure_reason_code = NULL,
          failure_count = NULL, clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?, last_opened_at = ?
        WHERE input_id = ? AND status = 'CONSUMED' AND dismissed_at IS NULL`).run(nextBody, now, now, inputId);
      if (result.changes === 0) return null;
      connection.prepare(`UPDATE joi_harness_maps
        SET status = 'ACTIVE', cleared_at = NULL, feedback_recorded_at = NULL,
          revision = revision + 1, updated_at = ?
        WHERE goal_input_id = ? AND status = 'CLEARED'`).run(now, inputId);
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
      if (hasWork !== undefined && current.canceledAt === undefined) {
        const currentOutcome = connection.prepare(`SELECT 1 FROM joi_goal_result_sets s
          JOIN joi_goal_outcomes o ON o.input_id = s.original_input_id AND o.result_revision = s.revision
          WHERE s.original_input_id = ? AND s.revision > 0`).get(inputId);
        if (currentOutcome === undefined) return null;
      }
      const now = this.#clock.now().toISOString();
      const result = connection.prepare(`UPDATE joi_inbox_messages
        SET dismissed_at = ?, updated_at = ?
        WHERE input_id = ? AND status = 'CONSUMED' AND dismissed_at IS NULL`).run(now, now, inputId);
      if (result.changes === 0) return null;
      connection.prepare(`UPDATE joi_automation_runs SET status = 'CANCELED', result = 'CANCELED', completed_at = ?, reason_code = 'goal_removed'
        WHERE input_id IS NULL AND status IN ('PENDING', 'RUNNING', 'BLOCKED') AND routine_id IN (
          SELECT routine_id FROM joi_automations
          WHERE target_kind = 'GOAL_CONTINUATION' AND target_goal_input_id = ? AND deleted_at IS NULL
        )`).run(now, inputId);
      connection.prepare(`UPDATE joi_automations SET enabled = 0, deleted_at = ?, updated_at = ?
        WHERE target_kind = 'GOAL_CONTINUATION' AND target_goal_input_id = ? AND deleted_at IS NULL`).run(now, now, inputId);
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
      `SELECT i.input_id, i.body, i.status, i.workbench_id, i.goal_input_id, i.result_revision, i.automation_routine_id,
        (SELECT a.action_id FROM joi_user_action_requests a
          WHERE a.input_id = i.input_id AND a.status = 'RESOLVED' ORDER BY a.updated_at, a.action_id LIMIT 1) AS resolved_action_id,
        (SELECT a.work_id FROM joi_user_action_requests a
          WHERE a.input_id = i.input_id AND a.status = 'RESOLVED' ORDER BY a.updated_at, a.action_id LIMIT 1) AS resolved_work_id,
        (SELECT a.decision FROM joi_user_action_requests a
          WHERE a.input_id = i.input_id AND a.status = 'RESOLVED' ORDER BY a.updated_at, a.action_id LIMIT 1) AS resolved_decision
        FROM joi_inbox_messages i WHERE i.input_id = ?`,
    ).get(inputId)) as Row | undefined;
    if (row === undefined) return null;
    if (typeof row.input_id !== "string" || typeof row.body !== "string" || typeof row.status !== "string") {
      throw new Error("joi_inbox_record_invalid");
    }
    if (row.workbench_id !== null && typeof row.workbench_id !== "string") throw new Error("joi_inbox_record_invalid");
    if (row.goal_input_id !== null && row.goal_input_id !== undefined && typeof row.goal_input_id !== "string") throw new Error("joi_inbox_record_invalid");
    if (row.result_revision !== null && row.result_revision !== undefined && typeof row.result_revision !== "number") throw new Error("joi_inbox_record_invalid");
    if (row.automation_routine_id !== null && row.automation_routine_id !== undefined && typeof row.automation_routine_id !== "string") throw new Error("joi_inbox_record_invalid");
    if (row.resolved_action_id !== null && row.resolved_action_id !== undefined && typeof row.resolved_action_id !== "string") throw new Error("joi_user_action_invalid");
    if (row.resolved_work_id !== null && row.resolved_work_id !== undefined && typeof row.resolved_work_id !== "string") throw new Error("joi_user_action_invalid");
    if (row.resolved_decision !== null && row.resolved_decision !== undefined && row.resolved_decision !== "RESUME") throw new Error("joi_user_action_invalid");
    const attachments = this.database.transaction((connection) => connection.prepare(`SELECT a.attachment_id, a.filename, a.mime_type, a.size
      FROM joi_inbox_attachments ia JOIN joi_attachments a ON a.attachment_id = ia.attachment_id
      WHERE ia.input_id = ? ORDER BY a.created_at, a.attachment_id`).all(inputId)) as Record<string, unknown>[];
    return {
      ...(typeof row.workbench_id === "string" ? { workbenchId: row.workbench_id } : {}),
      ...(typeof row.automation_routine_id === "string" ? { automationRoutineId: row.automation_routine_id } : {}),
      ...(attachments.length === 0 ? {} : { attachments: attachments.map((attachment) => {
        if (typeof attachment.attachment_id !== "string" || typeof attachment.filename !== "string"
          || typeof attachment.mime_type !== "string" || typeof attachment.size !== "number") throw new Error("joi_attachment_record_invalid");
        return { attachmentId: attachment.attachment_id, filename: attachment.filename, mimeType: attachment.mime_type, size: attachment.size };
      }) }),
      body: row.body,
      ...(typeof row.goal_input_id === "string" ? { goalInputId: row.goal_input_id } : {}),
      inputId: row.input_id,
      ...(typeof row.result_revision === "number" ? { resultRevision: row.result_revision } : {}),
      ...(typeof row.resolved_action_id === "string" && typeof row.resolved_work_id === "string" && row.resolved_decision === "RESUME" ? {
        resolvedAction: { actionId: row.resolved_action_id, decision: "RESUME" as const, workId: row.resolved_work_id },
      } : {}),
      status: row.status as JoiPendingInput["status"],
    };
  }

  async enqueuePartnerResult(event: { workbenchId: string; eventId: string; resultId: string; status: string; summary: string; workId: string }): Promise<string | null> {
    return this.database.transaction((connection) => {
      const source = connection.prepare(`SELECT r.created_at, w.input_id, i.body AS goal_body FROM work_results r
        JOIN work_items w ON w.work_id = r.work_id
        JOIN joi_inbox_messages i ON i.input_id = w.input_id
        JOIN partner_result_events e ON e.run_id = r.run_id AND e.status = r.status
        WHERE r.result_id = ? AND r.workbench_id = ? AND r.work_id = ? AND r.status = ?
          AND r.is_authoritative = 1 AND e.event_id = ?`).get(
        event.resultId, event.workbenchId, event.workId, event.status,
        event.eventId,
      ) as { created_at?: unknown; goal_body?: unknown; input_id?: unknown } | undefined;
      if (typeof source?.created_at !== "string" || typeof source.input_id !== "string" || typeof source.goal_body !== "string") throw new Error("partner_result_event_not_found");
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
      const results = connection.prepare(`SELECT r.result_id, r.work_id, r.status, r.summary, w.title,
               v.status AS verification_status, v.reason_code AS verification_reason
        FROM joi_goal_result_members m
        JOIN partner_result_events e ON e.event_id = m.event_id
        JOIN work_results r ON r.run_id = e.run_id AND r.status = e.status AND r.is_authoritative = 1
        JOIN work_items w ON w.work_id = r.work_id
        LEFT JOIN work_result_verifications v ON v.result_id = r.result_id
        WHERE m.original_input_id = ? AND m.revision <= ?
        ORDER BY m.revision, m.event_id`).all(goalInputId, resultSet.revision) as Row[];
      const inputId = `joi_result_input:goal:${goalInputId}`;
      const body = [
        "All currently planned work for one original user goal is terminal and ready for synthesis.",
        `goalInputId=${goalInputId}`,
        `resultRevision=${String(resultSet.revision)}`,
        "Original user goal (authoritative):",
        source.goal_body.slice(0, 4_000),
        ...results.map((row) => {
          const verificationReason = typeof row.verification_reason === "string" && row.verification_reason !== ""
            ? row.verification_reason
            : "verification_failed";
          const verification = row.verification_status === "PASSED" ? "PASSED"
            : row.verification_status === "FAILED" ? `FAILED(${verificationReason})`
              : "NOT_REQUIRED";
          return `resultId=${String(row.result_id)} workId=${String(row.work_id)} title=${String(row.title).slice(0, 240)} status=${String(row.status)} verification=${verification} summary=${String(row.summary).slice(0, 320)}`;
        }),
        "Only COMPLETED results with verification=PASSED are verified evidence. A COMPLETED result with verification=NOT_REQUIRED is an unverified self-report: it may support the answer, but say so when the distinction matters. A FAILED/UNKNOWN result or verification=FAILED is a coverage gap; it does not invalidate other evidence and must not dominate the final answer unless that missing coverage is essential to the original goal.",
        "If verified completed results already answer the original goal, synthesize that answer, mention non-critical failures only as a brief trailing warning, and call turn_complete with RESULT_SYNTHESIZED.",
        "If the evidence is insufficient but a concrete next evidence layer can run without a user decision, credential or broader permission, summarize the bounded gap and call turn_complete with RESULT_CONTINUE. The Wayfinder review will arrange that next layer.",
        "If an essential gap remains, inspect structured failure facts: only retryable=true with sideEffectState=NONE permits a fresh work_reassign attempt. Prefer a different suitable available partner; only switch the current partner's model when no suitable alternative exists.",
        "For an essential auth, balance, configuration, skill or safety failure, a required user judgment, or sideEffectState OBSERVED/UNKNOWN, do not replay automatically; explain the missing coverage and call turn_complete with RESULT_BLOCKED.",
        "Use work_read_result only if the bounded summary is insufficient.",
        "Do not dump raw per-Agent output.",
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
    const now = this.#clock.now().toISOString();
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

  async requireClarification(inputId: string, reasonCode: string, prompt?: string, action?: {
    actionId: string;
    kind: "PARTNER_QUESTION";
    runId: string;
    workId: string;
  }): Promise<void> {
    this.database.transaction((connection) => {
      // Any live row may be (re-)raised into a question card, including an already
      // CONSUMED goal input: a partner question revives the goal so the user can answer
      // and the flow continues. Dismissed, canceled and parked rows stay untouched.
      const raised = connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = ?, clarification_prompt = ?, updated_at = ?
        WHERE input_id = ? AND dismissed_at IS NULL AND canceled_at IS NULL AND failed_at IS NULL`).run(
        reasonCode, prompt ?? null, this.#clock.now().toISOString(), inputId,
      );
      if (action !== undefined && raised.changes === 1) {
        const now = this.#clock.now().toISOString();
        connection.prepare(`INSERT INTO joi_user_action_requests
          (action_id, input_id, work_id, run_id, kind, status, reason_code, prompt, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
          ON CONFLICT(action_id) DO UPDATE SET reason_code = excluded.reason_code, prompt = excluded.prompt,
            updated_at = excluded.updated_at
          WHERE joi_user_action_requests.status = 'OPEN'`).run(
          action.actionId, inputId, action.workId, action.runId, action.kind, reasonCode,
          prompt ?? "搭档正在等待你的回答。", now, now,
        );
      }
    });
  }

  async completeResolvedAction(input: { actionId: string; inputId: string; turnId: string }): Promise<void> {
    this.database.transaction((connection) => {
      const now = this.#clock.now().toISOString();
      const action = connection.prepare(`UPDATE joi_user_action_requests
        SET status = 'APPLIED', applied_at = COALESCE(applied_at, ?), updated_at = ?
        WHERE action_id = ? AND input_id = ? AND status IN ('RESOLVED', 'APPLIED')`).run(
        now, now, input.actionId, input.inputId,
      );
      if (action.changes !== 1) throw new Error("joi_user_action_not_resolved");
      const turn = connection.prepare(`UPDATE joi_turns SET status = 'COMPLETED', updated_at = ?
        WHERE turn_id = ? AND input_id = ?`).run(now, input.turnId, input.inputId);
      if (turn.changes !== 1) throw new Error("joi_turn_input_mismatch");
      connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CONSUMED', clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
        WHERE input_id = ?`).run(now, input.inputId);
      connection.prepare(`UPDATE joi_automation_runs SET status = 'COMPLETED', result = 'COMPLETED', completed_at = ?, reason_code = NULL
        WHERE input_id = ? AND status IN ('PENDING', 'RUNNING', 'BLOCKED')`).run(now, input.inputId);
      connection.prepare("UPDATE joi_inbox_messages SET automation_routine_id = NULL WHERE input_id = ?").run(input.inputId);
    });
  }

  async createTurn(input: {
    workbenchId: string;
    createdAt: string;
    inputId: string;
    modelRevisionId?: string;
    sessionId: string;
    sourceRevisionId?: string;
    turnId: string;
  }): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, source_revision_id, model_revision_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?)`).run(
        input.turnId, input.inputId, input.workbenchId, input.sessionId, input.sourceRevisionId ?? null,
        input.modelRevisionId ?? null, input.createdAt, input.createdAt,
      );
      connection.prepare(`UPDATE joi_inbox_messages SET status = 'ROUTED', workbench_id = ?, updated_at = ?
        WHERE input_id = ? AND status <> 'CONSUMED'`).run(input.workbenchId, input.createdAt, input.inputId);
    });
  }

  async completeInput(inputId: string, turnId: string, completion?: JoiInputCompletion) {
    return this.database.transaction((connection) => {
      const now = this.#clock.now().toISOString();
      const review = connection.prepare(`SELECT goal_input_id FROM joi_inbox_messages
        WHERE input_id = ? AND input_id LIKE 'joi_harness_review:goal:%'`).get(inputId) as Row | undefined;
      if (typeof review?.goal_input_id === "string") {
        // This is intentionally inferred from mechanical facts rather than from the
        // model's prose: a normal completed review must not leave an ACTIVE map that
        // the periodic recovery pass later mislabels as historical corruption.
        clearCompletedReviewMap(connection, review.goal_input_id, turnId, now);
      }
      if (completion === undefined) {
        connection.prepare("UPDATE joi_turns SET status = 'COMPLETED', updated_at = ? WHERE turn_id = ?").run(now, turnId);
      } else {
        const completedTurn = connection.prepare(`UPDATE joi_turns SET status = 'COMPLETED', updated_at = ?
          WHERE turn_id = ? AND input_id = ?`).run(now, turnId, inputId);
        if (completedTurn.changes !== 1) throw new Error("joi_turn_input_mismatch");
      }
      const synthesis = connection.prepare(`SELECT goal_input_id, result_revision FROM joi_inbox_messages
        WHERE input_id = ?`).get(inputId) as { goal_input_id?: unknown; result_revision?: unknown } | undefined;
      if (typeof synthesis?.goal_input_id === "string" && typeof synthesis.result_revision === "number") {
        const current = connection.prepare(`SELECT revision FROM joi_goal_result_sets
          WHERE original_input_id = ?`).get(synthesis.goal_input_id) as { revision?: unknown } | undefined;
        if (typeof current?.revision !== "number") throw new Error("goal_result_set_invalid");
        if (current.revision !== synthesis.result_revision
          || completion === undefined
          || !["RESULT_SYNTHESIZED", "RESULT_CONTINUE", "RESULT_BLOCKED"].includes(completion.outcome)) {
          connection.prepare(`UPDATE joi_inbox_messages SET status = 'PENDING', updated_at = ? WHERE input_id = ?`)
            .run(now, inputId);
          return { goalInputId: synthesis.goal_input_id, goalOutcomePersisted: false, resultRevision: synthesis.result_revision };
        }
        const activeWork = connection.prepare(`SELECT 1 FROM work_items
          WHERE input_id = ? AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1`).get(synthesis.goal_input_id);
        if (activeWork !== undefined) {
          // Recovery reopened the goal while this result Turn was running. Do not publish a
          // stale goal outcome or advance synthesized_revision; a later result reactivates it.
          connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = ?
            WHERE input_id = ? AND status <> 'CLARIFICATION_REQUIRED'`).run(now, inputId);
          return { goalInputId: synthesis.goal_input_id, goalOutcomePersisted: false, resultRevision: synthesis.result_revision };
        }
        const summary = normalizeCompletionSummary(completion.completionSummary);
        if (summary === "") throw new DomainError("joi_goal_synthesis_summary_empty", "Goal synthesis must include a visible summary.");
        const disposition = completion.outcome === "RESULT_SYNTHESIZED" ? "COMPLETED"
          : completion.outcome === "RESULT_CONTINUE" ? "CONTINUE" : "BLOCKED";
        if (disposition === "COMPLETED") {
          const completedWork = connection.prepare(`SELECT 1 FROM work_items
            WHERE input_id = ? AND status = 'COMPLETED' LIMIT 1`).get(synthesis.goal_input_id);
          if (completedWork === undefined) {
            throw new DomainError("joi_goal_synthesis_without_completed_work", "A completed goal synthesis requires verified completed Work.");
          }
        }
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(input_id) DO UPDATE SET result_revision = excluded.result_revision,
            disposition = excluded.disposition, completion_summary = excluded.completion_summary, completed_at = excluded.completed_at,
            updated_at = excluded.updated_at
          WHERE excluded.result_revision >= joi_goal_outcomes.result_revision`).run(
          synthesis.goal_input_id, synthesis.result_revision, disposition, summary, now, now,
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
        return { disposition, goalInputId: synthesis.goal_input_id, goalOutcomePersisted: true, resultRevision: synthesis.result_revision };
      }
      if (completion?.outcome === "DIRECT_ANSWER" || completion?.outcome === "TEAM_READY") {
        const summary = normalizeCompletionSummary(completion.completionSummary);
        if (summary === "") throw new Error("joi_turn_completion_invalid");
        connection.prepare(`INSERT INTO joi_turn_completions
          (input_id, turn_id, outcome_kind, completion_summary, completed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(input_id) DO UPDATE SET turn_id = excluded.turn_id,
            outcome_kind = excluded.outcome_kind, completion_summary = excluded.completion_summary,
            completed_at = excluded.completed_at, updated_at = excluded.updated_at`).run(
          inputId, turnId, completion.outcome, summary, now, now,
        );
      }
      connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = ?
        WHERE input_id = ? AND status <> 'CLARIFICATION_REQUIRED'`).run(now, inputId);
      connection.prepare(`UPDATE joi_automation_runs SET status = 'COMPLETED', result = 'COMPLETED', completed_at = ?, reason_code = NULL
        WHERE input_id = ? AND status IN ('PENDING', 'RUNNING', 'BLOCKED')
          AND EXISTS (SELECT 1 FROM joi_inbox_messages WHERE input_id = ? AND status = 'CONSUMED')`).run(now, inputId, inputId);
      connection.prepare("UPDATE joi_inbox_messages SET automation_routine_id = NULL WHERE input_id = ?").run(inputId);
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
      this.#clock.now().toISOString(),
      turnId,
    ));
  }

  async updateTurnSource(turnId: string, sourceRevisionId: string, modelRevisionId: string): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`UPDATE joi_turns
      SET source_revision_id = ?, model_revision_id = ?, updated_at = ? WHERE turn_id = ?`).run(
      sourceRevisionId, modelRevisionId, this.#clock.now().toISOString(), turnId,
    ));
  }

  async failTurn(inputId: string, turnId: string): Promise<void> {
    this.database.transaction((connection) => {
      const now = this.#clock.now().toISOString();
      connection.prepare("UPDATE joi_turns SET status = 'FAILED', updated_at = ? WHERE turn_id = ?").run(now, turnId);
      // Re-driving is only safe when the failed turn committed nothing. If it already started
      // side effects (dispatched work, created routines, raised cards) or its work is still
      // live, replaying the same prompt would duplicate those side effects: the codebase treats
      // "revive after side effects" as a double-dispatch hazard everywhere else (see retry()).
      // Such inputs converge through their live work / result synthesis instead of being re-queued.
      const liveWork = connection.prepare(`SELECT 1 FROM work_items
        WHERE input_id = ? AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1`).get(inputId);
      const sideEffects = connection.prepare(`SELECT 1 FROM joi_turns
        WHERE input_id = ? AND side_effect_started = 1 LIMIT 1`).get(inputId);
      const nextStatus = liveWork !== undefined || sideEffects !== undefined ? "CONSUMED" : "PENDING";
      // Never kick a row that is waiting on the user back into the scheduler: an orphan
      // turn cleanup must not swallow a live question card (CLARIFICATION_REQUIRED).
      connection.prepare(`UPDATE joi_inbox_messages
        SET status = ?, updated_at = ? WHERE input_id = ? AND status NOT IN ('CONSUMED', 'CLARIFICATION_REQUIRED')`).run(nextStatus, now, inputId);
    });
  }
}

function finishAutomationRun(
  connection: DatabaseSync,
  inputId: string,
  result: "CANCELED" | "FAILED",
  completedAt: string,
  reasonCode?: string,
): void {
  connection.prepare(`UPDATE joi_automation_runs
    SET status = ?, result = ?, completed_at = ?, reason_code = ?
    WHERE input_id = ? AND status IN ('PENDING', 'RUNNING', 'BLOCKED')`).run(
    result, result, completedAt, reasonCode ?? null, inputId,
  );
  connection.prepare("UPDATE joi_inbox_messages SET automation_routine_id = NULL WHERE input_id = ?").run(inputId);
}
