ALTER TABLE conversations ADD COLUMN archived_at TEXT;
ALTER TABLE conversations ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_conversations_archive ON conversations(archived_at, updated_at DESC) WHERE deleted_at IS NULL;
