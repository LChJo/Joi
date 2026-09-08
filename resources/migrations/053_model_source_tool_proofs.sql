-- Remembers that a custom model revision already demonstrated structured tool
-- calling in a real joi Turn, so later direct-answer Turns are not failed closed
-- again (AC-26 gates the FIRST Turn only). Keyed by the immutable revision pair:
-- a new model or source revision starts unproven.
CREATE TABLE model_source_tool_proofs (
  source_revision_id TEXT NOT NULL REFERENCES model_source_revisions(source_revision_id) ON DELETE CASCADE,
  model_revision_id TEXT NOT NULL REFERENCES model_source_model_revisions(model_revision_id) ON DELETE CASCADE,
  proven_at TEXT NOT NULL,
  PRIMARY KEY (source_revision_id, model_revision_id)
);

-- Turns recorded before this migration already prove capability for their pinned
-- revision pair: a side effect only starts once a structured tool call was observed.
INSERT OR IGNORE INTO model_source_tool_proofs (source_revision_id, model_revision_id, proven_at)
SELECT DISTINCT t.source_revision_id, t.model_revision_id, t.updated_at
  FROM joi_turns t
 WHERE t.side_effect_started = 1
   AND t.source_revision_id IS NOT NULL
   AND t.model_revision_id IS NOT NULL;
