CREATE TABLE historical_memory_sources (
  source_id TEXT PRIMARY KEY,
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('goal', 'direct', 'partner')),
  subject_id TEXT NOT NULL,
  version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE historical_memories (
  scope TEXT NOT NULL CHECK (scope IN ('joi', 'workbench', 'partner')),
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  entries_json TEXT NOT NULL CHECK (json_valid(entries_json)),
  PRIMARY KEY (scope, owner_id)
);

CREATE TABLE historical_memory_receipts (
  source_id TEXT NOT NULL REFERENCES historical_memory_sources(source_id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  PRIMARY KEY (source_id, scope)
);
