CREATE TABLE work_recovery_attempts (
  recovery_id TEXT PRIMARY KEY,
  source_work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  replacement_work_id TEXT UNIQUE REFERENCES work_items(work_id) ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 2),
  strategy TEXT NOT NULL CHECK (strategy IN ('REASSIGN', 'SUPPLEMENT', 'TOOL_EXPANSION')),
  status TEXT NOT NULL CHECK (status IN ('PLANNED', 'COMPLETED', 'FAILED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_work_id, attempt_no)
);
CREATE INDEX idx_work_recovery_source ON work_recovery_attempts(source_work_id, attempt_no);

CREATE TABLE work_recovery_evidence (
  recovery_id TEXT NOT NULL REFERENCES work_recovery_attempts(recovery_id) ON DELETE CASCADE,
  result_id TEXT NOT NULL REFERENCES work_results(result_id) ON DELETE RESTRICT,
  PRIMARY KEY (recovery_id, result_id)
);
