ALTER TABLE partner_revisions ADD COLUMN description TEXT;
ALTER TABLE partner_revisions ADD COLUMN engine TEXT NOT NULL DEFAULT 'PI_CORE'
  CHECK (engine IN ('PI_CORE', 'MANA_SDK'));
ALTER TABLE partner_revisions ADD COLUMN model_source_id TEXT
  REFERENCES model_sources(source_id) ON DELETE SET NULL;
ALTER TABLE partner_revisions ADD COLUMN model_id_override TEXT;
ALTER TABLE partner_revisions ADD COLUMN engine_model_id TEXT;

ALTER TABLE partners ADD COLUMN created_by TEXT NOT NULL DEFAULT 'USER'
  CHECK (created_by IN ('USER', 'JOI'));

CREATE TABLE partner_knowledge_docs (
  doc_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  filename TEXT NOT NULL,
  body TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 262144),
  created_at TEXT NOT NULL,
  UNIQUE (partner_id, filename)
);
CREATE INDEX idx_partner_knowledge_partner ON partner_knowledge_docs(partner_id, created_at);
