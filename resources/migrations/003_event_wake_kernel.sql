ALTER TABLE lives ADD COLUMN protocol_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lives ADD COLUMN next_wake_at TEXT;
ALTER TABLE lives ADD COLUMN archived_at TEXT;

CREATE TABLE life_events (
  event_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human', 'runtime', 'schedule', 'agent', 'system')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
  occurred_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  dedupe_key TEXT,
  affair_id TEXT,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by_wake_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'CONSUMED', 'DEFERRED', 'DEAD_LETTER')),
  last_error_code TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_life_events_dedupe
  ON life_events(life_id, event_type, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX idx_life_events_available
  ON life_events(life_id, status, priority, available_at, occurred_at, event_id);

CREATE TABLE wakes (
  wake_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  persona_version_id TEXT NOT NULL REFERENCES persona_versions(persona_version_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('CREATED', 'RUNNING', 'COMPLETED', 'FAILED_PROTOCOL', 'CANCELED')),
  lease_owner TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  selected_event_count INTEGER NOT NULL,
  repair_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_wakes_one_active_life
  ON wakes(life_id) WHERE status IN ('CREATED', 'RUNNING');

CREATE TABLE wake_turns (
  turn_id TEXT PRIMARY KEY,
  wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE CASCADE,
  turn_number INTEGER NOT NULL,
  invocation_id TEXT REFERENCES invocations(invocation_id) ON DELETE SET NULL,
  message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (wake_id, turn_number)
);

CREATE TABLE runtime_injections (
  injection_id TEXT PRIMARY KEY,
  wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES wake_turns(turn_id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (turn_id, source_type, source_id)
);

CREATE TABLE flow_events (
  flow_event_id TEXT PRIMARY KEY,
  wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (wake_id, sequence)
);

CREATE TABLE life_actions (
  life_action_id TEXT PRIMARY KEY,
  wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  action_set_id TEXT NOT NULL,
  action_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (wake_id, action_id)
);

CREATE TABLE wake_action_sets (
  wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE CASCADE,
  action_set_id TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  continue_wake INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wake_id, action_set_id)
);

CREATE TABLE expressions (
  expression_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (wake_id, action_id)
);

CREATE TABLE consciousness_residue (
  life_id TEXT PRIMARY KEY REFERENCES lives(life_id) ON DELETE CASCADE,
  wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
