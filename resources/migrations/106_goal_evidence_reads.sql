CREATE TABLE joi_goal_evidence_reads (
  turn_id TEXT NOT NULL REFERENCES joi_turns(turn_id),
  tool_call_id TEXT NOT NULL,
  goal_input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id),
  result_revision INTEGER NOT NULL,
  requirements_revision INTEGER NOT NULL,
  result_id TEXT NOT NULL REFERENCES work_results(result_id) ON DELETE CASCADE,
  source_ref TEXT NOT NULL REFERENCES work_result_bodies(body_ref) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  PRIMARY KEY (turn_id, tool_call_id)
);
CREATE INDEX idx_joi_goal_evidence_read_result
  ON joi_goal_evidence_reads (goal_input_id, requirements_revision, result_id, source_ref, result_revision);
