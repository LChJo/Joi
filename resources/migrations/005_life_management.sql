ALTER TABLE lives ADD COLUMN initial_goal TEXT;

CREATE TABLE primary_agent_handoffs (
  handoff_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  from_agent_connection_id TEXT NOT NULL REFERENCES agent_connections(agent_connection_id) ON DELETE RESTRICT,
  to_agent_connection_id TEXT NOT NULL REFERENCES agent_connections(agent_connection_id) ON DELETE RESTRICT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_primary_agent_handoffs_life
  ON primary_agent_handoffs(life_id, created_at DESC, handoff_id DESC);
