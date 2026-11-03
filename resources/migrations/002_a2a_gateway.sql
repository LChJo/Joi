ALTER TABLE agent_connections ADD COLUMN description TEXT;
ALTER TABLE agent_connections ADD COLUMN skills_json TEXT;
ALTER TABLE agent_connections ADD COLUMN readiness INTEGER;
ALTER TABLE agent_connections ADD COLUMN card_url_hash TEXT;
ALTER TABLE agent_connections ADD COLUMN credential_id TEXT;
ALTER TABLE agent_connections ADD COLUMN credential_version INTEGER;
ALTER TABLE agent_connections ADD COLUMN card_snapshot_id TEXT;
ALTER TABLE agent_connections ADD COLUMN origin_hash TEXT;
ALTER TABLE agent_connections ADD COLUMN last_validated_at TEXT;

CREATE UNIQUE INDEX idx_agent_connections_card_url_hash
  ON agent_connections(card_url_hash) WHERE card_url_hash IS NOT NULL;

CREATE TABLE agent_credentials (
  credential_id TEXT PRIMARY KEY,
  encrypted_blob BLOB NOT NULL,
  credential_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_card_snapshots (
  card_snapshot_id TEXT PRIMARY KEY,
  agent_connection_id TEXT NOT NULL REFERENCES agent_connections(agent_connection_id) ON DELETE CASCADE,
  card_url TEXT NOT NULL,
  card_url_hash TEXT NOT NULL,
  card_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  rpc_url TEXT NOT NULL,
  origin TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('JSONRPC', 'REST')),
  authentication TEXT NOT NULL CHECK (authentication = 'bearer'),
  streaming INTEGER NOT NULL,
  skills_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_agent_card_snapshots_connection
  ON agent_card_snapshots(agent_connection_id, created_at DESC);

CREATE TABLE connection_breakers (
  breaker_key TEXT PRIMARY KEY,
  open_until TEXT NOT NULL,
  last_status INTEGER NOT NULL CHECK (last_status IN (429, 503)),
  updated_at TEXT NOT NULL
);

CREATE TABLE invocations (
  invocation_id TEXT PRIMARY KEY,
  agent_connection_id TEXT NOT NULL REFERENCES agent_connections(agent_connection_id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  task_id TEXT,
  context_id TEXT,
  status TEXT NOT NULL,
  send_attempts INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE interactions (
  interaction_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES invocations(invocation_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('input-required', 'auth-required')),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RESOLVED', 'STALE')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES invocations(invocation_id) ON DELETE CASCADE,
  remote_artifact_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  relative_path TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (invocation_id, remote_artifact_id)
);
