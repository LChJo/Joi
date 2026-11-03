-- A Work must remain attached to the exact user goal/turn that created it.
-- Historical plans persisted their Work ids in candidate_json, which gives us a
-- deterministic, content-free backfill source.
CREATE TABLE migration_034_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO migration_034_guard(valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
    FROM work_items w
   WHERE w.input_id IS NULL
     AND (
       SELECT COUNT(DISTINCT t.input_id)
         FROM dispatch_plans p
         JOIN joi_turns t ON t.turn_id = p.turn_id
        WHERE json_valid(p.candidate_json)
          AND EXISTS (
            SELECT 1 FROM json_each(p.candidate_json, '$.workIds') candidate
             WHERE candidate.value = w.work_id
          )
          AND t.avatar_id = w.avatar_id
     ) <> 1
) THEN 1 ELSE 0 END;

UPDATE work_items AS w
   SET input_id = (
     SELECT MIN(t.input_id)
       FROM dispatch_plans p
       JOIN joi_turns t ON t.turn_id = p.turn_id
      WHERE json_valid(p.candidate_json)
        AND EXISTS (
          SELECT 1 FROM json_each(p.candidate_json, '$.workIds') candidate
           WHERE candidate.value = w.work_id
        )
        AND t.avatar_id = w.avatar_id
   )
 WHERE w.input_id IS NULL;

INSERT INTO migration_034_guard(valid)
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM work_items w
   WHERE w.input_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM joi_turns t
         WHERE t.input_id = w.input_id AND t.avatar_id = w.avatar_id
      )
) THEN 1 ELSE 0 END;

DROP TABLE migration_034_guard;

CREATE TRIGGER work_items_require_goal_binding_insert
BEFORE INSERT ON work_items
WHEN NEW.input_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM joi_turns t
   WHERE t.input_id = NEW.input_id AND t.avatar_id = NEW.avatar_id
)
BEGIN
  SELECT RAISE(ABORT, 'work_goal_binding_invalid');
END;

CREATE TRIGGER work_items_require_goal_binding_update
BEFORE UPDATE OF input_id, avatar_id ON work_items
WHEN NEW.input_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM joi_turns t
   WHERE t.input_id = NEW.input_id AND t.avatar_id = NEW.avatar_id
)
BEGIN
  SELECT RAISE(ABORT, 'work_goal_binding_invalid');
END;

ALTER TABLE work_results ADD COLUMN is_authoritative INTEGER NOT NULL DEFAULT 0
  CHECK (is_authoritative IN (0, 1));

UPDATE work_results AS r
   SET is_authoritative = CASE WHEN r.result_id = COALESCE(
     (SELECT terminal.result_id FROM work_results terminal
       WHERE terminal.run_id = r.run_id
         AND terminal.status IN ('COMPLETED', 'FAILED', 'UNKNOWN')
       ORDER BY terminal.created_at, terminal.result_id LIMIT 1),
     (SELECT waiting.result_id FROM work_results waiting
       WHERE waiting.run_id = r.run_id
       ORDER BY waiting.created_at DESC, waiting.result_id DESC LIMIT 1)
   ) THEN 1 ELSE 0 END;

CREATE UNIQUE INDEX idx_work_results_one_authoritative_per_run
  ON work_results(run_id) WHERE is_authoritative = 1;
CREATE INDEX idx_work_results_authoritative_avatar_created
  ON work_results(avatar_id, is_authoritative, created_at DESC, result_id DESC);

UPDATE partner_runs
   SET status = (SELECT r.status FROM work_results r
                  WHERE r.run_id = partner_runs.run_id AND r.is_authoritative = 1),
       updated_at = (SELECT r.created_at FROM work_results r
                      WHERE r.run_id = partner_runs.run_id AND r.is_authoritative = 1)
 WHERE EXISTS (SELECT 1 FROM work_results r
                WHERE r.run_id = partner_runs.run_id AND r.is_authoritative = 1);

UPDATE dispatch_attempts
   SET status = (SELECT r.status FROM work_results r
                  WHERE r.action_id = dispatch_attempts.action_id AND r.is_authoritative = 1
                  ORDER BY r.created_at DESC, r.result_id DESC LIMIT 1),
       updated_at = (SELECT r.created_at FROM work_results r
                      WHERE r.action_id = dispatch_attempts.action_id AND r.is_authoritative = 1
                      ORDER BY r.created_at DESC, r.result_id DESC LIMIT 1)
 WHERE EXISTS (SELECT 1 FROM work_results r
                WHERE r.action_id = dispatch_attempts.action_id AND r.is_authoritative = 1);

UPDATE work_items
   SET status = CASE (
     SELECT r.status FROM work_results r
      WHERE r.work_id = work_items.work_id AND r.is_authoritative = 1 AND r.is_late = 0
      ORDER BY r.created_at DESC, r.result_id DESC LIMIT 1
   )
     WHEN 'COMPLETED' THEN 'COMPLETED'
     WHEN 'FAILED' THEN 'FAILED'
     ELSE 'WAITING'
   END,
       updated_at = (SELECT r.created_at FROM work_results r
                      WHERE r.work_id = work_items.work_id AND r.is_authoritative = 1 AND r.is_late = 0
                      ORDER BY r.created_at DESC, r.result_id DESC LIMIT 1)
 WHERE status <> 'CANCELED'
   AND EXISTS (SELECT 1 FROM work_results r
                WHERE r.work_id = work_items.work_id AND r.is_authoritative = 1 AND r.is_late = 0);

UPDATE avatar_task_projections
   SET recent_results_json = COALESCE((
     SELECT json_group_array(json(result_json)) FROM (
       SELECT json_object('resultId', r.result_id, 'workId', r.work_id,
                          'status', r.status, 'summary', r.summary) AS result_json
         FROM work_results r
        WHERE r.avatar_id = avatar_task_projections.avatar_id AND r.is_authoritative = 1
        ORDER BY r.created_at DESC, r.result_id DESC LIMIT 10
     )
   ), '[]');
