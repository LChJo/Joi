/** SQL fragments use the inbox alias `i` in both foreground and background scheduling. */
export const JOI_ACTIVE_INPUT_SQL = `
  i.canceled_at IS NULL AND i.dismissed_at IS NULL AND i.failed_at IS NULL
  AND (i.workbench_id IS NULL OR EXISTS (
    SELECT 1 FROM workbenches input_bench
     WHERE input_bench.workbench_id = i.workbench_id AND input_bench.status = 'ACTIVE'
  ))
  AND EXISTS (
    SELECT 1 FROM joi_inbox_messages goal
     WHERE goal.input_id = COALESCE(i.goal_input_id, i.input_id)
       AND goal.canceled_at IS NULL AND goal.dismissed_at IS NULL AND goal.failed_at IS NULL
       AND (goal.workbench_id IS NULL OR EXISTS (
         SELECT 1 FROM workbenches goal_bench
          WHERE goal_bench.workbench_id = goal.workbench_id AND goal_bench.status = 'ACTIVE'
       ))
  )`;

export const JOI_RUNNABLE_INPUT_SQL = `
  i.status = 'PENDING' AND ${JOI_ACTIVE_INPUT_SQL}
  AND NOT EXISTS (
    SELECT 1 FROM joi_goal_execution_gates gate
     WHERE gate.goal_input_id = COALESCE(i.goal_input_id, i.input_id)
       AND (gate.status = 'WAITING_INPUT'
         OR (gate.status = 'REVIEWING' AND gate.resume_input_id IS NOT i.input_id))
  )`;

/** Use inbox alias i and only retire synthesis snapshots backed by a result set. */
export const STALE_GOAL_SYNTHESIS_SQL = `
  i.result_revision IS NOT NULL AND i.input_id GLOB 'joi_result_input:goal:*' AND EXISTS (
    SELECT 1 FROM joi_goal_result_sets rs
    LEFT JOIN joi_goal_requirements gr ON gr.goal_input_id = rs.original_input_id
    WHERE rs.original_input_id = i.goal_input_id AND (
      rs.revision <> i.result_revision
      OR COALESCE(gr.revision, 0) <> COALESCE(i.requirements_revision, 0)
      OR (rs.synthetic_input_id IS NOT NULL AND rs.synthetic_input_id <> i.input_id)
    )
  )`;

/** Shared by result discovery and synthesis admission using result alias r and event alias e. */
export const UNSYNTHESIZED_PARTNER_RESULT_SQL = `
  r.is_authoritative = 1 AND r.is_late = 0 AND r.status IN ('COMPLETED', 'FAILED', 'UNKNOWN')
  AND NOT EXISTS (SELECT 1 FROM joi_goal_result_members m WHERE m.event_id = e.event_id)`;

export const GOAL_SYNTHESIS_WAITING_FOR_RESULTS_SQL = `
  i.result_revision IS NOT NULL AND i.input_id GLOB 'joi_result_input:goal:*' AND (
    EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = i.goal_input_id AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
    OR EXISTS (
      SELECT 1 FROM work_items w CROSS JOIN partner_result_events e ON e.work_id = w.work_id
      JOIN work_results r ON r.run_id = e.run_id AND r.status = e.status
      WHERE w.input_id = i.goal_input_id AND ${UNSYNTHESIZED_PARTNER_RESULT_SQL}
    )
  )`;

/** Running operations always retain priority; active waits yield only to an explicit user action. */
export const JOI_FOREGROUND_WORK_SQL = `
  w.status = 'RUNNING' OR (
    w.status IN ('PLANNED','READY','WAITING')
    AND EXISTS (SELECT 1 FROM workbenches work_bench
      WHERE work_bench.workbench_id = w.workbench_id AND work_bench.status = 'ACTIVE')
    AND (w.input_id IS NULL OR EXISTS (
      SELECT 1 FROM joi_inbox_messages i WHERE i.input_id = w.input_id AND ${JOI_ACTIVE_INPUT_SQL}
    ))
    AND (
      (w.status = 'WAITING' AND NOT EXISTS (
        SELECT 1 FROM joi_user_action_requests action
         WHERE action.work_id = w.work_id AND action.input_id = w.input_id AND action.status = 'OPEN'
      ))
      OR (w.status IN ('PLANNED','READY') AND NOT EXISTS (
        SELECT 1 FROM joi_inbox_messages i
        JOIN joi_goal_execution_gates gate ON gate.goal_input_id = COALESCE(i.goal_input_id, i.input_id)
         WHERE i.input_id = w.input_id AND gate.status <> 'OPEN'
      ))
    )
  )`;
