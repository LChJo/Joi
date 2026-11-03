-- joi harness: persistent goal map (wayfinder destination / paths / decisions / fog).
-- The map is an index over execution facts, never a second execution model:
-- work_items / dispatch_attempts stay the execution truth; paths only reference work_id.
-- Length limits live in the application layer; CHECK keeps enums and non-negative counters.

CREATE TABLE joi_harness_maps (
  goal_input_id TEXT PRIMARY KEY REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  avatar_id TEXT NOT NULL REFERENCES avatars(avatar_id) ON DELETE RESTRICT,
  destination TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLEARED')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  reviewed_revision INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_revision >= 0),
  cleared_at TEXT,
  feedback_recorded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE joi_harness_paths (
  path_id TEXT PRIMARY KEY,
  goal_input_id TEXT NOT NULL REFERENCES joi_harness_maps(goal_input_id) ON DELETE RESTRICT,
  layer INTEGER NOT NULL CHECK (layer > 0),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'OUT_OF_SCOPE')),
  work_id TEXT REFERENCES work_items(work_id) ON DELETE SET NULL,
  resolved_decision_id TEXT REFERENCES joi_harness_decisions(decision_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_joi_harness_paths_goal
  ON joi_harness_paths(goal_input_id, layer, created_at, path_id);

CREATE TABLE joi_harness_decisions (
  decision_id TEXT PRIMARY KEY,
  goal_input_id TEXT NOT NULL REFERENCES joi_harness_maps(goal_input_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('APPROACH', 'SCOPE', 'OUT_OF_SCOPE', 'AVATAR_REFINE')),
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  turn_id TEXT REFERENCES joi_turns(turn_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_joi_harness_decisions_goal
  ON joi_harness_decisions(goal_input_id, created_at, decision_id);

CREATE TABLE joi_harness_fog (
  fog_id TEXT PRIMARY KEY,
  goal_input_id TEXT NOT NULL REFERENCES joi_harness_maps(goal_input_id) ON DELETE RESTRICT,
  note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'GRADUATED')),
  graduated_path_id TEXT REFERENCES joi_harness_paths(path_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_joi_harness_fog_goal
  ON joi_harness_fog(goal_input_id, status, created_at, fog_id);

-- Upgrade backfill: goals already CONSUMED or canceled before the harness existed are
-- adopted straight into CLEARED maps (feedback marked done) so historical goals never
-- trigger retrospective reviews or feedback; only goals arriving after this migration
-- live the ACTIVE lifecycle.
INSERT INTO joi_harness_maps
  (goal_input_id, avatar_id, destination, status, revision, reviewed_revision,
   cleared_at, feedback_recorded_at, created_at, updated_at)
SELECT i.input_id, i.avatar_id, NULL, 'CLEARED', 0, 0,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       i.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM joi_inbox_messages i
 WHERE (i.status = 'CONSUMED' OR i.canceled_at IS NOT NULL)
   AND i.avatar_id IS NOT NULL
   AND i.input_id NOT LIKE 'joi_result_input:%'
   AND i.input_id NOT LIKE 'joi_signal_input:%';
