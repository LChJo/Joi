-- Distinguish a safe next evidence layer from a hard blocker, and persist the
-- number of continuation layers the user has authorized for each goal map.
ALTER TABLE joi_harness_maps ADD COLUMN continuation_allowance INTEGER NOT NULL DEFAULT 2
  CHECK (continuation_allowance >= 0);

CREATE TABLE joi_goal_outcomes_051 (
  input_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  completion_summary TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'COMPLETED'
    CHECK (disposition IN ('COMPLETED', 'CONTINUE', 'BLOCKED', 'ACCEPTED_WITH_GAPS'))
);
INSERT INTO joi_goal_outcomes_051
  (input_id, result_revision, completion_summary, completed_at, updated_at, disposition)
SELECT input_id, result_revision, completion_summary, completed_at, updated_at, disposition
  FROM joi_goal_outcomes;
DROP TABLE joi_goal_outcomes;
ALTER TABLE joi_goal_outcomes_051 RENAME TO joi_goal_outcomes;

-- Goal-level continuation decisions are durable user actions, but unlike
-- partner recovery they deliberately do not reference a Work or partner run.
CREATE TABLE joi_user_action_requests_051 (
  action_id TEXT PRIMARY KEY,
  input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  work_id TEXT REFERENCES work_items(work_id) ON DELETE RESTRICT,
  run_id TEXT REFERENCES partner_runs(run_id) ON DELETE RESTRICT,
  result_revision INTEGER CHECK (result_revision IS NULL OR result_revision > 0),
  kind TEXT NOT NULL CHECK (kind IN ('PARTNER_QUESTION', 'RECOVERY_DECISION', 'GOAL_CONTINUATION')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'APPLIED', 'CANCELED')),
  reason_code TEXT NOT NULL,
  prompt TEXT NOT NULL,
  decision TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  applied_at TEXT,
  CHECK (
    (kind = 'GOAL_CONTINUATION' AND work_id IS NULL AND run_id IS NULL AND result_revision IS NOT NULL)
    OR
    (kind IN ('PARTNER_QUESTION', 'RECOVERY_DECISION') AND work_id IS NOT NULL AND run_id IS NOT NULL AND result_revision IS NULL)
  ),
  CHECK (
    decision IS NULL
    OR (kind = 'GOAL_CONTINUATION' AND decision IN ('CONTINUE', 'ACCEPT_CURRENT'))
    OR (kind IN ('PARTNER_QUESTION', 'RECOVERY_DECISION') AND decision = 'RESUME')
  )
);
INSERT INTO joi_user_action_requests_051
  (action_id, input_id, work_id, run_id, result_revision, kind, status, reason_code,
   prompt, decision, created_at, updated_at, resolved_at, applied_at)
SELECT action_id, input_id, work_id, run_id, NULL, kind, status, reason_code,
       prompt, decision, created_at, updated_at, resolved_at, applied_at
  FROM joi_user_action_requests;
DROP TABLE joi_user_action_requests;
ALTER TABLE joi_user_action_requests_051 RENAME TO joi_user_action_requests;
CREATE UNIQUE INDEX idx_joi_user_action_one_open_per_input
  ON joi_user_action_requests(input_id) WHERE status = 'OPEN';
CREATE INDEX idx_joi_user_action_resolved
  ON joi_user_action_requests(status, updated_at, action_id);
