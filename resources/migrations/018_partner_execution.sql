CREATE TABLE partner_prompts (
  prompt_ref TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE partner_runs (
  run_id TEXT PRIMARY KEY,
  dispatch_attempt_id TEXT NOT NULL UNIQUE REFERENCES dispatch_attempts(dispatch_attempt_id) ON DELETE RESTRICT,
  action_id TEXT NOT NULL UNIQUE,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  partner_revision_id TEXT NOT NULL REFERENCES partner_revisions(partner_revision_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('LOCAL_PI', 'A2A')),
  external_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_partner_runs_avatar_status ON partner_runs(avatar_id, status, created_at);

CREATE TABLE partner_result_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES partner_runs(run_id) ON DELETE RESTRICT,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  partner_revision_id TEXT NOT NULL REFERENCES partner_revisions(partner_revision_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')),
  input_id TEXT UNIQUE REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, status)
);
CREATE INDEX idx_partner_results_unconsumed ON partner_result_events(consumed_at, created_at, event_id);

CREATE TABLE joi_attachments (
  attachment_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE joi_inbox_attachments (
  input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES joi_attachments(attachment_id) ON DELETE RESTRICT,
  PRIMARY KEY (input_id, attachment_id)
);

CREATE TRIGGER mirror_new_agent_connection_as_partner
AFTER INSERT ON agent_connections
BEGIN
  UPDATE partner_registry_state SET registry_revision = registry_revision + 1, updated_at = NEW.updated_at WHERE singleton_id = 1;
  INSERT OR IGNORE INTO partners
    (partner_id, legacy_agent_connection_id, kind, status, active_revision_id, created_at, updated_at)
  VALUES ('partner_' || NEW.agent_connection_id, NEW.agent_connection_id, 'A2A',
    CASE WHEN NEW.status = 'DISABLED' THEN 'DISABLED' ELSE 'ACTIVE' END,
    NULL, NEW.created_at, NEW.updated_at);
  INSERT INTO partner_revisions
    (partner_revision_id, partner_id, registry_revision, display_name, capabilities_json, skills_json,
     tools_json, execution_policy_json, provenance_json, created_at)
  VALUES (
    'partner_revision_' || NEW.agent_connection_id || '_' || (SELECT registry_revision FROM partner_registry_state WHERE singleton_id = 1),
    'partner_' || NEW.agent_connection_id,
    (SELECT registry_revision FROM partner_registry_state WHERE singleton_id = 1),
    NEW.name, COALESCE(NEW.skills_json, '[]'), COALESCE(NEW.skills_json, '[]'), '[]',
    '{"transport":"a2a","localOverridesWin":true}',
    '{"displayName":"card","capabilities":"card","skills":"card","tools":"local","workspace":"local"}',
    NEW.updated_at
  );
  UPDATE partners SET active_revision_id = (
    SELECT partner_revision_id FROM partner_revisions WHERE partner_id = 'partner_' || NEW.agent_connection_id ORDER BY registry_revision DESC LIMIT 1
  ) WHERE partner_id = 'partner_' || NEW.agent_connection_id;
END;

CREATE TRIGGER mirror_agent_connection_update_as_partner_revision
AFTER UPDATE OF name, status, skills_json ON agent_connections
WHEN NEW.name <> OLD.name OR NEW.status <> OLD.status OR COALESCE(NEW.skills_json, '[]') <> COALESCE(OLD.skills_json, '[]')
BEGIN
  UPDATE partner_registry_state SET registry_revision = registry_revision + 1, updated_at = NEW.updated_at WHERE singleton_id = 1;
  UPDATE partners SET status = CASE WHEN NEW.status = 'DISABLED' THEN 'DISABLED' ELSE 'ACTIVE' END, updated_at = NEW.updated_at
    WHERE legacy_agent_connection_id = NEW.agent_connection_id;
  INSERT INTO partner_revisions
    (partner_revision_id, partner_id, registry_revision, display_name, capabilities_json, skills_json,
     tools_json, execution_policy_json, provenance_json, created_at)
  SELECT
    'partner_revision_' || NEW.agent_connection_id || '_' || (SELECT registry_revision FROM partner_registry_state WHERE singleton_id = 1),
    partner_id, (SELECT registry_revision FROM partner_registry_state WHERE singleton_id = 1),
    NEW.name, COALESCE(NEW.skills_json, '[]'), COALESCE(NEW.skills_json, '[]'), '[]',
    '{"transport":"a2a","localOverridesWin":true}',
    '{"displayName":"card","capabilities":"card","skills":"card","tools":"local","workspace":"local"}',
    NEW.updated_at
    FROM partners WHERE legacy_agent_connection_id = NEW.agent_connection_id;
  UPDATE partners SET active_revision_id = (
    SELECT partner_revision_id FROM partner_revisions WHERE partner_id = partners.partner_id ORDER BY registry_revision DESC LIMIT 1
  ) WHERE legacy_agent_connection_id = NEW.agent_connection_id;
END;
