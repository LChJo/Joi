-- Only an explicit user retry changes a goal's opening order.
-- Existing goals fall back to their original creation time.
ALTER TABLE joi_inbox_messages ADD COLUMN last_opened_at TEXT;
