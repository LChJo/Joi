CREATE TABLE statistics_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  collected_since TEXT NOT NULL,
  collection_degraded INTEGER NOT NULL DEFAULT 0 CHECK(collection_degraded IN (0,1))
);
CREATE TABLE usage_invocations (
  invocation_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','canceled','interrupted')),
  engine TEXT NOT NULL CHECK(engine IN ('pi','codex','claude-code','a2a')),
  purpose TEXT NOT NULL CHECK(purpose IN ('orchestration','routing','partner','evolution','summary','probe')),
  workbench_id TEXT,
  workbench_name TEXT,
  goal_id TEXT,
  work_id TEXT,
  partner_id TEXT,
  source_id TEXT,
  source_name TEXT,
  model_id TEXT
);
CREATE TABLE usage_observations (
  invocation_id TEXT NOT NULL REFERENCES usage_invocations(invocation_id) ON DELETE CASCADE,
  observation_key TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  model_id TEXT,
  source_id TEXT,
  source_name TEXT,
  tokens_json TEXT CHECK(tokens_json IS NULL OR json_valid(tokens_json)),
  PRIMARY KEY(invocation_id, observation_key)
);
CREATE INDEX idx_usage_time ON usage_invocations(started_at);
CREATE INDEX idx_usage_workbench_time ON usage_invocations(workbench_id,started_at);
CREATE INDEX idx_usage_model_time ON usage_invocations(source_id,model_id,started_at);
CREATE INDEX idx_usage_goal ON usage_invocations(goal_id);
CREATE INDEX idx_usage_observation_time ON usage_observations(observed_at);
