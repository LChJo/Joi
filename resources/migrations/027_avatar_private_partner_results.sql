-- Avatar is the only workspace authority. Legacy partner_revisions.workspace_ref
-- and work_items.workspace_ref remain audit-only and are never read by runtime 027+.
CREATE TABLE avatar_workspace_bindings (
  avatar_id TEXT PRIMARY KEY REFERENCES avatars(avatar_id) ON DELETE CASCADE,
  workspace_ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('MANAGED', 'BOUND')),
  status TEXT NOT NULL CHECK (status IN ('PROVISIONING', 'READY', 'FAILED')),
  display_name TEXT NOT NULL,
  failure_reason_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE avatar_persona_revisions (
  persona_revision_id TEXT PRIMARY KEY,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO avatar_persona_revisions (persona_revision_id, avatar_id, body, created_at)
SELECT persona_revision_id, avatar_id, persona_summary, created_at FROM avatars;

-- Private infrastructure mapping. root_path must never be selected into DTOs,
-- diagnostics, SSE events or outbox payloads.
CREATE TABLE avatar_workspace_roots (
  workspace_ref TEXT PRIMARY KEY REFERENCES avatar_workspace_bindings(workspace_ref) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE avatar_task_projections (
  avatar_id TEXT PRIMARY KEY REFERENCES avatars(avatar_id) ON DELETE CASCADE,
  active_work_json TEXT NOT NULL DEFAULT '[]',
  recent_results_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE avatar_context_snapshots (
  context_snapshot_id TEXT PRIMARY KEY,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  persona_revision_id TEXT NOT NULL,
  workspace_ref TEXT REFERENCES avatar_workspace_bindings(workspace_ref) ON DELETE RESTRICT,
  safe_context_json TEXT NOT NULL,
  memory_summary_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_avatar_context_snapshots_work ON avatar_context_snapshots(avatar_id, work_id, created_at DESC);

ALTER TABLE partner_runs ADD COLUMN context_snapshot_id TEXT
  REFERENCES avatar_context_snapshots(context_snapshot_id) ON DELETE RESTRICT;

CREATE TABLE work_access_policies (
  work_id TEXT PRIMARY KEY REFERENCES work_items(work_id) ON DELETE CASCADE,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('NONE', 'READ', 'WRITE'))
);

INSERT INTO work_access_policies (work_id, access_mode)
SELECT work_id, access_mode FROM work_items;

ALTER TABLE partner_instances ADD COLUMN avatar_id TEXT REFERENCES avatars(avatar_id) ON DELETE RESTRICT;
CREATE INDEX idx_partner_instances_avatar_partner ON partner_instances(avatar_id, partner_id, status);

CREATE TABLE avatar_partner_work_memories (
  memory_id TEXT PRIMARY KEY,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  work_id TEXT REFERENCES work_items(work_id) ON DELETE SET NULL,
  session_data_source TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_avatar_partner_work_memories_scope
  ON avatar_partner_work_memories(avatar_id, partner_id, created_at DESC);

CREATE TABLE avatar_partner_work_memory_summaries (
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  summary TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (avatar_id, partner_id)
);

CREATE TABLE work_result_bodies (
  body_ref TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE work_results (
  result_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES partner_runs(run_id) ON DELETE RESTRICT,
  action_id TEXT NOT NULL,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  partner_revision_id TEXT NOT NULL REFERENCES partner_revisions(partner_revision_id) ON DELETE RESTRICT,
  instance_id TEXT REFERENCES partner_instances(instance_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')),
  summary TEXT NOT NULL,
  body_ref TEXT NOT NULL REFERENCES work_result_bodies(body_ref) ON DELETE RESTRICT,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  is_late INTEGER NOT NULL DEFAULT 0 CHECK (is_late IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, status)
);
CREATE INDEX idx_work_results_avatar_created ON work_results(avatar_id, created_at DESC, result_id DESC);

-- Existing active work/runtime facts cannot satisfy Avatar-private invariants.
-- Preserve them as terminal audit facts and make remote cancellation retryable.
INSERT OR IGNORE INTO outbox
  (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
SELECT 'partner_cancel_027:' || pr.run_id,
       'partner.cancel',
       json_object('runId', pr.run_id, 'actionId', pr.action_id),
       'PENDING', 0, pr.updated_at, pr.updated_at
  FROM partner_runs pr
 WHERE pr.kind = 'A2A'
   AND pr.status IN ('RUNNING', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN');

UPDATE work_items
   SET status = 'CANCELED'
 WHERE status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING');
UPDATE dispatch_attempts
   SET status = 'FAILED'
 WHERE status IN ('PENDING', 'DISPATCHED', 'ACCEPTED', 'RUNNING', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN');
UPDATE partner_runs
   SET status = 'FAILED'
 WHERE status IN ('RUNNING', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN');
UPDATE partner_instances
   SET status = 'DISPOSED', disposal_reason = 'upgrade_027',
       disposed_at = COALESCE(disposed_at, last_used_at)
 WHERE status <> 'DISPOSED';

INSERT INTO avatar_workspace_bindings
  (avatar_id, workspace_ref, kind, status, display_name, created_at, updated_at)
SELECT avatar_id, 'avatar_workspace:' || avatar_id, 'MANAGED', 'PROVISIONING',
       name || ' 工作区', created_at, updated_at
  FROM avatars WHERE status = 'ACTIVE';

INSERT INTO avatar_task_projections (avatar_id, active_work_json, recent_results_json, updated_at)
SELECT avatar_id, '[]', '[]', updated_at FROM avatars WHERE status = 'ACTIVE';

INSERT OR IGNORE INTO outbox
  (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
SELECT 'avatar_workspace_provision:' || avatar_id,
       'avatar.workspace.provision',
       json_object('avatarId', avatar_id, 'workspaceRef', workspace_ref),
       'PENDING', 0, updated_at, created_at
  FROM avatar_workspace_bindings;

-- Both native Avatar creation and the legacy Life mirror must establish the
-- same private context invariants. All identifiers in this trigger are stable,
-- so replaying the surrounding command cannot enqueue duplicate side effects.
CREATE TRIGGER initialize_new_avatar_private_context
AFTER INSERT ON avatars
WHEN NEW.status = 'ACTIVE'
BEGIN
  INSERT OR IGNORE INTO avatar_persona_revisions
    (persona_revision_id, avatar_id, body, created_at)
  VALUES (NEW.persona_revision_id, NEW.avatar_id, NEW.persona_summary, NEW.created_at);

  INSERT OR IGNORE INTO avatar_workspace_bindings
    (avatar_id, workspace_ref, kind, status, display_name, created_at, updated_at)
  VALUES (NEW.avatar_id, 'avatar_workspace:' || NEW.avatar_id, 'MANAGED', 'PROVISIONING',
          NEW.name || ' 工作区', NEW.created_at, NEW.updated_at);

  INSERT OR IGNORE INTO avatar_task_projections
    (avatar_id, active_work_json, recent_results_json, updated_at)
  VALUES (NEW.avatar_id, '[]', '[]', NEW.updated_at);

  INSERT OR IGNORE INTO outbox
    (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
  VALUES ('avatar_workspace_provision:' || NEW.avatar_id,
          'avatar.workspace.provision',
          json_object('avatarId', NEW.avatar_id, 'workspaceRef', 'avatar_workspace:' || NEW.avatar_id),
          'PENDING', 0, NEW.updated_at, NEW.created_at);
END;
