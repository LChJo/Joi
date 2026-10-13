-- joi:migration foreign-keys-off
CREATE TABLE partner_instances_v073 (
  instance_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  partner_revision_id TEXT NOT NULL REFERENCES partner_revisions(partner_revision_id) ON DELETE RESTRICT,
  session_policy TEXT NOT NULL CHECK (session_policy IN ('EPHEMERAL', 'RESIDENT')),
  status TEXT NOT NULL CHECK (status IN ('IDLE', 'BUSY', 'SUSPENDED', 'DISPOSED')),
  engine TEXT NOT NULL DEFAULT 'PI_CORE' CHECK (engine IN ('PI_CORE', 'MANA_SDK')),
  external_session_ref TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  disposed_at TEXT,
  disposal_reason TEXT,
  workbench_id TEXT REFERENCES workbenches(workbench_id) ON DELETE RESTRICT,
  cli_protocol TEXT CHECK (cli_protocol IS NULL OR cli_protocol IN ('CLAUDE', 'CODEX'))
);
INSERT INTO partner_instances_v073 SELECT instance_id, partner_id, partner_revision_id, session_policy,
  status, engine, external_session_ref, created_at, last_used_at, disposed_at, disposal_reason, workbench_id, cli_protocol FROM partner_instances;
DROP TABLE partner_instances;
ALTER TABLE partner_instances_v073 RENAME TO partner_instances;
CREATE INDEX idx_partner_instances_partner ON partner_instances(partner_id, status);
CREATE INDEX idx_partner_instances_workbench_partner ON partner_instances(workbench_id, partner_id, status);

ALTER TABLE dispatch_attempts ADD COLUMN scheduling_version INTEGER NOT NULL DEFAULT 2 CHECK (scheduling_version IN (1, 2));
UPDATE dispatch_attempts SET scheduling_version = 1 WHERE EXISTS (
  SELECT 1 FROM partner_runs r WHERE r.dispatch_attempt_id = dispatch_attempts.dispatch_attempt_id
);
CREATE TABLE local_work_execution (
  dispatch_attempt_id TEXT PRIMARY KEY REFERENCES dispatch_attempts(dispatch_attempt_id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK (phase IN ('READ_QUEUED','READ_RUNNING','WRITE_QUEUED','WRITE_RUNNING')),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  checkpoint_ref TEXT,
  wait_reason TEXT,
  staged_attachments_json TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE workspace_write_waiters (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL UNIQUE,
  workspace_ref TEXT NOT NULL,
  root_key TEXT NOT NULL,
  generation INTEGER NOT NULL
);
CREATE INDEX idx_workspace_write_waiters_root ON workspace_write_waiters(root_key, sequence);
ALTER TABLE workspace_leases ADD COLUMN root_key TEXT;
CREATE TABLE workspace_lease_generations (work_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
INSERT INTO workspace_lease_generations SELECT work_id, MAX(generation) FROM workspace_leases GROUP BY work_id;
