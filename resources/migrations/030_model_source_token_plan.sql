-- joi:migration foreign-keys-off
CREATE TABLE model_source_revisions_030 (
  source_revision_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES model_sources(source_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('kimi', 'glm', 'qwen', 'doubao', 'minimax', 'deepseek', 'generic-openai')),
  display_name TEXT NOT NULL,
  base_url TEXT,
  credential_ref TEXT NOT NULL REFERENCES model_source_credentials(provider_id) ON DELETE RESTRICT,
  credential_version INTEGER NOT NULL CHECK (credential_version > 0),
  created_at TEXT NOT NULL,
  access_mode TEXT NOT NULL DEFAULT 'api'
    CHECK (access_mode IN ('api', 'coding-plan', 'token-plan', 'custom')),
  protocol TEXT NOT NULL DEFAULT 'openai'
    CHECK (protocol IN ('openai', 'anthropic'))
);

INSERT INTO model_source_revisions_030
  (source_revision_id, source_id, kind, display_name, base_url, credential_ref,
   credential_version, created_at, access_mode, protocol)
SELECT source_revision_id, source_id, kind, display_name, base_url, credential_ref,
       credential_version, created_at, access_mode, protocol
  FROM model_source_revisions;

DROP INDEX idx_model_source_revisions_source;
DROP TABLE model_source_revisions;
ALTER TABLE model_source_revisions_030 RENAME TO model_source_revisions;
CREATE INDEX idx_model_source_revisions_source ON model_source_revisions(source_id, created_at DESC);
