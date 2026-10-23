CREATE TABLE method_learning_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
INSERT INTO method_learning_control VALUES (1, json_object(
  'enabled', json(CASE WHEN EXISTS (
    SELECT 1 FROM evolution_states e JOIN workbenches w ON w.workbench_id = e.workbench_id
    WHERE w.status = 'ACTIVE' AND COALESCE(json_extract(e.state_json, '$.dailyCallLimit'),0) > 0
      AND COALESCE(json_extract(e.state_json, '$.paused'),0) = 0
  ) THEN 'true' ELSE 'false' END), 'paused', json('false'), 'dailyCallLimit',150,'lastCandidateDay',
  (SELECT MAX(json_extract(e.state_json,'$.lastCandidateDay')) FROM evolution_states e
   JOIN workbenches w ON w.workbench_id=e.workbench_id WHERE w.status='ACTIVE')));
CREATE TABLE method_learning_participants (
  workbench_id TEXT PRIMARY KEY REFERENCES workbenches(workbench_id),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
INSERT INTO method_learning_participants SELECT workbench_id,json_object(
  'enabled', json(CASE WHEN COALESCE(json_extract(state_json,'$.dailyCallLimit'),0)>0 THEN 'true' ELSE 'false' END),
  'paused', json(CASE WHEN COALESCE(json_extract(state_json,'$.paused'),0)=1 THEN 'true' ELSE 'false' END),
  'dailyCallLimit',COALESCE(json_extract(state_json,'$.dailyCallLimit'),0),
  'reason',COALESCE(json_extract(state_json,'$.reason'),'disabled')) FROM evolution_states;
CREATE TABLE method_learning_calls (
  call_id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, workbench_id TEXT NOT NULL,
  day TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, tokens INTEGER
) STRICT;
CREATE INDEX idx_method_learning_calls_day ON method_learning_calls(day,workbench_id);
CREATE TABLE method_learning_fact_receipts (
  goal_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
) STRICT;
CREATE TABLE method_learning_cases (
  case_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, workbench_id TEXT NOT NULL,
  observed_at TEXT NOT NULL, case_json TEXT NOT NULL CHECK(json_valid(case_json))
) STRICT;
CREATE INDEX idx_method_learning_cases_workbench ON method_learning_cases(workbench_id,observed_at);
CREATE TABLE method_learning_experiments (
  experiment_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json))
) STRICT;
CREATE UNIQUE INDEX idx_method_learning_single_experiment ON method_learning_experiments((1)) WHERE status IN ('RUNNING','PAUSED');
CREATE TABLE method_learning_case_references (
  experiment_id TEXT NOT NULL REFERENCES method_learning_experiments(experiment_id),
  case_id TEXT NOT NULL REFERENCES method_learning_cases(case_id), PRIMARY KEY(experiment_id,case_id)
) STRICT;
CREATE TABLE method_learning_revisions (
  revision_id TEXT PRIMARY KEY, state_json TEXT NOT NULL CHECK(json_valid(state_json))
) STRICT;
CREATE TABLE method_learning_trial_cache (
  cache_key TEXT PRIMARY KEY, result_json TEXT NOT NULL CHECK(json_valid(result_json))
) STRICT;
CREATE TABLE method_learning_goal_pins (
  goal_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id),
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id),
  revision_id TEXT, policy TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE method_learning_evidence_reads (
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id),
  goal_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id),
  turn_id TEXT NOT NULL REFERENCES joi_turns(turn_id), tool_call_id TEXT NOT NULL,
  requirements_revision INTEGER NOT NULL, result_revision INTEGER NOT NULL,
  tool TEXT NOT NULL CHECK(tool IN ('work_read_result','work_read_evidence')),
  result_id TEXT, cursor TEXT, mode TEXT,
  PRIMARY KEY(turn_id,tool_call_id)
) STRICT;
CREATE INDEX idx_method_learning_evidence_goal ON method_learning_evidence_reads(goal_id,turn_id);
CREATE TABLE method_learning_exposure_invalidations (
  goal_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id),
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id)
) STRICT;
