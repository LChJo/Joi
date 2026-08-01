CREATE TABLE mana_sdk_conversations (
  conversation_id TEXT PRIMARY KEY,
  project_key TEXT,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mana_sdk_conversations_project ON mana_sdk_conversations(project_key);

CREATE TABLE mana_sdk_transcript (
  conversation_id TEXT NOT NULL REFERENCES mana_sdk_conversations(conversation_id) ON DELETE CASCADE,
  entry_index INTEGER NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY (conversation_id, entry_index)
);
