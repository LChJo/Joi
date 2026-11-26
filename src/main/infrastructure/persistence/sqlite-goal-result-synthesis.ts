import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../../domain/errors.js";
import type { JoiPendingInput } from "../../application/ports/joi-coordinator.js";
import { loadGoalRequirements } from "./sqlite-goal-requirements.js";
import { countGoalEvidenceChanges } from "./sqlite-goal-evidence-repository.js";

/** The expression is a repository-owned SQL identifier. */
export function coverageSynthesisSql(inputId: string): string {
  return `(${inputId} LIKE 'joi_result_input:goal:%' AND substr(${inputId},-9)=':coverage')`;
}

/** Only the instruction and version identity belong in the persisted user message. */
export function goalSynthesisInstruction(goalInputId: string, resultRevision: number, requirementsRevision: number): string {
  return [
    "All currently planned work for one original user goal is terminal and ready for synthesis.",
    `goalInputId=${goalInputId} resultRevision=${String(resultRevision)} requirementsRevision=${String(requirementsRevision)}`,
    "Use the current requirements and start with work_read_evidence(mode=roadmap). Read work_read_evidence for the goal-scoped paginated index and work_read_result for complete evidence pages. Unlisted evidence still exists.",
    "Only COMPLETED results with verification=PASSED are verified evidence. A COMPLETED result with verification=NOT_REQUIRED is an unverified self-report. Missing acceptance is UNVERIFIED. FAILED/UNKNOWN, late, non-authoritative results or verification=FAILED are coverage gaps, not successful evidence.",
    "If the evidence answers the goal, deliver the complete answer and call turn_complete with RESULT_SYNTHESIZED. Do not repeat completed Work or dump raw per-Agent output.",
    "For each mandatory requirement, cite at least one accepted result whose recorded Work scope supports it, and read a relevant page from that result or reuse its valid read receipt. An older result can support a requirement that has remained unchanged since its execution. A PASSED body-presence check alone cannot establish that a feature works; report any missing functional evidence.",
    "Distinguish the user's acceptance criteria from a method chosen to obtain evidence. If accepted evidence already establishes the required fact, an additional independent/offline review, alternative implementation or optional quality check is advisory unless the user explicitly requires that method. Mark advisory observations with advisory=true in unresolved; never classify missing mandatory evidence or actual conflicts as advisory. Deliver RESULT_SYNTHESIZED when only advisory observations remain.",
    "Your final visible message must be the complete deliverable itself, with material evidence gaps. Do the reasoning through tool calls and then write the deliverable in full.",
    "With turn_complete, provide private synthesisState with version=1, claims, unresolved and conflicts. Link conflicts to affected requirementIds (use [] for issues outside acceptance). Retain resolved conflicts with resolution={rationale,resultIds} referencing current read evidence in the supporting claims. Use only actual requirement and result identifiers.",
    "If a concrete next evidence layer can run without a user decision, credentials or broader permission, describe the bounded gap and call turn_complete with RESULT_CONTINUE; Wayfinder will arrange that layer.",
    "For a recurring check, assess the current execution's scope. Carry historical gaps as context unless they still block a current requirement. Keep stable requirement links for unchanged gaps; do not repeat a verification method when the previous attempt produced no new relevant evidence. Choose a genuinely different bounded step or stop with the confirmed result and material gaps.",
    "If the completion tool reports coverage issues, repair the specific links using existing results first. If a mandatory gap remains, report confirmed findings and choose RESULT_CONTINUE for a concrete safe next step, or RESULT_BLOCKED if none is available.",
    "Only retryable=true with sideEffectState=NONE permits a fresh work_reassign attempt. Prefer another suitable available partner; switch the current partner's model only when none is available.",
    "For an essential auth, balance, configuration, skill or safety failure, required user judgment or sideEffectState OBSERVED/UNKNOWN, do not replay automatically; explain the gap and call turn_complete with RESULT_BLOCKED.",
  ].join("\n");
}

export function loadGoalSynthesisContext(connection: DatabaseSync, goalInputId: string, workbenchId: string, resultRevision: number, requirementsRevision: number): JoiPendingInput["synthesisContext"] {
  const goal = connection.prepare(`SELECT CASE WHEN length(body)<=8000 THEN body ELSE NULL END AS body FROM joi_inbox_messages i WHERE input_id=?
    AND (workbench_id=? OR (workbench_id IS NULL AND EXISTS (
      SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.workbench_id=?
    )))`).get(goalInputId, workbenchId, workbenchId);
  if (goal === undefined) return undefined;
  const previous = connection.prepare(`SELECT result_revision, requirements_revision, disposition, updated_at
    FROM joi_goal_outcomes WHERE input_id=? AND result_revision<=?`).get(goalInputId, resultRevision);
  const counts = connection.prepare(`SELECT COUNT(DISTINCT r.result_id) AS total,
    COUNT(DISTINCT CASE WHEN r.status<>'COMPLETED' OR r.is_late=1 OR r.is_authoritative=0 OR v.status IS NULL OR v.status<>'PASSED' THEN r.result_id END) AS gaps
    FROM joi_goal_result_members m JOIN partner_result_events e ON e.event_id=m.event_id
    JOIN work_results r ON r.run_id=e.run_id AND r.status=e.status
    JOIN work_items w ON w.work_id=r.work_id
    LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
    WHERE m.original_input_id=? AND m.revision<=? AND w.workbench_id=?`).get(goalInputId, resultRevision, workbenchId);
  const changesRead = { resultRevision, requirementsRevision, afterResultRevision: Number(previous?.result_revision ?? 0),
    ...(previous === undefined ? {} : { afterUpdatedAt: String(previous.updated_at) }) };
  return {
    originalRequest: typeof goal.body === "string" ? goal.body : "Read the original user requirements through goal_read_inputs.",
    resultRevision,requirementsRevision,
    ...(previous === undefined ? {} : { previous: {
      disposition: String(previous.disposition),
      stateRef: `r${String(previous.result_revision)}:q${String(previous.requirements_revision ?? 0)}:current`,
    } }),
    changesRead,totalChanges: countGoalEvidenceChanges(connection,{ goalInputId,workbenchId,...changesRead }),
    totalResults: Number(counts?.total ?? 0),gapCount: Number(counts?.gaps ?? 0),
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

/** Enqueues current evidence once per revision pair and explicit retry epoch. */
export function enqueueGoalResultSynthesis(connection: DatabaseSync, goalInputId: string, workbenchId: string, now: string, recoveryEpoch?: string, coverageRefresh = false): string | null {
  const source = connection.prepare("SELECT reopened_at,status FROM joi_inbox_messages WHERE input_id = ? AND canceled_at IS NULL AND dismissed_at IS NULL AND failed_at IS NULL").get(goalInputId);
  if (source === undefined) return null;
  const gate = connection.prepare("SELECT status FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(goalInputId);
  if (gate !== undefined && gate.status !== "OPEN") return null;
  const resultSet = connection.prepare(`SELECT revision, synthesized_revision, synthesized_requirements_revision FROM joi_goal_result_sets
    WHERE original_input_id = ?`).get(goalInputId) as { revision?: unknown; synthesized_revision?: unknown; synthesized_requirements_revision?: unknown } | undefined;
  if (resultSet === undefined) return null;
  if (typeof resultSet.revision !== "number" || typeof resultSet.synthesized_revision !== "number") throw new DomainError("goal_result_set_invalid", "The goal's result set is unreadable.");
  const contract = loadGoalRequirements(connection, goalInputId);
  if (contract?.status === "DIRTY") return null;
  const current = connection.prepare("SELECT result_revision,requirements_revision,disposition,completed_at FROM joi_goal_outcomes WHERE input_id=?").get(goalInputId);
  if (coverageRefresh && (contract === null || (source.status !== "CONSUMED" && source.status !== "ROUTED") || current?.disposition !== "COMPLETED"
    || current.result_revision !== resultSet.revision || Number(current.requirements_revision ?? 0) !== contract.revision)) return null;
  const resumeEpoch = source.status === "CONSUMED" && typeof source.reopened_at === "string" && current?.result_revision === resultSet.revision
    && Number(current.requirements_revision ?? 0) === (contract?.revision ?? 0)
    && (current.disposition === "BLOCKED" || current.disposition === "CONTINUE" || recoveryEpoch === source.reopened_at)
    && typeof current.completed_at === "string" && source.reopened_at > current.completed_at ? source.reopened_at : undefined;
  if (resultSet.synthesized_revision >= resultSet.revision &&
    (contract === null || resultSet.synthesized_requirements_revision === contract.revision) && resumeEpoch === undefined && !coverageRefresh) return null;
  const active = connection.prepare(`SELECT 1 FROM work_items
    WHERE input_id = ? AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1`).get(goalInputId);
  if (active !== undefined) return null;
  if (coverageRefresh && source.status === "ROUTED") {
    const settled = connection.prepare(`UPDATE joi_inbox_messages AS goal SET status='CONSUMED',updated_at=?
      WHERE goal.input_id=? AND goal.status='ROUTED' AND goal.clarification_reason_code IS NULL
        AND EXISTS (SELECT 1 FROM joi_goal_outcomes o WHERE o.input_id=goal.input_id
          AND o.completed_at>=COALESCE(goal.reopened_at,goal.created_at))
        AND NOT EXISTS (SELECT 1 FROM joi_turns t JOIN joi_inbox_messages i ON i.input_id=t.input_id
          WHERE COALESCE(i.goal_input_id,i.input_id)=goal.input_id AND t.status IN ('PENDING','RUNNING','WAITING'))
        AND NOT EXISTS (SELECT 1 FROM joi_inbox_messages i WHERE i.goal_input_id=goal.input_id
          AND i.status IN ('PENDING','ROUTED','CLARIFICATION_REQUIRED'))
        AND NOT EXISTS (SELECT 1 FROM joi_user_action_requests a WHERE a.input_id=goal.input_id AND a.status='OPEN')`)
      .run(now,goalInputId);
    if (settled.changes !== 1) return null;
  }
  const resumeSuffix = coverageRefresh ? ":coverage" : resumeEpoch === undefined ? "" : `:resume:${String(Date.parse(resumeEpoch))}`;
  const inputId = (contract === null ? `joi_result_input:goal:${goalInputId}` : `joi_result_input:goal:${goalInputId}:r${String(resultSet.revision)}:q${String(contract.revision)}`) + resumeSuffix;
  if (coverageRefresh && connection.prepare("SELECT 1 FROM joi_inbox_messages WHERE input_id=?").get(inputId) !== undefined) {
    connection.prepare(`UPDATE joi_inbox_messages SET failed_at=?, failure_reason_code='goal_synthesis_coverage_incomplete',
        failure_count=MAX(COALESCE(failure_count,0),1),updated_at=?
      WHERE input_id=? AND status='CONSUMED' AND failed_at IS NULL
        AND EXISTS (SELECT 1 FROM joi_goal_result_sets rs WHERE rs.synthetic_input_id=joi_inbox_messages.input_id)`)
      .run(now,now,inputId);
    return null;
  }
  const body = goalSynthesisInstruction(goalInputId, resultSet.revision, contract?.revision ?? 0);
  connection.prepare(`INSERT INTO joi_inbox_messages
    (input_id, idempotency_key, body, status, workbench_id, goal_input_id, result_revision, requirements_revision, created_at, updated_at)
    VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(input_id) DO UPDATE SET body = excluded.body, status = 'PENDING',
      result_revision = excluded.result_revision, updated_at = excluded.updated_at
    WHERE excluded.result_revision > COALESCE(joi_inbox_messages.result_revision, 0)`).run(
    inputId, (contract === null ? `partner_result_goal:${goalInputId}` : `partner_result_goal:${goalInputId}:r${String(resultSet.revision)}:q${String(contract.revision)}`) + resumeSuffix, body, workbenchId, goalInputId, resultSet.revision, contract?.revision ?? null,
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
