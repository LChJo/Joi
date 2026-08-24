/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiGoalCardDto, JoiGoalHarnessDto, JoiGoalStatusDto, JoiHomeFeedDto, JoiThinkingItemDto } from "../../../shared/joi.js";
import type { JoiHomeFeedRepository } from "../../application/ports/joi-home-feed.js";
import { normalizeJoiFailureReasonCode, suggestedActionForJoiInputFailure } from "../../application/joi/joi-input-failure.js";
import { maskSecretText, stripPathRedactions } from "../../application/partners/agent-conversation-presentation.js";
import { queryHarnessGoalProjections } from "./sqlite-joi-harness-repository.js";

interface TransactionalDatabase { transaction<T>(operation: (database: DatabaseSync) => T): T }
type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("joi_home_feed_record_invalid");
  return value;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error("joi_home_feed_record_invalid");
  return value;
}

function toHarnessDto(projection: {
  currentLayer: number;
  decisionCount: number;
  destination: string | null;
  fogCount: number;
  mapStatus: JoiGoalHarnessDto["mapStatus"];
  openPathCount: number;
  revision: number;
  topFogNote: string | null;
  topPaths: JoiGoalHarnessDto["topPaths"];
}): JoiGoalHarnessDto {
  return {
    currentLayer: projection.currentLayer,
    decisionCount: projection.decisionCount,
    ...(projection.destination === null ? {} : { destination: projection.destination }),
    fogCount: projection.fogCount,
    mapStatus: projection.mapStatus,
    openPathCount: projection.openPathCount,
    revision: projection.revision,
    ...(projection.topFogNote === null ? {} : { topFogNote: projection.topFogNote }),
    topPaths: projection.topPaths,
  };
}

function goalStatus(row: Row): JoiGoalStatusDto {
  if (row.failed_at !== null && row.failed_at !== undefined) return "FAILED";
  if (row.canceled_at !== null && row.canceled_at !== undefined) return "CANCELED";
  if (row.clarification_reason_code !== null && row.clarification_reason_code !== undefined || number(row, "waiting_count") > 0) return "NEEDS_ATTENTION";
  // A retry is persisted before its new Turn exists. Keep the card in the arranging
  // state even when the goal still owns planned work from an earlier attempt.
  if (text(row, "inbox_status") === "PENDING") return "ARRANGING";
  if (number(row, "running_count") > 0) return "RUNNING";
  if (number(row, "arranged_count") > 0) return "ARRANGED";
  if (number(row, "work_total") > 0 && number(row, "work_active") === 0 && number(row, "outcome_current") === 0) return "FINALIZING";
  if (number(row, "failed_count") > 0) return "FAILED";
  // An up-to-date synthesized outcome means the goal lifecycle is done even when the
  // orchestration turn is still open (long wait turn) or leaked (orphan not yet recovered).
  if (text(row, "inbox_status") === "CONSUMED" || number(row, "outcome_current") === 1) return "COMPLETED";
  return "ARRANGING";
}

function thinkingStage(goal: JoiGoalCardDto | undefined, phase: JoiThinkingItemDto["phase"]): JoiThinkingItemDto["stage"] {
  if (phase === "queued") return "ROUTING";
  if (goal === undefined) return "PLANNING";
  if (goal.status === "ARRANGED") return "DISPATCHING";
  if (goal.status === "RUNNING") return "RUNNING";
  if (goal.status === "NEEDS_ATTENTION") return "WAITING";
  if (goal.status === "FINALIZING") return "FINALIZING";
  return "PLANNING";
}

function thinkingPhasePriority(phase: JoiThinkingItemDto["phase"]): number {
  if (phase === "progressing") return 2;
  if (phase === "queued") return 1;
  return 0;
}

/** One goal owns one visible progress row, even when recovery leaves multiple Turns active. */
function collapseThinkingByGoal(items: JoiThinkingItemDto[]): JoiThinkingItemDto[] {
  const byGoal = new Map<string, JoiThinkingItemDto>();
  for (const item of items) {
    const current = byGoal.get(item.goalId);
    if (current === undefined) {
      byGoal.set(item.goalId, item);
      continue;
    }
    const priority = thinkingPhasePriority(item.phase);
    const currentPriority = thinkingPhasePriority(current.phase);
    if (priority > currentPriority || (priority === currentPriority && priority > 0 && item.startedAt < current.startedAt)) {
      byGoal.set(item.goalId, item);
    }
  }
  return [...byGoal.values()];
}

export class SqliteJoiHomeFeedRepository implements JoiHomeFeedRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async load(now: Date): Promise<JoiHomeFeedDto> {
    return this.database.transaction((connection) => {
      const rows = connection.prepare(`SELECT i.input_id, i.body, i.status AS inbox_status, i.clarification_reason_code, i.clarification_prompt,
        i.canceled_at, i.failed_at, i.failure_reason_code, i.failure_count,
        COALESCE(o.completed_at, tc.completed_at, i.updated_at) AS projection_updated_at, a.workbench_id, a.name AS workbench_name,
        COUNT(w.work_id) AS work_total,
        COALESCE(SUM(CASE WHEN w.status IN ('PLANNED','READY','RUNNING','WAITING') THEN 1 ELSE 0 END), 0) AS work_active,
        COALESCE(SUM(CASE WHEN w.status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed_count,
        COALESCE(SUM(CASE WHEN w.status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN w.status = 'RUNNING' THEN 1 ELSE 0 END), 0) AS running_count,
        COALESCE(SUM(CASE WHEN w.status = 'WAITING' THEN 1 ELSE 0 END), 0) AS waiting_count,
        COALESCE(SUM(CASE WHEN w.status IN ('PLANNED','READY') THEN 1 ELSE 0 END), 0) AS arranged_count,
        (SELECT COUNT(DISTINCT s.agent_id) FROM workbench_agent_sessions s
          LEFT JOIN dispatch_attempts da ON s.backing_kind = 'LOCAL_INSTANCE' AND da.instance_id = s.backing_id
          LEFT JOIN partner_runs pr ON s.backing_kind = 'A2A_RUN' AND pr.run_id = s.backing_id
          LEFT JOIN work_items aw ON aw.work_id = COALESCE(da.work_id, pr.work_id)
          WHERE s.dismissed_at IS NULL AND aw.input_id = i.input_id) AS agent_count,
        COALESCE(rs.revision, 0) AS result_revision,
        CASE WHEN o.result_revision = rs.revision AND rs.revision > 0 THEN 1 ELSE 0 END AS outcome_current,
        o.completion_summary, o.completed_at, tc.completion_summary AS turn_completion_summary,
        tc.completed_at AS turn_completed_at,
        (SELECT COUNT(*) FROM partner_runs ar JOIN work_items rrw ON rrw.work_id = ar.work_id
          WHERE rrw.input_id = i.input_id AND ar.status IN ('RUNNING','WAITING_INPUT','WAITING_AUTH')) AS active_runs
        FROM joi_inbox_messages i LEFT JOIN workbenches a ON a.workbench_id = i.workbench_id
        LEFT JOIN work_items w ON w.input_id = i.input_id
        LEFT JOIN joi_goal_result_sets rs ON rs.original_input_id = i.input_id
        LEFT JOIN joi_goal_outcomes o ON o.input_id = i.input_id
        LEFT JOIN joi_turn_completions tc ON tc.input_id = i.input_id
        WHERE i.dismissed_at IS NULL AND i.input_id NOT LIKE 'joi_result_input:%'
          AND i.input_id NOT LIKE 'joi_harness_review:%'
          AND NOT (i.workbench_id IS NULL AND i.status = 'CLARIFICATION_REQUIRED')
        GROUP BY i.input_id ORDER BY i.updated_at DESC, i.input_id DESC`).all() as Row[];
      const harnessByGoal = new Map(queryHarnessGoalProjections(connection).map((projection) => [projection.goalInputId, projection]));
      const goals: JoiGoalCardDto[] = rows.map((row) => {
        const status = goalStatus(row);
        const total = number(row, "work_total");
        const active = number(row, "work_active");
        const activeRuns = number(row, "active_runs");
        const rawTitle = maskSecretText(text(row, "body")).replace(/\s+/gu, " ").trim();
        const title = rawTitle.length > 120 ? `${rawTitle.slice(0, 120)}…` : rawTitle;
        const goalId = text(row, "input_id");
        const harnessProjection = harnessByGoal.get(goalId);
        const failureReasonCode = normalizeJoiFailureReasonCode(row.failure_reason_code);
        return {
          agentCount: number(row, "agent_count"),
          workbench: {
            workbenchId: typeof row.workbench_id === "string" ? row.workbench_id : "",
            name: typeof row.workbench_name === "string" ? row.workbench_name : "等待归属",
          },
          canDelete: (row.canceled_at !== null && row.canceled_at !== undefined
            || text(row, "inbox_status") === "CONSUMED" || number(row, "outcome_current") === 1)
            && active === 0 && activeRuns === 0
            && ((row.canceled_at !== null && row.canceled_at !== undefined) || total === 0 || number(row, "outcome_current") === 1),
          ...(status === "NEEDS_ATTENTION" && (typeof row.clarification_reason_code === "string" || typeof row.clarification_prompt === "string") ? {
            clarification: {
              ...(typeof row.clarification_prompt === "string" ? { prompt: row.clarification_prompt } : {}),
              ...(typeof row.clarification_reason_code === "string" ? { reasonCode: row.clarification_reason_code } : {}),
            },
          } : {}),
          goalId,
          ...(status === "FAILED" && typeof row.failure_reason_code === "string" && typeof row.failure_count === "number" ? {
            failure: {
              attempts: row.failure_count,
              executionStarted: total > 0 || number(row, "agent_count") > 0,
              reasonCode: failureReasonCode,
              suggestedAction: suggestedActionForJoiInputFailure(failureReasonCode),
            },
          } : {}),
          ...(harnessProjection === undefined ? {} : { harness: toHarnessDto(harnessProjection) }),
          ...(number(row, "outcome_current") === 1 && typeof row.completion_summary === "string"
            ? { completionSummary: stripPathRedactions(row.completion_summary) }
            : number(row, "result_revision") === 0 && text(row, "inbox_status") === "CONSUMED" && typeof row.turn_completion_summary === "string"
              ? { completionSummary: stripPathRedactions(row.turn_completion_summary) }
              : {}),
          ...(number(row, "outcome_current") === 1 && typeof row.completed_at === "string"
            ? { completedAt: row.completed_at }
            : number(row, "result_revision") === 0 && text(row, "inbox_status") === "CONSUMED" && typeof row.turn_completed_at === "string"
              ? { completedAt: row.turn_completed_at }
              : {}),
          status,
          title: title === "" ? "未命名目标" : title,
          updatedAt: text(row, "projection_updated_at"),
          work: { active, completed: number(row, "completed_count"), failed: number(row, "failed_count"), total },
        };
      });
      const goalsById = new Map(goals.map((goal) => [goal.goalId, goal]));
      const cutoff = new Date(now.getTime() - 15_000).toISOString();
      const turns = connection.prepare(`SELECT t.turn_id, COALESCE(i.goal_input_id, t.input_id) AS goal_id,
          t.status, t.created_at, t.updated_at
        FROM joi_turns t JOIN joi_inbox_messages i ON i.input_id = t.input_id
        WHERE (i.goal_input_id IS NOT NULL OR t.input_id NOT LIKE 'joi_result_input:%')
          AND (t.status IN ('PENDING','RUNNING','WAITING') OR t.updated_at >= ?)
        UNION ALL
        SELECT 'pending:' || i.input_id, COALESCE(i.goal_input_id, i.input_id), 'PENDING', i.updated_at, i.updated_at
          FROM joi_inbox_messages i
         WHERE i.status = 'PENDING'
           AND (i.goal_input_id IS NOT NULL OR (
             i.input_id NOT LIKE 'joi_result_input:%'
             AND i.input_id NOT LIKE 'joi_harness_review:%'
             AND i.input_id NOT LIKE 'joi_signal_input:%'
           ))
           AND NOT EXISTS (SELECT 1 FROM joi_turns t WHERE t.input_id = i.input_id
             AND t.status IN ('PENDING','RUNNING','WAITING'))
        ORDER BY 4 DESC, 1 DESC`).all(cutoff) as Row[];
      const thinking = collapseThinkingByGoal(turns.filter((row) => {
        if (text(row, "status") === "PENDING") return true;
        const goal = goalsById.get(text(row, "goal_id"));
        return goal === undefined || !["COMPLETED", "FAILED", "CANCELED"].includes(goal.status);
      }).map((row) => {
        const status = text(row, "status");
        const queued = status === "PENDING";
        const active = queued || ["RUNNING", "WAITING"].includes(status);
        const updatedAt = text(row, "updated_at");
        const goalId = text(row, "goal_id");
        const goal = goalsById.get(goalId);
        const phase = queued ? "queued" as const : active ? "progressing" as const : "settled" as const;
        return {
          ...(active ? {} : { expiresAt: new Date(Date.parse(updatedAt) + 15_000).toISOString() }),
          agentCount: goal?.agentCount ?? 0,
          goalId,
          phase,
          stage: thinkingStage(goal, phase),
          startedAt: text(row, "created_at"),
          turnId: text(row, "turn_id"),
          work: goal?.work ?? { active: 0, completed: 0, failed: 0, total: 0 },
        };
      }).filter((item) => item.phase === "queued" || item.phase === "progressing" || Date.parse(item.expiresAt ?? "") > now.getTime()));
      const unassignedActions = (connection.prepare(`SELECT input_id, workbench_id, status, clarification_reason_code,
        clarification_prompt, body, created_at, canceled_at FROM joi_inbox_messages
        WHERE dismissed_at IS NULL AND workbench_id IS NULL AND status = 'CLARIFICATION_REQUIRED'
        ORDER BY created_at DESC, input_id DESC`).all() as Row[]).map((row) => ({
        acceptedAt: text(row, "created_at"),
        ...(typeof row.clarification_prompt === "string" ? { clarificationPrompt: row.clarification_prompt } : {}),
        ...(typeof row.clarification_reason_code === "string" ? { clarificationReasonCode: row.clarification_reason_code } : {}),
        inputId: text(row, "input_id"),
        status: "CLARIFICATION_REQUIRED" as const,
        textPreview: maskSecretText(text(row, "body")).replace(/\s+/gu, " ").trim().slice(0, 81),
      }));
      return { goals, thinking, unassignedActions };
    });
  }
}
