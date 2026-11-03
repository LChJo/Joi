-- Records that the user removed a terminal inbox card from the home feed.
-- Dismissed rows reuse the terminal CONSUMED status (the schema's status CHECK cannot be
-- widened without a table rebuild, which the migration runner does not support); dismissed_at
-- is a soft-delete marker so list() can hide finished or canceled cards the user removed,
-- while loadInput() and backups keep the orchestration fact.
ALTER TABLE joi_inbox_messages ADD COLUMN dismissed_at TEXT;
