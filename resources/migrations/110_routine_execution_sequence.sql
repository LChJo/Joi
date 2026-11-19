ALTER TABLE joi_automations ADD COLUMN last_execution_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE joi_automation_runs ADD COLUMN execution_sequence INTEGER;
ALTER TABLE joi_turns ADD COLUMN automation_run_id TEXT REFERENCES joi_automation_runs(run_id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_joi_automation_run_sequence
  ON joi_automation_runs(routine_id, execution_sequence) WHERE execution_sequence IS NOT NULL;
CREATE INDEX idx_joi_turns_automation_run
  ON joi_turns(automation_run_id) WHERE automation_run_id IS NOT NULL;
