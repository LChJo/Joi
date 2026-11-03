CREATE TABLE partner_registry_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  registry_revision INTEGER NOT NULL CHECK (registry_revision >= 0),
  updated_at TEXT NOT NULL
);
INSERT INTO partner_registry_state (singleton_id, registry_revision, updated_at)
VALUES (1, 0, '1970-01-01T00:00:00.000Z');

CREATE TABLE partners (
  partner_id TEXT PRIMARY KEY,
  legacy_agent_connection_id TEXT UNIQUE REFERENCES agent_connections(agent_connection_id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('LOCAL_PI', 'A2A')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETED')),
  active_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE partner_revisions (
  partner_revision_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  registry_revision INTEGER NOT NULL UNIQUE CHECK (registry_revision > 0),
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  prompt_ref TEXT,
  prompt_hash TEXT,
  workspace_ref TEXT,
  execution_policy_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_partner_revisions_partner ON partner_revisions(partner_id, registry_revision DESC);

INSERT INTO partners
  (partner_id, legacy_agent_connection_id, kind, status, created_at, updated_at)
SELECT 'partner_' || agent_connection_id, agent_connection_id, 'A2A',
       CASE WHEN status = 'DISABLED' THEN 'DISABLED' ELSE 'ACTIVE' END,
       created_at, updated_at
  FROM agent_connections
 WHERE deleted_at IS NULL;

INSERT INTO partner_revisions
  (partner_revision_id, partner_id, registry_revision, display_name, capabilities_json, skills_json,
   tools_json, execution_policy_json, provenance_json, created_at)
SELECT 'partner_revision_' || agent_connection_id,
       'partner_' || agent_connection_id,
       ROW_NUMBER() OVER (ORDER BY created_at, agent_connection_id),
       name,
       COALESCE(skills_json, '[]'),
       COALESCE(skills_json, '[]'),
       '[]',
       '{"transport":"a2a","localOverridesWin":true}',
       '{"displayName":"card","capabilities":"card","skills":"card","tools":"local","workspace":"local"}',
       created_at
  FROM agent_connections
 WHERE deleted_at IS NULL;

UPDATE partners
   SET active_revision_id = 'partner_revision_' || legacy_agent_connection_id
 WHERE legacy_agent_connection_id IS NOT NULL;
UPDATE partner_registry_state
   SET registry_revision = (SELECT COUNT(*) FROM partner_revisions),
       updated_at = COALESCE((SELECT MAX(created_at) FROM partner_revisions), updated_at)
 WHERE singleton_id = 1;

CREATE TABLE avatars (
  avatar_id TEXT PRIMARY KEY,
  legacy_life_id TEXT UNIQUE REFERENCES lives(life_id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  persona_revision_id TEXT NOT NULL,
  persona_summary TEXT NOT NULL,
  scope_summary TEXT NOT NULL,
  project_label TEXT NOT NULL,
  workspace_ref TEXT,
  memory_namespace_id TEXT NOT NULL UNIQUE,
  task_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO avatars
  (avatar_id, legacy_life_id, name, persona_revision_id, persona_summary, scope_summary,
   project_label, memory_namespace_id, status, created_at, updated_at)
SELECT l.life_id, l.life_id, l.name, l.current_persona_version_id,
       COALESCE((SELECT p.summary FROM persona_versions p WHERE p.persona_version_id = l.current_persona_version_id), ''),
       l.name, l.name, 'memory_' || l.life_id,
       CASE WHEN l.archived_at IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END,
       l.created_at, l.updated_at
  FROM lives l;

CREATE TRIGGER mirror_new_life_as_avatar
AFTER INSERT ON lives
BEGIN
  INSERT OR IGNORE INTO avatars
    (avatar_id, legacy_life_id, name, persona_revision_id, persona_summary, scope_summary,
     project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
  VALUES (
    NEW.life_id, NEW.life_id, NEW.name, NEW.current_persona_version_id,
    COALESCE((SELECT summary FROM persona_versions WHERE persona_version_id = NEW.current_persona_version_id), ''),
    NEW.name, NEW.name, 'memory_' || NEW.life_id, '',
    CASE WHEN NEW.archived_at IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END,
    NEW.created_at, NEW.updated_at
  );
END;

CREATE TRIGGER mirror_life_update_to_avatar
AFTER UPDATE OF name, current_persona_version_id, archived_at, updated_at ON lives
BEGIN
  INSERT OR IGNORE INTO avatars
    (avatar_id, legacy_life_id, name, persona_revision_id, persona_summary, scope_summary,
     project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
  SELECT NEW.life_id, NEW.life_id, NEW.name, NEW.current_persona_version_id,
         COALESCE((SELECT summary FROM persona_versions WHERE persona_version_id = NEW.current_persona_version_id), ''),
         NEW.name, NEW.name, 'memory_' || NEW.life_id, '',
         CASE WHEN NEW.archived_at IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END,
         NEW.created_at, NEW.updated_at
   WHERE NEW.current_persona_version_id IS NOT NULL;
  UPDATE avatars
     SET name = NEW.name,
         persona_revision_id = NEW.current_persona_version_id,
         persona_summary = COALESCE((SELECT summary FROM persona_versions WHERE persona_version_id = NEW.current_persona_version_id), persona_summary),
         scope_summary = CASE WHEN scope_summary = OLD.name THEN NEW.name ELSE scope_summary END,
         project_label = CASE WHEN project_label = OLD.name THEN NEW.name ELSE project_label END,
         status = CASE WHEN NEW.archived_at IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END,
         updated_at = NEW.updated_at
   WHERE legacy_life_id = NEW.life_id;
END;

CREATE TABLE avatar_partner_policies (
  avatar_id TEXT PRIMARY KEY REFERENCES avatars(avatar_id) ON DELETE CASCADE,
  preferred_partner_id TEXT REFERENCES partners(partner_id) ON DELETE SET NULL,
  allowlist_json TEXT NOT NULL DEFAULT '[]',
  policy_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

INSERT INTO avatar_partner_policies (avatar_id, preferred_partner_id, allowlist_json, updated_at)
SELECT l.life_id, 'partner_' || l.main_agent_connection_id,
       json_array('partner_' || l.main_agent_connection_id), l.updated_at
  FROM lives l;

CREATE TABLE model_sources (
  source_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'VALIDATING', 'READY', 'DEGRADED', 'NEEDS_AUTH', 'DISABLED')),
  active_source_revision_id TEXT,
  active_model_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_source_credentials (
  provider_id TEXT PRIMARY KEY,
  credential_type TEXT NOT NULL CHECK (credential_type IN ('api_key', 'oauth')),
  encrypted_blob BLOB NOT NULL,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE model_source_revisions (
  source_revision_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES model_sources(source_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('kimi', 'glm', 'qwen', 'doubao', 'minimax', 'deepseek', 'generic-openai')),
  display_name TEXT NOT NULL,
  base_url TEXT,
  credential_ref TEXT NOT NULL REFERENCES model_source_credentials(provider_id) ON DELETE RESTRICT,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_model_source_revisions_source ON model_source_revisions(source_id, created_at DESC);

CREATE TABLE model_source_model_revisions (
  model_revision_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES model_sources(source_id) ON DELETE RESTRICT,
  model_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('release-tested', 'custom-unverified-tools')),
  preset_version TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_model_revisions_source ON model_source_model_revisions(source_id, created_at DESC);

CREATE TABLE model_source_health (
  source_id TEXT PRIMARY KEY REFERENCES model_sources(source_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'VALIDATING', 'READY', 'DEGRADED', 'NEEDS_AUTH', 'DISABLED')),
  reason_code TEXT,
  last_validated_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_source_order (
  source_id TEXT PRIMARY KEY REFERENCES model_sources(source_id) ON DELETE CASCADE,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1))
);
CREATE UNIQUE INDEX idx_model_source_single_primary ON model_source_order(is_primary) WHERE is_primary = 1;

CREATE TABLE joi_inbox_messages (
  input_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLARIFICATION_REQUIRED', 'ROUTED', 'CONSUMED')),
  clarification_reason_code TEXT,
  avatar_id TEXT REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_joi_inbox_status ON joi_inbox_messages(status, created_at, input_id);

CREATE TABLE joi_turns (
  turn_id TEXT PRIMARY KEY,
  input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  avatar_id TEXT REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  source_revision_id TEXT REFERENCES model_source_revisions(source_revision_id) ON DELETE RESTRICT,
  model_revision_id TEXT REFERENCES model_source_model_revisions(model_revision_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'ABORTED')),
  formal_output_started INTEGER NOT NULL DEFAULT 0 CHECK (formal_output_started IN (0, 1)),
  side_effect_started INTEGER NOT NULL DEFAULT 0 CHECK (side_effect_started IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_joi_turns_session ON joi_turns(session_id, created_at, turn_id);

CREATE TABLE joi_session_messages (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);

CREATE TABLE work_items (
  work_id TEXT PRIMARY KEY,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  input_id TEXT REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('READ', 'WRITE')),
  workspace_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'READY', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_items_avatar_status ON work_items(avatar_id, status, created_at);

CREATE TABLE work_dependencies (
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE CASCADE,
  depends_on_work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  PRIMARY KEY (work_id, depends_on_work_id),
  CHECK (work_id <> depends_on_work_id)
);

CREATE TABLE dispatch_plans (
  dispatch_plan_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES joi_turns(turn_id) ON DELETE RESTRICT,
  candidate_json TEXT NOT NULL,
  policy_result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE dispatch_attempts (
  dispatch_attempt_id TEXT PRIMARY KEY,
  dispatch_plan_id TEXT NOT NULL REFERENCES dispatch_plans(dispatch_plan_id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  partner_revision_id TEXT NOT NULL REFERENCES partner_revisions(partner_revision_id) ON DELETE RESTRICT,
  registry_revision INTEGER NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  outbox_id TEXT REFERENCES outbox(outbox_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'DISPATCHED', 'ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_dispatch_attempts_work ON dispatch_attempts(work_id, created_at);

CREATE TABLE workspace_leases (
  workspace_ref TEXT NOT NULL,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE CASCADE,
  access_mode TEXT NOT NULL CHECK (access_mode IN ('READ', 'WRITE')),
  lease_owner TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (workspace_ref, work_id)
);
