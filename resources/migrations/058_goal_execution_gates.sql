CREATE TABLE joi_goal_execution_gates (
  goal_input_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id) ON DELETE CASCADE,
  question_id TEXT NOT NULL UNIQUE,
  question_version INTEGER NOT NULL CHECK(question_version > 0),
  status TEXT NOT NULL CHECK(status IN ('WAITING_INPUT', 'REVIEWING', 'OPEN')),
  reason_code TEXT NOT NULL,
  resume_input_id TEXT REFERENCES joi_inbox_messages(input_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_goal_execution_gates_status
  ON joi_goal_execution_gates(status, updated_at, goal_input_id);

-- Older builds could attach the question to a derived synthesis/review input.
-- Move the visible question back to its original goal before creating the gate;
-- derived rows are internal and must not become a second user-facing question.
UPDATE joi_inbox_messages AS goal
   SET status = 'CLARIFICATION_REQUIRED',
       clarification_reason_code = (SELECT source.clarification_reason_code
         FROM joi_inbox_messages source
        WHERE source.goal_input_id = goal.input_id
          AND source.status = 'CLARIFICATION_REQUIRED'
          AND source.clarification_reason_code IS NOT NULL
        ORDER BY source.updated_at DESC, source.input_id DESC LIMIT 1),
       clarification_prompt = (SELECT source.clarification_prompt
         FROM joi_inbox_messages source
        WHERE source.goal_input_id = goal.input_id
          AND source.status = 'CLARIFICATION_REQUIRED'
          AND source.clarification_reason_code IS NOT NULL
        ORDER BY source.updated_at DESC, source.input_id DESC LIMIT 1),
       updated_at = (SELECT source.updated_at
         FROM joi_inbox_messages source
        WHERE source.goal_input_id = goal.input_id
          AND source.status = 'CLARIFICATION_REQUIRED'
          AND source.clarification_reason_code IS NOT NULL
        ORDER BY source.updated_at DESC, source.input_id DESC LIMIT 1)
 WHERE goal.dismissed_at IS NULL AND goal.canceled_at IS NULL AND goal.failed_at IS NULL
   AND EXISTS (SELECT 1 FROM joi_inbox_messages source
     WHERE source.goal_input_id = goal.input_id
       AND source.status = 'CLARIFICATION_REQUIRED'
       AND source.clarification_reason_code IS NOT NULL);

INSERT OR IGNORE INTO joi_goal_execution_gates
  (goal_input_id, question_id, question_version, status, reason_code, created_at, updated_at)
SELECT COALESCE(i.goal_input_id, i.input_id),
       'goal_question:' || COALESCE(i.goal_input_id, i.input_id) || ':v1',
       1,
       'WAITING_INPUT',
       i.clarification_reason_code,
       i.updated_at,
       i.updated_at
  FROM joi_inbox_messages i
 WHERE i.status = 'CLARIFICATION_REQUIRED'
   AND i.clarification_reason_code IS NOT NULL
 ORDER BY i.updated_at, i.input_id;

UPDATE joi_inbox_messages
   SET status = 'CONSUMED', clarification_reason_code = NULL, clarification_prompt = NULL
 WHERE goal_input_id IS NOT NULL AND status = 'CLARIFICATION_REQUIRED'
   AND EXISTS (SELECT 1 FROM joi_goal_execution_gates gate
     WHERE gate.goal_input_id = joi_inbox_messages.goal_input_id);
