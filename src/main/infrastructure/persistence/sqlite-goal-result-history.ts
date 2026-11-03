import type { DatabaseSync } from "node:sqlite";
import type { GoalResultDto, GoalResultPage, GoalResultPageDto, GoalResultSummaryDto } from "../../../shared/goal-results.js";
import { DomainError } from "../../domain/errors.js";
import { sanitizeAgentConversationText, stripPathRedactions } from "../../application/partners/agent-conversation-presentation.js";

type Row = Record<string, string | number | null>;

function visibleGoal(db: DatabaseSync, goalId: string): boolean {
  return db.prepare("SELECT 1 FROM joi_inbox_messages WHERE input_id=? AND goal_input_id IS NULL AND dismissed_at IS NULL").get(goalId) !== undefined;
}

function summary(row: Row): GoalResultSummaryDto {
  return { resultId: String(row.result_id), completedAt: String(row.completed_at), status: row.status as GoalResultSummaryDto["status"] };
}

export function queryGoalResults(db: DatabaseSync, goalId: string, page: GoalResultPage): GoalResultPageDto | null {
  const limit = page.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (page.cursor !== undefined && !/^[a-f0-9]{32}$/u.test(page.cursor))) {
    throw new DomainError("goal_result_page_invalid", "Result history paging is invalid.");
  }
  if (!visibleGoal(db, goalId)) return null;
  const anchor = page.cursor === undefined ? undefined : db.prepare("SELECT completed_at,result_id FROM joi_goal_result_history WHERE goal_input_id=? AND result_id=?").get(goalId, page.cursor);
  if (page.cursor !== undefined && anchor === undefined) throw new DomainError("goal_result_page_invalid", "Result history paging is invalid.");
  const rows = db.prepare(`SELECT result_id,completed_at,status FROM joi_goal_result_history
    WHERE goal_input_id=? AND (? IS NULL OR completed_at<? OR (completed_at=? AND result_id<?))
    ORDER BY completed_at DESC,result_id DESC LIMIT ?`).all(goalId, anchor?.completed_at ?? null, anchor?.completed_at ?? null,
      anchor?.completed_at ?? null, anchor?.result_id ?? null, limit + 1) as Row[];
  const items = rows.slice(0, limit).map(summary);
  const last = items.at(-1);
  return { items, ...(rows.length > limit && last !== undefined ? { nextCursor: last.resultId } : {}) };
}

export function queryGoalResult(db: DatabaseSync, goalId: string, resultId: string): GoalResultDto | null {
  if (!visibleGoal(db, goalId)) return null;
  const row = db.prepare("SELECT result_id,completed_at,status,body FROM joi_goal_result_history WHERE goal_input_id=? AND result_id=?").get(goalId, resultId) as Row | undefined;
  return row === undefined ? null : { ...summary(row), goalId, body: stripPathRedactions(sanitizeAgentConversationText(String(row.body))) };
}
