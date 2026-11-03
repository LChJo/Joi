-- Records that a queued joi input was canceled by the user before joi routed it.
-- Canceled inputs reuse the terminal CONSUMED status (the schema's status CHECK cannot be
-- widened without a table rebuild, which the migration runner does not support); canceled_at
-- disambiguates a user cancel from a naturally consumed input for the UI.
ALTER TABLE joi_inbox_messages ADD COLUMN canceled_at TEXT;
