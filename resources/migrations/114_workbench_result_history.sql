CREATE INDEX idx_joi_inbox_workbench_result_history
  ON joi_inbox_messages(workbench_id, input_id)
  WHERE goal_input_id IS NULL AND canceled_at IS NULL AND dismissed_at IS NULL;
