CREATE TABLE joi_goal_outcome_history (
  goal_input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  result_revision INTEGER NOT NULL,
  requirements_revision INTEGER NOT NULL DEFAULT 0,
  disposition TEXT NOT NULL,
  completion_summary TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (goal_input_id, result_revision, requirements_revision)
);

INSERT INTO joi_goal_outcome_history
  (goal_input_id, result_revision, requirements_revision, disposition, completion_summary, completed_at)
SELECT input_id, result_revision, COALESCE(requirements_revision, 0), disposition, completion_summary, completed_at
FROM joi_goal_outcomes;
