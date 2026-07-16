CREATE TABLE agent_connections (
  agent_connection_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  card_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COLLABORATOR_ONLY', 'DISABLED', 'DRAFT', 'ERROR', 'RECONFIRM_REQUIRED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE lives (
  life_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT,
  timezone TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('BUDGET_PAUSED', 'DEGRADED', 'PAUSED', 'QUEUED', 'RUNNING', 'SLEEPING', 'STOPPED', 'WAITING_USER')),
  main_agent_connection_id TEXT NOT NULL REFERENCES agent_connections(agent_connection_id) ON DELETE RESTRICT,
  current_persona_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE persona_versions (
  persona_version_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  principles_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sse_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sse_events_created_at ON sse_events(created_at);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL REFERENCES sse_events(sequence) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE outbox (
  outbox_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'DONE')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  claim_owner TEXT,
  claim_until TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_outbox_claim ON outbox(status, available_at, claim_until);

CREATE TABLE runtime_leases (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (resource_type, resource_id)
);

CREATE TABLE admin_credentials (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'scrypt'),
  salt TEXT NOT NULL,
  derived_key TEXT NOT NULL,
  cost INTEGER NOT NULL,
  block_size INTEGER NOT NULL,
  parallelization INTEGER NOT NULL,
  key_length INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE web_sessions (
  session_hash TEXT PRIMARY KEY,
  csrf_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desktop', 'lan')),
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_web_sessions_expiry ON web_sessions(idle_expires_at, absolute_expires_at);

CREATE TABLE backup_history (
  backup_id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
