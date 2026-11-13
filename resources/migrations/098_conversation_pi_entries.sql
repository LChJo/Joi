CREATE TABLE conversation_pi_entries (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  sequence INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  parent_id TEXT,
  entry_type TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, sequence),
  UNIQUE (conversation_id, entry_id)
);
