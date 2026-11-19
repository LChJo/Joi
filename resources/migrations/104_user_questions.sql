CREATE TABLE user_questions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL UNIQUE,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('GOAL','CONVERSATION')),
  scope_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  parent_turn_id TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('QUEUED','ACTIVE','ANSWERED','CANCELED','SUPERSEDED')),
  expires_at TEXT,
  delivery TEXT NOT NULL CHECK(delivery IN ('PENDING','DELIVERED','INTERRUPTED')),
  payload_json TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_user_questions_active ON user_questions(scope_kind,scope_id) WHERE status='ACTIVE';
CREATE INDEX idx_user_questions_scope ON user_questions(scope_kind,scope_id,sequence);
CREATE INDEX idx_user_questions_due ON user_questions(expires_at) WHERE status='ACTIVE';
CREATE INDEX idx_user_questions_owner ON user_questions(owner_id,status);
CREATE INDEX idx_user_questions_parent ON user_questions(scope_kind,scope_id,parent_turn_id,sequence);

CREATE TRIGGER conversation_question_inserted AFTER INSERT ON user_questions
WHEN NEW.scope_kind = 'CONVERSATION' BEGIN
  INSERT INTO conversation_changes(conversation_id,turn_id)
  SELECT conversation_id,turn_id FROM conversation_turns
  WHERE conversation_id = NEW.scope_id AND turn_id = NEW.parent_turn_id;
END;
CREATE TRIGGER conversation_question_changed AFTER UPDATE ON user_questions
WHEN NEW.scope_kind = 'CONVERSATION' AND (
  OLD.status IS NOT NEW.status OR OLD.delivery IS NOT NEW.delivery OR OLD.version IS NOT NEW.version
  OR OLD.expires_at IS NOT NEW.expires_at OR OLD.payload_json IS NOT NEW.payload_json
) BEGIN
  INSERT INTO conversation_changes(conversation_id,turn_id)
  SELECT conversation_id,turn_id FROM conversation_turns
  WHERE conversation_id = NEW.scope_id AND turn_id = NEW.parent_turn_id;
END;

ALTER TABLE conversation_turns ADD COLUMN question_recovery_context TEXT;
