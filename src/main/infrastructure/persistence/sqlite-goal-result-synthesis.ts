import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../../domain/errors.js";
import type { JoiPendingInput } from "../../application/ports/joi-coordinator.js";
import { loadGoalRequirements } from "./sqlite-goal-requirements.js";

/** Only the instruction and version identity belong in the persisted user message. */
export function goalSynthesisInstruction(goalInputId: string, resultRevision: number, requirementsRevision: number): string {
  return [
    "All currently planned work for one original user goal is terminal and ready for synthesis.",
    `goalInputId=${goalInputId} resultRevision=${String(resultRevision)} requirementsRevision=${String(requirementsRevision)}`,
    "Use the current required context and the refreshed private synthesis snapshot. Read work_read_evidence for the goal-scoped paginated index and work_read_result for complete evidence pages. Unlisted evidence still exists.",
    "Only COMPLETED results with verification=PASSED are verified evidence. A COMPLETED result with verification=NOT_REQUIRED is an unverified self-report. Missing acceptance is UNVERIFIED. FAILED/UNKNOWN, late, non-authoritative results or verification=FAILED are coverage gaps, not successful evidence.",
    "If the evidence answers the goal, deliver the complete answer and call turn_complete with RESULT_SYNTHESIZED. Do not repeat completed Work or dump raw per-Agent output.",
    "Your final visible message must be the complete deliverable itself, with material evidence gaps. Do the reasoning through tool calls and then write the deliverable in full.",
    "If a concrete next evidence layer can run without a user decision, credentials or broader permission, describe the bounded gap and call turn_complete with RESULT_CONTINUE; Wayfinder will arrange that layer.",
    "Only retryable=true with sideEffectState=NONE permits a fresh work_reassign attempt. Prefer another suitable available partner; switch the current partner's model only when none is available.",
    "For an essential auth, balance, configuration, skill or safety failure, required user judgment or sideEffectState OBSERVED/UNKNOWN, do not replay automatically; explain the gap and call turn_complete with RESULT_BLOCKED.",
  ].join("\n");
}

export function loadGoalSynthesisContext(connection: DatabaseSync, goalInputId: string, workbenchId: string, resultRevision: number, requirementsRevision: number): JoiPendingInput["synthesisContext"] {
  const goal = connection.prepare(`SELECT body FROM joi_inbox_messages i WHERE input_id=?
    AND (workbench_id=? OR (workbench_id IS NULL AND EXISTS (
      SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.workbench_id=?
    )))`).get(goalInputId, workbenchId, workbenchId);
  if (typeof goal?.body !== "string") return undefined;
  const previous = connection.prepare(`SELECT result_revision, disposition, completion_summary, updated_at
    FROM joi_goal_outcomes WHERE input_id=? AND result_revision<=?`).get(goalInputId, resultRevision);
  const counts = connection.prepare(`SELECT COUNT(DISTINCT r.result_id) AS total,
    COUNT(DISTINCT CASE WHEN r.status<>'COMPLETED' OR r.is_late=1 OR r.is_authoritative=0 OR v.status IS NULL OR v.status NOT IN ('PASSED','NOT_REQUIRED') THEN r.result_id END) AS gaps
    FROM joi_goal_result_members m JOIN partner_result_events e ON e.event_id=m.event_id
    JOIN work_results r ON r.run_id=e.run_id AND r.status=e.status
    JOIN work_items w ON w.work_id=r.work_id
    LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
    WHERE m.original_input_id=? AND m.revision<=? AND w.workbench_id=?`).get(goalInputId, resultRevision, workbenchId);
  // First synthesis discovers the relevant evidence through the paged index.
  const changes = previous === undefined ? [] : connection.prepare(`SELECT DISTINCT r.result_id, r.work_id, r.status, r.summary,
    r.is_late, r.is_authoritative, COALESCE(v.status,'UNVERIFIED') AS verification
    FROM joi_goal_result_members m JOIN partner_result_events e ON e.event_id=m.event_id
    JOIN work_results r ON r.run_id=e.run_id AND r.status=e.status
    JOIN work_items w ON w.work_id=r.work_id
    LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
    WHERE m.original_input_id=? AND m.revision<=? AND w.workbench_id=?
      AND (m.revision>? OR v.created_at>? OR EXISTS (
        SELECT 1 FROM joi_goal_result_members newer JOIN partner_result_events ne ON ne.event_id=newer.event_id
        WHERE newer.original_input_id=m.original_input_id AND ne.work_id=r.work_id
          AND newer.revision>? AND newer.revision<=?
      )) ORDER BY m.revision, r.result_id`)
    .all(goalInputId, resultRevision, workbenchId, Number(previous.result_revision), String(previous.updated_at), Number(previous.result_revision), resultRevision);
  return {
    originalRequest: goal.body, resultRevision, requirementsRevision,
    ...(previous === undefined ? {} : { previous: { resultRevision: Number(previous.result_revision), disposition: String(previous.disposition), summary: String(previous.completion_summary) } }),
    totalResults: Number(counts?.total ?? 0), gapCount: Number(counts?.gaps ?? 0), omittedChanges: Math.max(0, changes.length - 100),
    changedResults: changes.slice(0, 100).map(row => ({ resultId: String(row.result_id), workId: String(row.work_id), status: String(row.status),
      verification: String(row.verification), summary: String(row.summary), isLate: row.is_late === 1, isAuthoritative: row.is_authoritative === 1 })),
  };
}

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
  const inputId = contract === null ? `joi_result_input:goal:${goalInputId}` : `joi_result_input:goal:${goalInputId}:r${String(resultSet.revision)}:q${String(contract.revision)}`;
  const body = goalSynthesisInstruction(goalInputId, resultSet.revision, contract?.revision ?? 0);
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
