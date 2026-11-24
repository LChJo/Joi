ALTER TABLE joi_harness_maps ADD COLUMN continuation_stalled_revision INTEGER;
ALTER TABLE joi_harness_maps ADD COLUMN scheduled_continuation_window_at TEXT;
ALTER TABLE joi_harness_maps ADD COLUMN scheduled_continuation_granted INTEGER NOT NULL DEFAULT 0
  CHECK (scheduled_continuation_granted >= 0);
