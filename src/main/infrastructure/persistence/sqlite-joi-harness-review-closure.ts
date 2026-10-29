import { goalRequirementsCurrentSql } from "./sqlite-goal-requirements.js";
import type { DatabaseSync } from "node:sqlite";
import { harnessReviewInputIdSql } from "./sqlite-joi-harness-review-identity.js";

import type { JoiInboxRecord, JoiInboxStatus } from "../../application/ports/joi-inbox.js";

type Row = Record<string, unknown>;

function mapClosedInboxRow(row: Row): JoiInboxRecord {
  const inputId = row.input_id;
  const idempotencyKey = row.idempotency_key;
  const body = row.body;
  const status = row.status;
  const createdAt = row.created_at;
  const updatedAt = row.updated_at;
  const workbenchId = row.workbench_id;
  if (typeof inputId !== "string" || typeof idempotencyKey !== "string" || typeof body !== "string"
    || typeof status !== "string" || typeof createdAt !== "string" || typeof updatedAt !== "string"
    || (workbenchId !== null && workbenchId !== undefined && typeof workbenchId !== "string")) {
    throw new Error("joi_inbox_record_invalid");
  }
  return {
    ...(typeof workbenchId === "string" ? { workbenchId } : {}),
    body,
    createdAt,
    idempotencyKey,
    inputId,
    status: status as JoiInboxStatus,
    updatedAt,
  };
}

/**
 * Idempotently closes a historical review after the result and execution facts
 * prove completion. This is a compatibility endpoint; normal convergence is
 * performed by the harness actor without asking the user to assert completion.
 * The caller owns the surrounding SQLite transaction.
 */
export function closeHistoricalReviewInTransaction(connection: DatabaseSync, inputId: string): JoiInboxRecord | null {
  const now = new Date().toISOString();
  const gate = connection.prepare(`
    SELECT m.goal_input_id, rs.revision
      FROM joi_harness_maps m
      JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
      JOIN joi_current_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
      JOIN joi_inbox_messages g ON g.input_id = m.goal_input_id
      LEFT JOIN joi_inbox_messages r
        ON r.input_id = ${harnessReviewInputIdSql("m.goal_input_id", "rs.revision")}
     WHERE m.goal_input_id = ? AND m.status IN ('ACTIVE', 'CLEARED')
       AND g.status = 'CLARIFICATION_REQUIRED'
       AND g.clarification_reason_code = 'harness_review_unrecoverable'
       AND g.canceled_at IS NULL AND g.dismissed_at IS NULL AND g.failed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM joi_goal_execution_gates gate
         WHERE gate.goal_input_id = m.goal_input_id AND gate.status <> 'OPEN')
       AND rs.revision > 0 AND rs.synthesized_revision = rs.revision
       AND o.disposition = 'COMPLETED'
       AND m.reviewed_revision = rs.revision
           AND ${goalRequirementsCurrentSql('m.goal_input_id', 'm.reviewed_requirements_revision')}
       AND NOT EXISTS (SELECT 1 FROM work_items w
                        WHERE w.input_id = m.goal_input_id
                          AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
       AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p
                        WHERE p.goal_input_id = m.goal_input_id AND p.status = 'OPEN')
       AND NOT EXISTS (SELECT 1 FROM work_items w
                        WHERE w.input_id = m.goal_input_id
                          AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id))
       AND (r.input_id IS NULL OR r.status IN ('PENDING', 'FAILED', 'CONSUMED', 'ROUTED', 'CLARIFICATION_REQUIRED'))
       AND NOT EXISTS (SELECT 1 FROM joi_turns t
                        WHERE t.input_id = r.input_id AND t.status IN ('PENDING', 'RUNNING', 'WAITING'))`).get(inputId) as Row | undefined;
  if (gate === undefined) return null;
  connection.prepare(`UPDATE joi_harness_maps
    SET status = 'CLEARED', cleared_at = ?, revision = revision + 1, updated_at = ?
    WHERE goal_input_id = ? AND status = 'ACTIVE'`).run(now, now, inputId);
  const restored = connection.prepare(`UPDATE joi_inbox_messages
    SET status = 'CONSUMED', clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
    WHERE input_id = ? AND status = 'CLARIFICATION_REQUIRED'
      AND clarification_reason_code = 'harness_review_unrecoverable'`).run(now, inputId);
  if (restored.changes !== 1) return null;
  const row = connection.prepare("SELECT * FROM joi_inbox_messages WHERE input_id = ?").get(inputId) as Row | undefined;
  return row === undefined ? null : mapClosedInboxRow(row);
}
