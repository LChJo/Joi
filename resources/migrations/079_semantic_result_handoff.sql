ALTER TABLE work_results ADD COLUMN handoff_json TEXT;
ALTER TABLE work_results ADD COLUMN handoff_status TEXT NOT NULL DEFAULT 'MISSING'
  CHECK(handoff_status IN ('MISSING', 'INVALID', 'PROVIDED'));
ALTER TABLE joi_goal_outcomes ADD COLUMN synthesis_state_json TEXT;
ALTER TABLE joi_goal_outcome_history ADD COLUMN synthesis_state_json TEXT;
