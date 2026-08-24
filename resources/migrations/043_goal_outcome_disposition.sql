ALTER TABLE joi_goal_outcomes ADD COLUMN disposition TEXT NOT NULL DEFAULT 'COMPLETED'
  CHECK (disposition IN ('COMPLETED', 'BLOCKED'));
