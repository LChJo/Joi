import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../../domain/errors.js";
import { truncateAtSentenceBoundary } from "../../domain/text/sentence-truncation.js";
import { loadGoalRequirements } from "./sqlite-goal-requirements.js";

type Row = Record<string, unknown>;

/** An obsolete synthesis cannot publish or re-enter the scheduler after a newer input owns the goal. */
export function consumeSupersededGoalSynthesis(connection: DatabaseSync, inputId: string, now: string): { goalInputId: string; resultRevision: number } | null {
  if (!inputId.startsWith("joi_result_input:")) return null;
  const row = connection.prepare(`SELECT i.goal_input_id, i.result_revision
    FROM joi_inbox_messages i JOIN joi_goal_result_sets rs ON rs.original_input_id = i.goal_input_id
    WHERE i.input_id = ? AND i.input_id LIKE 'joi_result_input:%'
      AND rs.synthetic_input_id IS NOT NULL AND rs.synthetic_input_id <> i.input_id`).get(inputId);
  if (typeof row?.goal_input_id !== "string" || typeof row.result_revision !== "number") return null;
  connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = ?
    WHERE input_id = ? AND status <> 'CLARIFICATION_REQUIRED'`).run(now, inputId);
  return { goalInputId: row.goal_input_id, resultRevision: row.result_revision };
}

/** Enqueues current evidence once per result and effective-requirements revision pair. */
export function enqueueGoalResultSynthesis(connection: DatabaseSync, goalInputId: string, workbenchId: string, now: string): string | null {
  const source = connection.prepare("SELECT body AS goal_body FROM joi_inbox_messages WHERE input_id = ? AND canceled_at IS NULL AND dismissed_at IS NULL AND failed_at IS NULL").get(goalInputId);
  if (typeof source?.goal_body !== "string") return null;
  const gate = connection.prepare("SELECT status FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(goalInputId);
  if (gate !== undefined && gate.status !== "OPEN") return null;
  const resultSet = connection.prepare(`SELECT revision, synthesized_revision, synthesized_requirements_revision FROM joi_goal_result_sets
    WHERE original_input_id = ?`).get(goalInputId) as { revision?: unknown; synthesized_revision?: unknown; synthesized_requirements_revision?: unknown } | undefined;
  if (resultSet === undefined) return null;
  if (typeof resultSet.revision !== "number" || typeof resultSet.synthesized_revision !== "number") throw new DomainError("goal_result_set_invalid", "The goal's result set is unreadable.");
  const contract = loadGoalRequirements(connection, goalInputId);
  if (contract?.status === "DIRTY") return null;
  if (resultSet.synthesized_revision >= resultSet.revision &&
    (contract === null || resultSet.synthesized_requirements_revision === contract.revision)) return null;
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
  const inputId = contract === null ? `joi_result_input:goal:${goalInputId}` : `joi_result_input:goal:${goalInputId}:r${String(resultSet.revision)}:q${String(contract.revision)}`;
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
      return `resultId=${String(row.result_id)} workId=${String(row.work_id)} title=${String(row.title).slice(0, 240)} status=${String(row.status)} verification=${verification} summary=${truncateAtSentenceBoundary(String(row.summary), 320)}`;
    }),
    "Only COMPLETED results with verification=PASSED are verified evidence. A COMPLETED result with verification=NOT_REQUIRED is an unverified self-report: it may support the answer, but say so when the distinction matters. A FAILED/UNKNOWN result or verification=FAILED is a coverage gap; it does not invalidate other evidence and must not dominate the final answer unless that missing coverage is essential to the original goal.",
    "If verified completed results already answer the original goal, synthesize that answer, mention non-critical failures only as a brief trailing warning, and call turn_complete with RESULT_SYNTHESIZED.",
    "Your final visible message must be the complete deliverable itself: write the full article/answer body out in full. Do not summarize it and do not narrate your process (no \"Let me read…\", \"Then turn_complete…\" or similar) — do the reasoning through tool calls, then write the deliverable once, complete.",
    "If the evidence is insufficient but a concrete next evidence layer can run without a user decision, credential or broader permission, summarize the bounded gap and call turn_complete with RESULT_CONTINUE. The Wayfinder review will arrange that next layer.",
    "If an essential gap remains, inspect structured failure facts: only retryable=true with sideEffectState=NONE permits a fresh work_reassign attempt. Prefer a different suitable available partner; only switch the current partner's model when no suitable alternative exists.",
    "For an essential auth, balance, configuration, skill or safety failure, a required user judgment, or sideEffectState OBSERVED/UNKNOWN, do not replay automatically; explain the missing coverage and call turn_complete with RESULT_BLOCKED.",
    "Use work_read_result only if the bounded summary is insufficient.",
    "Do not dump raw per-Agent output.",
  ].join("\n");
  connection.prepare(`INSERT INTO joi_inbox_messages
    (input_id, idempotency_key, body, status, workbench_id, goal_input_id, result_revision, requirements_revision, created_at, updated_at)
    VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(input_id) DO UPDATE SET body = excluded.body, status = 'PENDING',
      result_revision = excluded.result_revision, updated_at = excluded.updated_at
    WHERE excluded.result_revision > COALESCE(joi_inbox_messages.result_revision, 0)`).run(
    inputId, contract === null ? `partner_result_goal:${goalInputId}` : `partner_result_goal:${goalInputId}:r${String(resultSet.revision)}:q${String(contract.revision)}`, body, workbenchId, goalInputId, resultSet.revision, contract?.revision ?? null,
    now, now,
  );
  connection.prepare(`UPDATE joi_goal_result_sets SET synthetic_input_id = ? WHERE original_input_id = ?`)
    .run(inputId, goalInputId);
  // Only the input owning the current result/requirements pair remains schedulable.
  connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = ?
    WHERE goal_input_id = ? AND input_id LIKE 'joi_result_input:%' AND input_id <> ? AND status IN ('PENDING', 'ROUTED')`)
    .run(now, goalInputId, inputId);
  return inputId;
}
