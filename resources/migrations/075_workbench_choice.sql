ALTER TABLE joi_inbox_messages ADD COLUMN workbench_proposal_json TEXT;

CREATE TABLE workbench_choice_creations (
  input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id),
  question_id TEXT NOT NULL,
  question_version INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  workbench_id TEXT NOT NULL UNIQUE REFERENCES workbenches(workbench_id),
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (input_id, question_id, question_version)
);
