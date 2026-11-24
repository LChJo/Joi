ALTER TABLE method_learning_calls ADD COLUMN phase TEXT;
CREATE INDEX idx_method_learning_calls_experiment ON method_learning_calls(experiment_id,phase);

CREATE INDEX idx_method_learning_pins_cohort ON method_learning_goal_pins(
  CASE WHEN json_valid(policy) THEN json_extract(policy,'$.cohortRevisionId') END,created_at,goal_id
);
CREATE INDEX idx_method_learning_pins_revision ON method_learning_goal_pins(revision_id,created_at,goal_id);
