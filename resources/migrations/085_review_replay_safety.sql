ALTER TABLE joi_turns ADD COLUMN review_replay_safe INTEGER CHECK (review_replay_safe IN (0, 1));
