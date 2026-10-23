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
