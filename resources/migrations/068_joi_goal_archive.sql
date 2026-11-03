-- Records that the user filed a finished goal card away from the home feed.
--
-- Archiving is the reversible counterpart of `dismissed_at` (migration 032): the card leaves the
-- home feed and shows up in the archived list instead, where "取消归档" puts it back. That is why
-- it is a separate column rather than a second meaning for the dismiss marker — nothing is thrown
-- away, and the goal stays readable, continuable and dismissable from the archive.
--
-- Only a terminal goal is archivable, but a terminal goal can be revived (an explicit retry, or a
-- scheduled goal-continuation routine firing). Both of those writes clear this column in the same
-- transaction; a goal that started running again must not stay invisible on the home feed.
ALTER TABLE joi_inbox_messages ADD COLUMN archived_at TEXT;

-- The home feed filters archived rows out of every poll, and the archive list orders by this
-- column; both projections are group-by over joi_inbox_messages.
CREATE INDEX IF NOT EXISTS idx_joi_inbox_archived ON joi_inbox_messages(archived_at);
