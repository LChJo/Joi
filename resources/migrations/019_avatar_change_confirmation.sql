CREATE TABLE avatar_change_requests (
  request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ARCHIVE', 'MERGE')),
  source_avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  target_avatar_id TEXT REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  CHECK ((kind = 'ARCHIVE' AND target_avatar_id IS NULL) OR
         (kind = 'MERGE' AND target_avatar_id IS NOT NULL AND source_avatar_id <> target_avatar_id))
);
CREATE INDEX idx_avatar_change_pending ON avatar_change_requests(status, created_at, request_id);

CREATE TABLE avatar_merges (
  request_id TEXT PRIMARY KEY REFERENCES avatar_change_requests(request_id) ON DELETE RESTRICT,
  source_avatar_id TEXT NOT NULL UNIQUE REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  target_avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (source_avatar_id <> target_avatar_id)
);
