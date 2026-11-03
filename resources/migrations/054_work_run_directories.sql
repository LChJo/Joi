-- Private, stable execution roots. A new Work gets a new managed directory;
-- retries/recovery of that Work retain the recorded directory.
CREATE TABLE work_run_directories (
  work_id TEXT PRIMARY KEY REFERENCES work_items(work_id) ON DELETE CASCADE,
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('MANAGED', 'BOUND')),
  root_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROVISIONING', 'READY')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_work_run_directories_workbench ON work_run_directories(workbench_id);
