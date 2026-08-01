CREATE TABLE partner_instances (
  instance_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  partner_revision_id TEXT NOT NULL REFERENCES partner_revisions(partner_revision_id) ON DELETE RESTRICT,
  session_policy TEXT NOT NULL CHECK (session_policy IN ('EPHEMERAL', 'RESIDENT')),
  status TEXT NOT NULL CHECK (status IN ('IDLE', 'BUSY', 'DISPOSED')),
  engine TEXT NOT NULL DEFAULT 'PI_CORE' CHECK (engine IN ('PI_CORE', 'MANA_SDK')),
  external_session_ref TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  disposed_at TEXT,
  disposal_reason TEXT
);
CREATE INDEX idx_partner_instances_partner ON partner_instances(partner_id, status);

CREATE TABLE partner_instance_messages (
  message_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES partner_instances(instance_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (instance_id, sequence)
);

ALTER TABLE dispatch_attempts ADD COLUMN instance_id TEXT
  REFERENCES partner_instances(instance_id) ON DELETE RESTRICT;

CREATE TABLE partner_work_memories (
  memory_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  work_id TEXT REFERENCES work_items(work_id) ON DELETE SET NULL,
  session_data_source TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_partner_work_memories_partner ON partner_work_memories(partner_id, created_at);

CREATE TABLE partner_work_memory_summaries (
  partner_id TEXT PRIMARY KEY REFERENCES partners(partner_id) ON DELETE RESTRICT,
  summary TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
