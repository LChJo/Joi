import type { DatabaseSync } from "node:sqlite";

/** A stopped planning input needs a durable user recovery path when no other owner can advance it. */
export function settleInterruptedJoiPlanning(connection: DatabaseSync, input: {
  now: string; inputId?: string; reasonCode?: string; stoppedBefore?: string;
}): void {
  connection.prepare(`UPDATE joi_inbox_messages SET failed_at=?,failure_reason_code=?,
    failure_count=MAX(1,turn_failure_count),updated_at=? WHERE input_id IN (
      SELECT i.input_id FROM joi_inbox_messages i
      JOIN joi_turns failed ON failed.turn_id=(SELECT t.turn_id FROM joi_turns t WHERE t.input_id=i.input_id
        ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1)
      WHERE (? IS NULL OR i.input_id=?) AND i.goal_input_id IS NULL AND i.status='CONSUMED'
        AND i.input_id NOT LIKE 'joi_result_input:%' AND i.input_id NOT LIKE 'joi_harness_review:%'
        AND i.input_id NOT LIKE 'joi_signal_input:%' AND i.input_id NOT LIKE 'joi_goal_resume:%'
        AND i.canceled_at IS NULL AND i.dismissed_at IS NULL AND i.failed_at IS NULL
        AND i.clarification_reason_code IS NULL AND failed.status='FAILED'
        AND failed.created_at>=COALESCE(i.reopened_at,i.created_at)
        AND (? IS NULL OR failed.updated_at<=?)
        AND NOT EXISTS (SELECT 1 FROM joi_goal_result_sets pending WHERE pending.original_input_id=i.input_id
          AND pending.revision>pending.synthesized_revision)
        AND (NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.status<>'CANCELED')
          OR EXISTS (SELECT 1 FROM joi_goal_requirements requirements WHERE requirements.goal_input_id=i.input_id
            AND EXISTS (SELECT 1 FROM joi_goal_requirement_sources source WHERE source.goal_input_id=i.input_id
              AND source.kind<>'LEGACY' AND source.source_revision>requirements.processed_source_revision))
          OR (i.reopened_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM joi_goal_result_sets prior WHERE prior.original_input_id=i.input_id
              AND prior.revision>0 AND prior.synthesized_revision=prior.revision AND prior.updated_at<i.reopened_at)
            AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.status<>'CANCELED' AND w.updated_at>=i.reopened_at)))
        AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.status IN ('PLANNED','READY','RUNNING','WAITING'))
        AND NOT EXISTS (SELECT 1 FROM partner_runs r JOIN work_items w ON w.work_id=r.work_id
          WHERE w.input_id=i.input_id AND r.status IN ('RUNNING','WAITING_INPUT','WAITING_AUTH'))
        AND NOT EXISTS (SELECT 1 FROM joi_turns t JOIN joi_inbox_messages source ON source.input_id=t.input_id
          WHERE (source.input_id=i.input_id OR source.goal_input_id=i.input_id) AND t.status IN ('PENDING','RUNNING','WAITING'))
        AND NOT EXISTS (SELECT 1 FROM joi_inbox_messages child WHERE child.goal_input_id=i.input_id
          AND child.status IN ('PENDING','ROUTED','CLARIFICATION_REQUIRED'))
        AND NOT EXISTS (SELECT 1 FROM joi_user_action_requests action WHERE action.input_id=i.input_id
          AND action.status IN ('OPEN','RESOLVED') AND action.created_at>=COALESCE(i.reopened_at,i.created_at))
        AND NOT EXISTS (SELECT 1 FROM joi_goal_execution_gates gate WHERE gate.goal_input_id=i.input_id AND gate.status<>'OPEN')
        AND NOT EXISTS (SELECT 1 FROM joi_turn_completions c WHERE c.input_id=i.input_id AND c.completed_at>=COALESCE(i.reopened_at,i.created_at))
        AND NOT EXISTS (SELECT 1 FROM joi_current_goal_outcomes o WHERE o.input_id=i.input_id AND o.completed_at>=COALESCE(i.reopened_at,i.created_at))
      ORDER BY failed.updated_at,i.input_id LIMIT 50
    )`).run(input.now,input.reasonCode??"joi_planning_interrupted",input.now,input.inputId??null,input.inputId??null,input.stoppedBefore??null,input.stoppedBefore??null);
}
