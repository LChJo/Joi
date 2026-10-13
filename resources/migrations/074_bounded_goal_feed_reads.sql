CREATE INDEX idx_joi_inbox_goal_input ON joi_inbox_messages(goal_input_id, input_id);
CREATE INDEX idx_joi_turns_input_latest ON joi_turns(input_id, created_at DESC, turn_id DESC, status);
CREATE INDEX idx_dispatch_attempts_work_instance ON dispatch_attempts(work_id, instance_id);
CREATE INDEX idx_partner_runs_work_status_id ON partner_runs(work_id, status, run_id);
CREATE INDEX idx_workbench_agent_sessions_backing_visible ON workbench_agent_sessions(backing_kind, backing_id, dismissed_at, agent_id);
