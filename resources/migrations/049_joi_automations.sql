ALTER TABLE joi_inbox_messages ADD COLUMN automation_routine_id TEXT;

CREATE TABLE IF NOT EXISTS joi_automations (
  routine_id TEXT PRIMARY KEY,
  create_idempotency_key TEXT UNIQUE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  frequency_json TEXT NOT NULL,
  workbench_id TEXT NOT NULL,
  preferred_partner_id TEXT,
  from_date TEXT,
  to_date TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  pending_trigger_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_joi_automations_due ON joi_automations(enabled, deleted_at, next_run_at);
CREATE INDEX IF NOT EXISTS idx_joi_automations_workbench ON joi_automations(workbench_id);

CREATE TABLE IF NOT EXISTS joi_automation_mutations (
  idempotency_key TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES joi_automations(routine_id),
  kind TEXT NOT NULL CHECK (kind IN ('UPDATE', 'DELETE')),
  committed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS joi_automation_runs (
  run_id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL REFERENCES joi_automations(routine_id),
  occurrence_at TEXT NOT NULL,
  input_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  triggered_at TEXT NOT NULL,
  queued_at TEXT,
  completed_at TEXT,
  merge_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELED')),
  result TEXT NOT NULL CHECK (result IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELED')),
  reason_code TEXT
);

CREATE INDEX IF NOT EXISTS idx_joi_automation_runs_routine ON joi_automation_runs(routine_id, occurrence_at DESC);
CREATE INDEX IF NOT EXISTS idx_joi_automation_runs_input ON joi_automation_runs(input_id);
