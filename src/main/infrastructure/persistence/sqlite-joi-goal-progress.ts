import type { DatabaseSync } from "node:sqlite";
import type { JoiGoalProgressDto, JoiGoalProgressStageDto, JoiGoalTurnProgressDto } from "../../../shared/joi.js";
import { goalRequirementsCurrentSql } from "./sqlite-goal-requirements.js";

type Row = Record<string, string | number | null>;
const LIVE = new Set(["PENDING", "RUNNING", "WAITING"]);

function stage(inputId: string): JoiGoalProgressStageDto {
  if (inputId.startsWith("joi_harness_review:goal:")) return "REVIEWING";
  if (inputId.startsWith("joi_result_input:")) return "FINALIZING";
  if (inputId.startsWith("joi_recovery:") || inputId.startsWith("joi_goal_resume:")) return "RECOVERING";
  return "PLANNING";
}

/** The detail reader owns the snapshot. Queries select metadata, never private session messages. */
export function queryJoiGoalProgress(db: DatabaseSync, goalId: string): JoiGoalProgressDto {
  const goal = db.prepare(`SELECT i.status,i.created_at,i.updated_at,i.canceled_at,i.failed_at,
    i.clarification_reason_code,i.reopened_at,gate.status AS gate_status,gate.updated_at AS gate_updated_at,
    m.status AS map_status,m.updated_at AS map_updated_at,m.reviewed_revision,
    rs.revision AS result_revision,o.disposition AS outcome_disposition,o.updated_at AS outcome_updated_at,
    CASE WHEN o.result_revision=rs.revision AND rs.revision>0
      AND o.completed_at>=COALESCE(i.reopened_at,i.created_at) THEN 1 ELSE 0 END AS outcome_current,
    CASE WHEN synth.status='CONSUMED' AND synth.failed_at IS NOT NULL AND synth.result_revision=rs.revision
      AND ${goalRequirementsCurrentSql("i.input_id", "synth.requirements_revision")} THEN 1 ELSE 0 END AS synthesis_stopped
    FROM joi_inbox_messages i JOIN joi_harness_maps m ON m.goal_input_id=i.input_id
    LEFT JOIN joi_goal_execution_gates gate ON gate.goal_input_id=i.input_id
    LEFT JOIN joi_goal_result_sets rs ON rs.original_input_id=i.input_id
    LEFT JOIN joi_inbox_messages synth ON synth.input_id=rs.synthetic_input_id
    LEFT JOIN joi_current_goal_outcomes o ON o.input_id=i.input_id
    WHERE i.input_id=?`).get(goalId) as Row;
  const recent = db.prepare(`SELECT t.turn_id,t.input_id,t.status,t.created_at,t.updated_at
    FROM joi_inbox_messages source JOIN joi_turns t ON t.input_id=source.input_id
    WHERE (source.input_id=? OR source.goal_input_id=?)
      AND source.workbench_id IS (SELECT workbench_id FROM joi_inbox_messages WHERE input_id=?)
    ORDER BY CASE WHEN t.status IN ('PENDING','RUNNING','WAITING') THEN 0 ELSE 1 END,
      t.created_at DESC,t.turn_id DESC LIMIT 12`).all(goalId, goalId, goalId) as Row[];
  const counts = db.prepare(`SELECT COUNT(*) AS turns,MAX(t.updated_at) AS updated_at,
    COALESCE(SUM(CASE WHEN source.input_id LIKE 'joi_harness_review:goal:%' THEN 1 ELSE 0 END),0) AS reviews
    FROM joi_inbox_messages source JOIN joi_turns t ON t.input_id=source.input_id
    WHERE (source.input_id=? OR source.goal_input_id=?)
      AND source.workbench_id IS (SELECT workbench_id FROM joi_inbox_messages WHERE input_id=?)`).get(goalId, goalId, goalId) as Row;
  const pending = db.prepare(`SELECT input_id,created_at,updated_at FROM joi_inbox_messages
    WHERE (input_id=? OR goal_input_id=?) AND status='PENDING' AND canceled_at IS NULL
      AND dismissed_at IS NULL AND failed_at IS NULL
      AND workbench_id IS (SELECT workbench_id FROM joi_inbox_messages WHERE input_id=?)
    ORDER BY created_at,input_id LIMIT 1`).get(goalId, goalId, goalId) as Row | undefined;
  const work = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN status IN ('PLANNED','READY','RUNNING','WAITING') THEN 1 ELSE 0 END),0) AS active,
    COALESCE(SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END),0) AS completed,
    COALESCE(SUM(CASE WHEN status='FAILED' THEN 1 ELSE 0 END),0) AS failed,MAX(updated_at) AS updated_at,
    COALESCE(SUM(CASE WHEN status='FAILED'
      AND (SELECT COUNT(*) FROM work_recovery_attempts a WHERE a.source_work_id=w.work_id)<2
      AND (SELECT COUNT(*) FROM joi_inbox_messages recovery WHERE recovery.goal_input_id=w.input_id
        AND substr(recovery.idempotency_key,1,length('work_recovery:' || w.work_id || ':'))
          ='work_recovery:' || w.work_id || ':')<2 THEN 1 ELSE 0 END),0) AS recoverable
    FROM work_items w WHERE input_id=? AND workbench_id IS
      (SELECT workbench_id FROM joi_inbox_messages WHERE input_id=?)`).get(goalId, goalId) as Row;
  const recentTurns: JoiGoalTurnProgressDto[] = recent.map((turn) => ({
    turnId: String(turn.turn_id), stage: stage(String(turn.input_id)),
    status: turn.status as JoiGoalTurnProgressDto["status"],
    startedAt: String(turn.created_at), updatedAt: String(turn.updated_at),
  }));
  const live = recentTurns.find((turn) => LIVE.has(turn.status));
  const active = Number(work.active);
  const currentOutcome = goal.outcome_current === 1;
  const blocked = currentOutcome && goal.outcome_disposition === "BLOCKED";
  const complete = goal.map_status === "CLEARED" && active === 0 && pending === undefined
    && (currentOutcome && ["COMPLETED", "ACCEPTED_WITH_GAPS", "CONTINUE"].includes(String(goal.outcome_disposition))
      || Number(work.total) === 0 && Number(goal.result_revision ?? 0) === 0 && goal.status === "CONSUMED");
  let state: JoiGoalProgressDto["state"];
  if (goal.canceled_at !== null) state = "CANCELED";
  else if (goal.failed_at !== null) state = "FAILED";
  else if (goal.gate_status === "WAITING_INPUT" || goal.clarification_reason_code !== null) state = "WAITING_USER";
  else if (complete) state = "COMPLETED";
  else if (live?.status === "RUNNING") state = "RUNNING";
  else if (live?.status === "PENDING" || pending !== undefined) state = "QUEUED";
  else if (active > 0) state = "WAITING_PARTNERS";
  else if (blocked) state = goal.map_status === "ACTIVE" && Number(work.recoverable) > 0 ? "RECOVERING" : "FAILED";
  else if (goal.synthesis_stopped === 1 && !currentOutcome) state = "FAILED";
  else if (recentTurns[0]?.stage === "PLANNING" && ["FAILED","ABORTED"].includes(recentTurns[0].status)
    && recentTurns[0].startedAt >= String(goal.reopened_at ?? goal.created_at)) state = "FAILED";
  else state = "IDLE";
  const currentStage = ["COMPLETED", "FAILED", "CANCELED"].includes(state) ? undefined
    : live?.stage ?? (pending === undefined ? undefined : stage(String(pending.input_id)));
  const timestamps = [goal.updated_at, goal.map_updated_at, goal.gate_updated_at, goal.outcome_updated_at,
    goal.canceled_at, goal.failed_at, work.updated_at, counts.updated_at, pending?.updated_at]
    .filter((value): value is string => typeof value === "string").sort();
  return {
    state, ...(currentStage === undefined ? {} : { stage: currentStage }),
    startedAt: String(goal.created_at), updatedAt: timestamps.at(-1) ?? String(goal.updated_at),
    turnCount: Number(counts.turns), reviewCount: Number(counts.reviews),
    work: { active, completed: Number(work.completed), failed: Number(work.failed), total: Number(work.total) }, recentTurns,
  };
}
