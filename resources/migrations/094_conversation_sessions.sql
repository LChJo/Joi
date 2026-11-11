CREATE TABLE conversation_execution_sessions (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(conversation_id),
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE conversation_execution_messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  message_json TEXT NOT NULL,
  PRIMARY KEY(conversation_id,sequence)
);
