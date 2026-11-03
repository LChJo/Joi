import type { DatabaseSync } from "node:sqlite";
import type { JoiInboxRecord, JoiInboxRepository } from "../../application/ports/joi-inbox.js";

export interface HistoricalReviewGate {
  question_id?: unknown;
  question_version?: unknown;
  reason_code?: unknown;
  status?: unknown;
}

function nextRecoveryQuestion(connection: DatabaseSync, goalInputId: string, previousVersion = 0) {
  const prefix = `joi_goal_resume:goal:${goalInputId}:v`;
  const prior = connection.prepare(`SELECT MAX(CAST(substr(input_id, length(?) + 1) AS INTEGER)) AS version
    FROM joi_inbox_messages WHERE goal_input_id = ? AND substr(input_id, 1, length(?)) = ?`)
    .get(prefix, goalInputId, prefix, prefix);
  const questionVersion = Math.max(previousVersion, typeof prior?.version === "number" ? prior.version : 0) + 1;
  return { questionId: `goal_question:${goalInputId}:v${String(questionVersion)}`, questionVersion };
}

/** A quarantined review waits for a versioned user decision without replaying its prior Turn. */
export function quarantineHistoricalReview(connection: DatabaseSync, goalInputId: string, now: string): boolean {
  const raised = connection.prepare(`UPDATE joi_inbox_messages
    SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = 'harness_review_unrecoverable',
        clarification_prompt = '历史评审已暂停。可重新核对并继续，或补充要求后继续。已有成果会保留。', updated_at = ?
    WHERE input_id = ? AND status = 'CONSUMED' AND dismissed_at IS NULL AND canceled_at IS NULL AND failed_at IS NULL`)
    .run(now, goalInputId);
  if (raised.changes !== 1) return false;
  const gate = connection.prepare("SELECT question_version FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(goalInputId);
  const question = nextRecoveryQuestion(connection, goalInputId, typeof gate?.question_version === "number" ? gate.question_version : 0);
  connection.prepare(`INSERT INTO joi_goal_execution_gates
    (goal_input_id, question_id, question_version, status, reason_code, created_at, updated_at)
    VALUES (?, ?, ?, 'WAITING_INPUT', 'harness_review_unrecoverable', ?, ?)
    ON CONFLICT(goal_input_id) DO UPDATE SET question_id = excluded.question_id,
      question_version = excluded.question_version, status = 'WAITING_INPUT', reason_code = excluded.reason_code,
      resume_input_id = NULL, answered_at = NULL, updated_at = excluded.updated_at`)
    .run(goalInputId, question.questionId, question.questionVersion, now, now);
  return true;
}

/** Read-only preconditions keep legacy OPEN/missing gates compatible with the advertised recovery card. */
export function prepareHistoricalReviewRecovery(connection: DatabaseSync, current: JoiInboxRecord,
  patch: Parameters<JoiInboxRepository["clarify"]>[1], gate: HistoricalReviewGate | undefined, now: string,
): { questionId: string; questionVersion: number; reopenedAt: string } | null {
  if (patch.workbenchId !== undefined || current.workbenchId === undefined
    || (patch.actionChoice !== undefined && patch.actionChoice !== "RESUME")
    || (patch.actionChoice === undefined && patch.text === undefined)) return null;
  if (gate !== undefined) {
    if (gate.status !== "OPEN" && !(gate.status === "WAITING_INPUT" && gate.reason_code === "harness_review_unrecoverable")) return null;
    if (patch.expectedQuestionId !== gate.question_id || patch.expectedQuestionVersion !== gate.question_version) return null;
  } else if ((patch.expectedQuestionId !== undefined || patch.expectedQuestionVersion !== undefined)
    && (patch.expectedQuestionId !== `legacy_question:${current.inputId}` || patch.expectedQuestionVersion !== 1)) return null;
  const busy = connection.prepare(`SELECT 1 WHERE
    NOT EXISTS (SELECT 1 FROM workbenches WHERE workbench_id = ? AND status = 'ACTIVE')
    OR NOT EXISTS (SELECT 1 FROM joi_harness_maps WHERE goal_input_id = ? AND workbench_id = ?)
    OR EXISTS (SELECT 1 FROM work_items WHERE input_id = ? AND status NOT IN ('COMPLETED','FAILED','CANCELED'))
    OR EXISTS (SELECT 1 FROM joi_turns t JOIN joi_inbox_messages i ON i.input_id = t.input_id
      WHERE COALESCE(i.goal_input_id,i.input_id) = ? AND t.status IN ('PENDING','RUNNING','WAITING'))
    OR EXISTS (SELECT 1 FROM joi_inbox_messages WHERE goal_input_id = ?
      AND input_id NOT LIKE 'joi_harness_review:%' AND status IN ('PENDING','ROUTED','CLARIFICATION_REQUIRED'))
    OR EXISTS (SELECT 1 FROM joi_user_action_requests a JOIN joi_inbox_messages i ON i.input_id = a.input_id
      WHERE COALESCE(i.goal_input_id,i.input_id) = ? AND a.status = 'OPEN')`)
    .get(current.workbenchId, current.inputId, current.workbenchId, current.inputId, current.inputId, current.inputId, current.inputId);
  if (busy !== undefined) return null;
  const goal = connection.prepare(`SELECT g.reopened_at, o.completed_at FROM joi_inbox_messages g
    LEFT JOIN joi_goal_outcomes o ON o.input_id = g.input_id WHERE g.input_id = ?`).get(current.inputId);
  const reopenedAt = new Date(Math.max(Date.parse(now),
    typeof goal?.completed_at === "string" ? Date.parse(goal.completed_at) + 1 : 0,
    typeof goal?.reopened_at === "string" ? Date.parse(goal.reopened_at) + 1 : 0)).toISOString();
  const question = gate?.status === "WAITING_INPUT" && typeof gate.question_id === "string" && typeof gate.question_version === "number"
    ? { questionId: gate.question_id, questionVersion: gate.question_version }
    : nextRecoveryQuestion(connection, current.inputId, typeof gate?.question_version === "number" ? gate.question_version : 0);
  return { ...question, reopenedAt };
}
