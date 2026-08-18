-- UNKNOWN is a terminal execution failure, not a request for user input.
CREATE TEMP TABLE affected_unknown_work_039 (
  work_id TEXT PRIMARY KEY,
  workbench_id TEXT NOT NULL,
  repaired_at TEXT NOT NULL
);

INSERT INTO affected_unknown_work_039 (work_id, workbench_id, repaired_at)
SELECT w.work_id, w.workbench_id, MAX(r.created_at)
  FROM work_items w
  JOIN work_results r ON r.work_id = w.work_id
 WHERE w.status = 'WAITING'
   AND r.status = 'UNKNOWN'
   AND r.is_authoritative = 1
   AND NOT EXISTS (
     SELECT 1 FROM partner_runs active_run
      WHERE active_run.work_id = w.work_id
        AND active_run.status IN ('RUNNING', 'WAITING_INPUT', 'WAITING_AUTH')
   )
 GROUP BY w.work_id, w.workbench_id;

-- enqueuePartnerResult records a member before checking whether other Work is active.
-- Remove only unsynthesized UNKNOWN members so the actor can retry that same durable event.
DELETE FROM joi_goal_result_members
 WHERE event_id IN (
   SELECT event.event_id
     FROM partner_result_events event
     JOIN affected_unknown_work_039 affected ON affected.work_id = event.work_id
    WHERE event.status = 'UNKNOWN'
 )
   AND EXISTS (
     SELECT 1 FROM joi_goal_result_sets result_set
      WHERE result_set.original_input_id = joi_goal_result_members.original_input_id
        AND result_set.synthesized_revision < result_set.revision
   );

UPDATE work_items
   SET status = 'FAILED',
       updated_at = (SELECT affected.repaired_at FROM affected_unknown_work_039 affected
                      WHERE affected.work_id = work_items.work_id)
 WHERE work_id IN (SELECT work_id FROM affected_unknown_work_039);

UPDATE workbench_task_projections
   SET active_work_json = (
         SELECT COALESCE(json_group_array(json(ordered.item)), '[]')
           FROM (
             SELECT json_object('workId', work.work_id, 'title', work.title, 'status', work.status) AS item
               FROM work_items work
              WHERE work.workbench_id = workbench_task_projections.workbench_id
                AND work.status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING')
              ORDER BY work.created_at, work.work_id
           ) ordered
       ),
       updated_at = COALESCE(
         (SELECT MAX(work.updated_at) FROM work_items work
           WHERE work.workbench_id = workbench_task_projections.workbench_id),
         updated_at
       )
 WHERE workbench_id IN (SELECT DISTINCT workbench_id FROM affected_unknown_work_039);

DROP TABLE affected_unknown_work_039;
