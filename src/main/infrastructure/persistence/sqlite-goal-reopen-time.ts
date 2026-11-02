import type { DatabaseSync } from "node:sqlite";

/** A continuation epoch must sort after every completion it supersedes, even within one clock tick. */
export function nextGoalReopenTime(connection: DatabaseSync, goalId: string, now: string): string {
  const row = connection.prepare(`SELECT MAX(at) AS at FROM (
    SELECT reopened_at AS at FROM joi_inbox_messages WHERE input_id=?
    UNION ALL SELECT completed_at FROM joi_goal_outcomes WHERE input_id=?
    UNION ALL SELECT completed_at FROM joi_turn_completions WHERE input_id=?
  )`).get(goalId, goalId, goalId);
  const previous = Date.parse(String(row?.at ?? ""));
  return Number.isFinite(previous) ? new Date(Math.max(Date.parse(now), previous + 1)).toISOString() : now;
}
