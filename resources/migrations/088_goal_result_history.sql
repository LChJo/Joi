ALTER TABLE joi_goal_outcomes ADD COLUMN completion_key TEXT;

CREATE TABLE joi_goal_result_history (
  result_id TEXT PRIMARY KEY,
  goal_input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'COMPLETED_WITH_GAPS')),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0),
  UNIQUE (goal_input_id, source_key)
);
CREATE INDEX idx_goal_result_history_page
  ON joi_goal_result_history(goal_input_id, completed_at DESC, result_id DESC);

ALTER TABLE result_exports ADD COLUMN result_id TEXT REFERENCES joi_goal_result_history(result_id) ON DELETE RESTRICT;

-- Only a published completion may enter the user-facing journal. Internal synthesis history
-- remains evidence for the coordinator, including layers that never completed the goal.
CREATE VIEW joi_final_result_candidates AS
SELECT g.input_id AS goal_input_id,
       COALESCE(o.completion_key, 'legacy-outcome:' || o.result_revision || ':' || COALESCE(o.requirements_revision, 0) || ':' || o.completed_at) AS source_key,
       o.completed_at,
       CASE WHEN o.disposition = 'ACCEPTED_WITH_GAPS' THEN 'COMPLETED_WITH_GAPS' ELSE 'COMPLETED' END AS status,
       o.completion_summary AS body
  FROM joi_inbox_messages g
  JOIN joi_current_goal_outcomes o ON o.input_id = g.input_id
  JOIN joi_goal_result_sets rs ON rs.original_input_id = g.input_id AND rs.revision = o.result_revision AND rs.revision > 0
 WHERE g.goal_input_id IS NULL AND g.status = 'CONSUMED'
   AND g.canceled_at IS NULL AND g.failed_at IS NULL AND g.dismissed_at IS NULL
   AND g.clarification_reason_code IS NULL
   AND o.disposition IN ('COMPLETED', 'ACCEPTED_WITH_GAPS')
   AND length(trim(o.completion_summary)) > 0
   AND o.completed_at >= COALESCE(g.reopened_at, g.created_at)
   AND NOT EXISTS (SELECT 1 FROM joi_harness_maps m WHERE m.goal_input_id = g.input_id AND m.status = 'ACTIVE')
   AND NOT EXISTS (SELECT 1 FROM joi_goal_execution_gates gate WHERE gate.goal_input_id = g.input_id AND gate.status <> 'OPEN')
   AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = g.input_id AND w.status NOT IN ('COMPLETED','FAILED','CANCELED'))
UNION ALL
SELECT g.input_id, 'turn:' || tc.turn_id, tc.completed_at, 'COMPLETED', tc.completion_summary
  FROM joi_inbox_messages g JOIN joi_turn_completions tc ON tc.input_id = g.input_id
 WHERE g.goal_input_id IS NULL AND g.status = 'CONSUMED'
   AND g.canceled_at IS NULL AND g.failed_at IS NULL AND g.dismissed_at IS NULL
   AND g.clarification_reason_code IS NULL
   AND tc.completed_at >= COALESCE(g.reopened_at, g.created_at)
   AND length(trim(tc.completion_summary)) > 0
   AND NOT EXISTS (SELECT 1 FROM joi_goal_result_sets rs WHERE rs.original_input_id = g.input_id AND rs.revision > 0)
   AND NOT EXISTS (SELECT 1 FROM joi_goal_execution_gates gate WHERE gate.goal_input_id = g.input_id AND gate.status <> 'OPEN')
   AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = g.input_id AND w.status NOT IN ('COMPLETED','FAILED','CANCELED'));

INSERT INTO joi_goal_result_history (result_id,goal_input_id,source_key,completed_at,status,body)
SELECT lower(hex(randomblob(16))),goal_input_id,source_key,completed_at,status,body FROM joi_final_result_candidates WHERE 1 ON CONFLICT(goal_input_id,source_key) DO NOTHING;

-- Publication can finish through a direct answer, a review, a recovered map, or an accepted
-- continuation. Triggers journal the same committed facts regardless of the lifecycle writer.
CREATE TRIGGER journal_goal_outcome_insert AFTER INSERT ON joi_goal_outcomes BEGIN
  INSERT INTO joi_goal_result_history (result_id,goal_input_id,source_key,completed_at,status,body)
  SELECT lower(hex(randomblob(16))),goal_input_id,source_key,completed_at,status,body FROM joi_final_result_candidates WHERE goal_input_id=NEW.input_id ON CONFLICT(goal_input_id,source_key) DO NOTHING;
END;
CREATE TRIGGER journal_goal_outcome_update AFTER UPDATE ON joi_goal_outcomes BEGIN
  INSERT INTO joi_goal_result_history (result_id,goal_input_id,source_key,completed_at,status,body)
  SELECT lower(hex(randomblob(16))),goal_input_id,source_key,completed_at,status,body FROM joi_final_result_candidates WHERE goal_input_id=NEW.input_id ON CONFLICT(goal_input_id,source_key) DO NOTHING;
END;
CREATE TRIGGER journal_turn_completion_insert AFTER INSERT ON joi_turn_completions BEGIN
  INSERT INTO joi_goal_result_history (result_id,goal_input_id,source_key,completed_at,status,body)
  SELECT lower(hex(randomblob(16))),goal_input_id,source_key,completed_at,status,body FROM joi_final_result_candidates WHERE goal_input_id=NEW.input_id ON CONFLICT(goal_input_id,source_key) DO NOTHING;
END;
CREATE TRIGGER journal_turn_completion_update AFTER UPDATE ON joi_turn_completions BEGIN
  INSERT INTO joi_goal_result_history (result_id,goal_input_id,source_key,completed_at,status,body)
  SELECT lower(hex(randomblob(16))),goal_input_id,source_key,completed_at,status,body FROM joi_final_result_candidates WHERE goal_input_id=NEW.input_id ON CONFLICT(goal_input_id,source_key) DO NOTHING;
END;
CREATE TRIGGER journal_goal_publication AFTER UPDATE ON joi_inbox_messages WHEN NEW.goal_input_id IS NULL BEGIN
  INSERT INTO joi_goal_result_history (result_id,goal_input_id,source_key,completed_at,status,body)
  SELECT lower(hex(randomblob(16))),goal_input_id,source_key,completed_at,status,body FROM joi_final_result_candidates WHERE goal_input_id=NEW.input_id ON CONFLICT(goal_input_id,source_key) DO NOTHING;
END;
CREATE TRIGGER journal_goal_map_closed AFTER UPDATE OF status ON joi_harness_maps WHEN NEW.status='CLEARED' BEGIN
  INSERT INTO joi_goal_result_history (result_id,goal_input_id,source_key,completed_at,status,body)
  SELECT lower(hex(randomblob(16))),goal_input_id,source_key,completed_at,status,body FROM joi_final_result_candidates WHERE goal_input_id=NEW.goal_input_id ON CONFLICT(goal_input_id,source_key) DO NOTHING;
END;
CREATE TRIGGER journal_goal_gate_open AFTER UPDATE OF status ON joi_goal_execution_gates WHEN NEW.status='OPEN' BEGIN
  INSERT INTO joi_goal_result_history (result_id,goal_input_id,source_key,completed_at,status,body)
  SELECT lower(hex(randomblob(16))),goal_input_id,source_key,completed_at,status,body FROM joi_final_result_candidates WHERE goal_input_id=NEW.goal_input_id ON CONFLICT(goal_input_id,source_key) DO NOTHING;
END;
CREATE TRIGGER immutable_goal_result_history BEFORE UPDATE ON joi_goal_result_history BEGIN
  SELECT RAISE(ABORT, 'goal_result_immutable');
END;
