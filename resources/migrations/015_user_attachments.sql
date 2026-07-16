CREATE TABLE user_attachments (
  attachment_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  event_id TEXT REFERENCES life_events(event_id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_user_attachments_life_event
  ON user_attachments(life_id, event_id, created_at);
