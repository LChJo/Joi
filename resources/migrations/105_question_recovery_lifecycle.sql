DROP INDEX idx_user_questions_active;
CREATE UNIQUE INDEX idx_user_questions_active ON user_questions(scope_kind,scope_id)
  WHERE status='ACTIVE' AND delivery='PENDING';
DROP INDEX idx_user_questions_due;
CREATE INDEX idx_user_questions_due ON user_questions(expires_at)
  WHERE status='ACTIVE' AND delivery='PENDING';

ALTER TABLE conversation_turns ADD COLUMN question_recovery_source_turn_id TEXT
  REFERENCES conversation_turns(turn_id);

UPDATE conversation_turns AS recovery
SET question_recovery_source_turn_id = (
  SELECT source.turn_id FROM conversation_turns source
  WHERE source.conversation_id = recovery.conversation_id
    AND source.turn_id = substr(recovery.request_id, length('question_resume_') + 1)
)
WHERE recovery.question_recovery_context IS NOT NULL
  AND substr(recovery.request_id, 1, length('question_resume_')) = 'question_resume_';

CREATE INDEX idx_conversation_question_recovery_source ON conversation_turns(question_recovery_source_turn_id)
  WHERE question_recovery_source_turn_id IS NOT NULL;
