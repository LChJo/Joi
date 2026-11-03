ALTER TABLE workbench_partner_work_memories ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workbench_partner_work_memory_summaries ADD COLUMN covered_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workbench_partner_work_memory_summaries ADD COLUMN total_count INTEGER NOT NULL DEFAULT 0;

WITH ordered AS (
  SELECT memory_id, ROW_NUMBER() OVER (
    PARTITION BY workbench_id, partner_id ORDER BY created_at, memory_id
  ) AS ordinal FROM workbench_partner_work_memories
)
UPDATE workbench_partner_work_memories SET sequence = (
  SELECT ordinal FROM ordered WHERE ordered.memory_id = workbench_partner_work_memories.memory_id
);

UPDATE workbench_partner_work_memory_summaries SET
  total_count = (SELECT COUNT(*) FROM workbench_partner_work_memories m
    WHERE m.workbench_id = workbench_partner_work_memory_summaries.workbench_id
      AND m.partner_id = workbench_partner_work_memory_summaries.partner_id),
  covered_sequence = COALESCE((SELECT MAX(sequence) FROM workbench_partner_work_memories m
    WHERE m.workbench_id = workbench_partner_work_memory_summaries.workbench_id
      AND m.partner_id = workbench_partner_work_memory_summaries.partner_id
      AND m.created_at < workbench_partner_work_memory_summaries.updated_at), 0);

INSERT INTO workbench_partner_work_memory_summaries
  (workbench_id, partner_id, summary, entry_count, updated_at, covered_sequence, total_count)
SELECT workbench_id, partner_id, '', 0, MAX(created_at), 0, COUNT(*)
FROM workbench_partner_work_memories GROUP BY workbench_id, partner_id
ON CONFLICT(workbench_id, partner_id) DO NOTHING;

CREATE TABLE workbench_partner_work_memory_receipts (
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  result_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  PRIMARY KEY (workbench_id, partner_id, result_key)
);
INSERT OR IGNORE INTO workbench_partner_work_memory_receipts
  (workbench_id, partner_id, result_key, sequence)
SELECT workbench_id, partner_id, json_array(work_id, session_data_source, outcome), sequence
FROM workbench_partner_work_memories;
INSERT OR IGNORE INTO workbench_partner_work_memory_receipts
  (workbench_id, partner_id, result_key, sequence)
SELECT m.workbench_id, m.partner_id, r.result_id, m.sequence
FROM workbench_partner_work_memories m JOIN work_results r
  ON r.workbench_id = m.workbench_id AND r.work_id = m.work_id AND r.status = m.outcome AND r.created_at <= m.created_at
JOIN partner_revisions p ON p.partner_revision_id = r.partner_revision_id AND p.partner_id = m.partner_id;

CREATE TABLE workbench_partner_work_memory_refreshes (
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id) ON DELETE CASCADE,
  partner_id TEXT NOT NULL REFERENCES partners(partner_id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL,
  entries_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workbench_id, partner_id, sequence)
);
CREATE INDEX idx_partner_memory_sequence
  ON workbench_partner_work_memories(workbench_id, partner_id, sequence DESC);
CREATE INDEX idx_work_items_goal_page
  ON work_items(input_id, workbench_id, created_at, work_id);
CREATE INDEX idx_work_results_work_page
  ON work_results(work_id, created_at DESC, result_id DESC);
