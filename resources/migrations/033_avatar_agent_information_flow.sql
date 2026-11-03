-- User-facing Agent sessions are an additive presentation registry. Runtime status remains
-- authoritative in partner_instances / partner_runs; no pre-033 history is backfilled.
CREATE TABLE avatar_agent_sessions (
  agent_id TEXT PRIMARY KEY,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  partner_revision_id TEXT NOT NULL REFERENCES partner_revisions(partner_revision_id) ON DELETE RESTRICT,
  backing_kind TEXT NOT NULL CHECK (backing_kind IN ('LOCAL_INSTANCE', 'A2A_RUN')),
  backing_id TEXT NOT NULL,
  session_policy TEXT NOT NULL CHECK (session_policy IN ('EPHEMERAL', 'RESIDENT')),
  created_at TEXT NOT NULL,
  dismissed_at TEXT,
  UNIQUE (backing_kind, backing_id)
);
CREATE INDEX idx_avatar_agent_sessions_avatar_created
  ON avatar_agent_sessions(avatar_id, created_at DESC, agent_id DESC);

CREATE TABLE avatar_agent_conversation_entries (
  entry_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES avatar_agent_sessions(agent_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  role TEXT NOT NULL CHECK (role IN ('USER', 'AGENT', 'TOOL', 'SYSTEM')),
  kind TEXT NOT NULL CHECK (kind IN ('MARKDOWN', 'TOOL_CALL', 'TOOL_RESULT', 'ARTIFACT', 'ERROR')),
  text TEXT,
  tool_name TEXT,
  artifact_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, sequence)
);
CREATE INDEX idx_avatar_agent_entries_agent_sequence
  ON avatar_agent_conversation_entries(agent_id, sequence, entry_id);
