CREATE TABLE joi_session_archived_messages (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
