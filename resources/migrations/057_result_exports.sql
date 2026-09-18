CREATE TABLE result_exports (
  export_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  goal_id TEXT NOT NULL,
  format TEXT NOT NULL,
  digest TEXT NOT NULL,
  body TEXT NOT NULL,
  basename TEXT NOT NULL,
  status TEXT NOT NULL,
  filenames_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  created_at TEXT NOT NULL
);
