ALTER TABLE joi_automations ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'NEW_GOAL'
  CHECK (target_kind IN ('NEW_GOAL', 'GOAL_CONTINUATION'));

ALTER TABLE joi_automations ADD COLUMN target_goal_input_id TEXT
  REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT
  CHECK (
    (target_kind = 'NEW_GOAL' AND target_goal_input_id IS NULL)
    OR (target_kind = 'GOAL_CONTINUATION' AND target_goal_input_id IS NOT NULL)
  );

CREATE INDEX idx_joi_automations_target_goal
  ON joi_automations(target_kind, target_goal_input_id, deleted_at);
