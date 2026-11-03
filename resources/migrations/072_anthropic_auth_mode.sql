-- Learned authentication is health metadata guarded by the active source/model/credential
-- revision. NULL uses the existing API Key behavior; only a successful no-tool probe learns Bearer.
ALTER TABLE model_source_health ADD COLUMN anthropic_auth_mode TEXT
  CHECK (anthropic_auth_mode IS NULL OR anthropic_auth_mode = 'bearer');
