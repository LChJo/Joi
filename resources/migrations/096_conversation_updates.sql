ALTER TABLE conversations ADD COLUMN context_json TEXT;
CREATE TABLE conversation_changes (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
 turn_id TEXT
);
CREATE INDEX conversation_changes_cursor ON conversation_changes(conversation_id,sequence);
CREATE TRIGGER conversation_turn_inserted AFTER INSERT ON conversation_turns BEGIN
 INSERT INTO conversation_changes(conversation_id,turn_id) VALUES (NEW.conversation_id,NEW.turn_id);
END;
CREATE TRIGGER conversation_turn_changed AFTER UPDATE ON conversation_turns BEGIN
 INSERT INTO conversation_changes(conversation_id,turn_id) VALUES (NEW.conversation_id,NEW.turn_id);
END;
CREATE TRIGGER conversation_context_changed AFTER UPDATE OF context_json ON conversations BEGIN
 INSERT INTO conversation_changes(conversation_id,turn_id) VALUES (NEW.conversation_id,NULL);
END;
CREATE TRIGGER conversation_child_changed AFTER UPDATE ON conversation_subagents BEGIN
 INSERT INTO conversation_changes(conversation_id,turn_id)
 SELECT conversation_id,turn_id FROM conversation_turns WHERE turn_id=NEW.parent_turn_id;
END;
