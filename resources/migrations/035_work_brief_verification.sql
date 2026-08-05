CREATE TABLE work_result_verifications (
  result_id TEXT PRIMARY KEY REFERENCES work_results(result_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('FAILED', 'NOT_REQUIRED', 'PASSED')),
  reason_code TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO work_result_verifications (result_id, status, reason_code, created_at)
SELECT result_id, 'NOT_REQUIRED', NULL, created_at FROM work_results;
