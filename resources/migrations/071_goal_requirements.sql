CREATE TABLE joi_goal_requirement_sources (
  goal_input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id),
  source_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('USER', 'LEGACY', 'ROUTINE')),
  body TEXT NOT NULL,
  body_chars INTEGER NOT NULL,
  source_key TEXT,
  read_offset INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (goal_input_id, source_revision)
) STRICT;
CREATE UNIQUE INDEX idx_goal_requirement_source_key ON joi_goal_requirement_sources(goal_input_id, source_key) WHERE source_key IS NOT NULL;

CREATE TABLE joi_goal_requirements (
  goal_input_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id),
  workbench_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  processed_source_revision INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE joi_goal_requirement_snapshots (
  goal_input_id TEXT NOT NULL REFERENCES joi_goal_requirements(goal_input_id),
  revision INTEGER NOT NULL,
  requirements_json TEXT NOT NULL,
  PRIMARY KEY (goal_input_id, revision)
) STRICT;

ALTER TABLE joi_inbox_messages ADD COLUMN requirements_revision INTEGER;
ALTER TABLE joi_turns ADD COLUMN requirements_revision INTEGER;
ALTER TABLE joi_goal_outcomes ADD COLUMN requirements_revision INTEGER;
ALTER TABLE joi_goal_result_sets ADD COLUMN synthesized_requirements_revision INTEGER;
ALTER TABLE joi_harness_maps ADD COLUMN reviewed_requirements_revision INTEGER;
ALTER TABLE joi_user_action_requests ADD COLUMN requirements_revision INTEGER;
ALTER TABLE partner_runs ADD COLUMN requirements_revision INTEGER;
ALTER TABLE partner_runs ADD COLUMN requirements_context TEXT;

CREATE TABLE joi_work_brief_updates (
  action_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES work_items(work_id)
) STRICT;

-- An outcome is current while its requirements revision matches the contract's and no user input
-- is outstanding. Two allowances keep a pre-requirements goal from losing its finished answer the
-- moment its contract initializes: an unstamped outcome counts as revision 0 (initialization is
-- bookkeeping, not a requirement change), and only real user sources can make input outstanding —
-- the LEGACY source `ensure` migrates out of the goal body is a back-reference to input the goal
-- already answered, not a new instruction waiting to be read.
CREATE VIEW joi_current_goal_outcomes AS
SELECT o.* FROM joi_goal_outcomes o
WHERE NOT EXISTS (
  SELECT 1 FROM joi_goal_requirements g WHERE g.goal_input_id = o.input_id
  AND (COALESCE(o.requirements_revision, 0) <> g.revision OR g.processed_source_revision <
    (SELECT COALESCE(MAX(s.source_revision), 0) FROM joi_goal_requirement_sources s
     WHERE s.goal_input_id = g.goal_input_id AND s.kind <> 'LEGACY'))
);
