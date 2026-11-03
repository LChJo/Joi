CREATE TABLE evolution_states (
  workbench_id TEXT PRIMARY KEY REFERENCES workbenches(workbench_id) ON DELETE RESTRICT,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);
CREATE TABLE evolution_goal_pins (
  goal_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id) ON DELETE RESTRICT,
  revision_id TEXT,
  source_pin_json TEXT CHECK (source_pin_json IS NULL OR json_valid(source_pin_json)),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK (eligible IN (0,1))
);
INSERT INTO evolution_goal_pins(goal_id,workbench_id,revision_id,eligible)
SELECT input_id,workbench_id,NULL,0 FROM joi_inbox_messages
WHERE workbench_id IS NOT NULL AND goal_input_id IS NULL;
CREATE TABLE evolution_evidence (
  goal_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id) ON DELETE RESTRICT,
  revision_id TEXT,
  outcome TEXT NOT NULL CHECK(outcome IN ('VERIFIED','VERIFICATION_FAILED','ACCEPTED_WITH_GAPS','CANCELED','ENVIRONMENT_FAILED','UNEVALUABLE')),
  observed_at TEXT NOT NULL
);
CREATE INDEX idx_evolution_evidence_workbench ON evolution_evidence(workbench_id,observed_at);
