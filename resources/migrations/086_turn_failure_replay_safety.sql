ALTER TABLE joi_turns ADD COLUMN failure_replay_safe INTEGER CHECK (failure_replay_safe IN (0, 1));
