import type { DatabaseSync } from "node:sqlite";
import type { GoalRequirements } from "../../domain/work/goal-requirements.js";

export function hasStaleQueuedWork(db: DatabaseSync, goalInputId: string, revision: number): boolean {
  return db.prepare(`SELECT 1 FROM work_items w WHERE w.input_id = ? AND w.status IN ('PLANNED', 'READY')
    AND CASE WHEN json_valid(w.intent_json) THEN COALESCE(json_extract(w.intent_json, '$.requirementsRevision'), -1) ELSE -1 END <> ?
    AND NOT EXISTS (SELECT 1 FROM partner_runs r WHERE r.work_id = w.work_id AND r.status = 'RUNNING') LIMIT 1`).get(goalInputId, revision) !== undefined;
}

/** Stable maintenance inputs recover queued briefs without replaying existing dispatch actions. */
export function enqueueGoalRequirementsReview(db: DatabaseSync, contract: GoalRequirements, now: string): void {
  if (contract.status !== "READY" || !hasStaleQueuedWork(db, contract.goalInputId, contract.revision)) return;
  const inputId = `joi_harness_review:goal:${contract.goalInputId}:r0:q${String(contract.revision)}:brief`;
  db.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
    (input_id, idempotency_key, body, status, workbench_id, goal_input_id, requirements_revision, created_at, updated_at)
    VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`)
    .run(inputId, inputId,
      "Maintain queued Work against the current effective requirements. This is internal instruction maintenance: use work_list_goal, work_read_brief, and work_update_brief to refresh applicable PLANNED/READY instructions. Cancel incompatible unstarted Work using existing permissions. Running snapshots are immutable; do not replay completed work. If queued briefs already match the current revision, finish without dispatching anything. Do not clear the goal map merely because instruction maintenance is complete.",
      contract.workbenchId, contract.goalInputId, contract.revision, now, now);
}

export function consumeSatisfiedRequirementsReviews(db: DatabaseSync, contract: GoalRequirements, now: string): void {
  if (hasStaleQueuedWork(db, contract.goalInputId, contract.revision)) return;
  db.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = ?
    WHERE goal_input_id = ? AND status = 'PENDING'
      AND input_id LIKE 'joi_harness_review:%:brief'`)
    .run(now, contract.goalInputId);
}
