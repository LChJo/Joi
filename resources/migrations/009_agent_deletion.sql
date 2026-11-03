ALTER TABLE agent_connections ADD COLUMN deleted_at TEXT;

CREATE INDEX idx_agent_connections_visible
  ON agent_connections(deleted_at, updated_at DESC);
