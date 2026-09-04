-- Enforce the declared Work dependency DAG at dispatch time. A Work whose
-- dependencies have not all completed is not claimable; when a dependency ends
-- in FAILED/CANCELED the downstream closure is canceled deterministically.
CREATE INDEX idx_work_dependencies_depends_on
  ON work_dependencies (depends_on_work_id);

-- Observable reason for a deterministic cascade cancellation.
ALTER TABLE work_items ADD COLUMN cancel_reason TEXT;
