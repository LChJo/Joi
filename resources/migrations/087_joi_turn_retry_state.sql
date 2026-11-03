-- Retry ownership belongs to the persisted input across process restarts.
ALTER TABLE joi_inbox_messages ADD COLUMN turn_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_failure_count >= 0);
ALTER TABLE joi_inbox_messages ADD COLUMN turn_failed_at TEXT;
ALTER TABLE joi_inbox_messages ADD COLUMN turn_failure_reason_code TEXT;
ALTER TABLE joi_inbox_messages ADD COLUMN turn_retry_at TEXT;
ALTER TABLE joi_inbox_messages ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0 CHECK (session_generation >= 0);
ALTER TABLE joi_inbox_messages ADD COLUMN turn_retry_epoch INTEGER NOT NULL DEFAULT 0 CHECK (turn_retry_epoch >= 0);
