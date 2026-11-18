CREATE TABLE conversation_forks (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(conversation_id),
  source_conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  source_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id),
  config_json TEXT NOT NULL,
  handoff_json TEXT NOT NULL
);

ALTER TABLE conversation_turn_segments ADD COLUMN message_count INTEGER;
