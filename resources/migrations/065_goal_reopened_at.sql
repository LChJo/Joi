-- Only an explicit retry of a consumed goal invalidates its earlier completion.
-- last_opened_at also advances when the user answers a clarification or grants a
-- continuation; those actions must not erase a still-current result disposition.
ALTER TABLE joi_inbox_messages ADD COLUMN reopened_at TEXT;
