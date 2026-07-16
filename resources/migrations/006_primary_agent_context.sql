CREATE TABLE primary_agent_contexts (
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  affair_key TEXT NOT NULL,
  agent_connection_id TEXT NOT NULL REFERENCES agent_connections(agent_connection_id) ON DELETE CASCADE,
  context_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (life_id, affair_key)
);

CREATE INDEX idx_primary_agent_contexts_agent
  ON primary_agent_contexts(agent_connection_id, updated_at DESC);
