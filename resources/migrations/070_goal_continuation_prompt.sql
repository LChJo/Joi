-- The current follow-up is distinct from the cumulative user-facing goal body.
ALTER TABLE joi_inbox_messages ADD COLUMN continuation_prompt TEXT;
