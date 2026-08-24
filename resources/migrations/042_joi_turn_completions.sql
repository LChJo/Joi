CREATE TABLE joi_turn_completions (
  input_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  turn_id TEXT NOT NULL UNIQUE REFERENCES joi_turns(turn_id) ON DELETE RESTRICT,
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('DIRECT_ANSWER', 'TEAM_READY')),
  completion_summary TEXT NOT NULL CHECK (length(trim(completion_summary)) > 0 AND length(completion_summary) <= 4100),
  completed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
