ALTER TABLE joi_inbox_messages ADD COLUMN goal_input_id TEXT
  REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT;
ALTER TABLE joi_inbox_messages ADD COLUMN result_revision INTEGER
  CHECK (result_revision IS NULL OR result_revision > 0);

CREATE TABLE joi_goal_result_sets (
  original_input_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  synthesized_revision INTEGER NOT NULL DEFAULT 0 CHECK (synthesized_revision >= 0),
  synthetic_input_id TEXT UNIQUE,
  updated_at TEXT NOT NULL
);

CREATE TABLE joi_goal_result_members (
  original_input_id TEXT NOT NULL REFERENCES joi_goal_result_sets(original_input_id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL UNIQUE REFERENCES partner_result_events(event_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (original_input_id, event_id)
);
CREATE INDEX idx_joi_goal_result_members_revision
  ON joi_goal_result_members(original_input_id, revision, event_id);

CREATE TABLE joi_goal_outcomes (
  input_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  completion_summary TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_joi_inbox_goal_result
  ON joi_inbox_messages(goal_input_id, result_revision, status);

-- Reconcile legacy per-result inputs. A consumed legacy result means joi already
-- integrated it; preserve that historical completion without copying Agent text.
WITH legacy_sets AS (
  SELECT w.input_id AS original_input_id,
         COUNT(*) AS revision,
         CASE WHEN MIN(CASE WHEN e.consumed_at IS NOT NULL THEN 1 ELSE 0 END) = 1
                   AND NOT EXISTS (SELECT 1 FROM work_items active
                                    WHERE active.input_id = w.input_id
                                      AND active.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
              THEN COUNT(*) ELSE 0 END AS synthesized_revision,
         MAX(e.created_at) AS updated_at
    FROM partner_result_events e
    JOIN work_items w ON w.work_id = e.work_id
    JOIN work_results r ON r.run_id = e.run_id AND r.status = e.status AND r.is_authoritative = 1
   GROUP BY w.input_id
)
INSERT INTO joi_goal_result_sets
  (original_input_id, revision, synthesized_revision, updated_at)
SELECT original_input_id, revision, synthesized_revision, updated_at FROM legacy_sets;

WITH ranked_members AS (
  SELECT w.input_id AS original_input_id, e.event_id,
         ROW_NUMBER() OVER (PARTITION BY w.input_id ORDER BY e.created_at, e.event_id) AS revision
    FROM partner_result_events e
    JOIN work_items w ON w.work_id = e.work_id
    JOIN work_results r ON r.run_id = e.run_id AND r.status = e.status AND r.is_authoritative = 1
)
INSERT INTO joi_goal_result_members (original_input_id, event_id, revision)
SELECT original_input_id, event_id, revision FROM ranked_members;

INSERT INTO joi_goal_outcomes
  (input_id, result_revision, completion_summary, completed_at, updated_at)
SELECT s.original_input_id, s.synthesized_revision,
       '历史工作已完成；Agent 结果可在 Avatar 详情中查看。',
       MAX(e.consumed_at), MAX(e.consumed_at)
  FROM joi_goal_result_sets s
  JOIN joi_goal_result_members m ON m.original_input_id = s.original_input_id
  JOIN partner_result_events e ON e.event_id = m.event_id
 WHERE s.synthesized_revision = s.revision AND s.revision > 0
 GROUP BY s.original_input_id, s.synthesized_revision;

-- If legacy results were not yet integrated, replace their one-result inbox rows
-- with one stable goal-scoped synthesis input so restart processing is exactly-once.
INSERT INTO joi_inbox_messages
  (input_id, idempotency_key, body, status, avatar_id, goal_input_id, result_revision, created_at, updated_at)
SELECT 'joi_result_input:goal:' || s.original_input_id,
       'partner_result_goal:' || s.original_input_id,
       'Historical Agent results are ready for one goal-level synthesis.' || char(10) ||
       'goalInputId=' || s.original_input_id || char(10) ||
       'resultRevision=' || s.revision || char(10) ||
       GROUP_CONCAT('resultId=' || r.result_id || ' workId=' || r.work_id ||
                    ' status=' || r.status || ' summary=' || substr(r.summary, 1, 320), char(10)) || char(10) ||
       'Synthesize one concise completion update and call turn_complete with RESULT_SYNTHESIZED.',
       'PENDING', MIN(e.avatar_id), s.original_input_id, s.revision, MIN(e.created_at), MAX(e.created_at)
  FROM joi_goal_result_sets s
  JOIN joi_goal_result_members m ON m.original_input_id = s.original_input_id
  JOIN partner_result_events e ON e.event_id = m.event_id
  JOIN work_results r ON r.run_id = e.run_id AND r.status = e.status AND r.is_authoritative = 1
 WHERE s.synthesized_revision < s.revision
   AND NOT EXISTS (SELECT 1 FROM work_items active
                    WHERE active.input_id = s.original_input_id
                      AND active.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
 GROUP BY s.original_input_id, s.revision;

UPDATE joi_goal_result_sets
   SET synthetic_input_id = 'joi_result_input:goal:' || original_input_id
 WHERE synthesized_revision < revision
   AND EXISTS (SELECT 1 FROM joi_inbox_messages i
                WHERE i.input_id = 'joi_result_input:goal:' || original_input_id);

UPDATE joi_inbox_messages
   SET status = 'CONSUMED'
 WHERE input_id IN (
   SELECT e.input_id
     FROM partner_result_events e
     JOIN joi_goal_result_members m ON m.event_id = e.event_id
     JOIN joi_goal_result_sets s ON s.original_input_id = m.original_input_id
    WHERE s.synthetic_input_id IS NOT NULL AND e.input_id IS NOT NULL
 ) AND status <> 'CONSUMED';
