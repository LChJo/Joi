-- Per-model sizing, so the settings page can override what joi would otherwise guess.
-- Window and completion cap are properties of the *model*, not of the access mode, so they
-- live on the model revision; the table is append-only, which gives "every edit leaves a
-- revision behind" for free, exactly like preset_version already does.
--
-- All three are nullable and NULL means "not configured": every row written before this
-- migration keeps resolving through the provider preset and the provider's own rejection
-- messages, so there is nothing to backfill and "cleared" is indistinguishable from "never
-- set" — which is what the settings page wants.
--
-- compaction_threshold_percent stops at 95 on purpose. A threshold of 100 would mean the
-- session is compacted only once the request already fills the window, and by then the
-- provider has clamped max_tokens toward 1 — the exact failure compaction exists to avoid.
ALTER TABLE model_source_model_revisions ADD COLUMN context_window INTEGER
  CHECK (context_window IS NULL OR (context_window >= 4096 AND context_window <= 10000000));

ALTER TABLE model_source_model_revisions ADD COLUMN max_output_tokens INTEGER
  CHECK (max_output_tokens IS NULL OR (max_output_tokens >= 256 AND max_output_tokens <= 1000000));

ALTER TABLE model_source_model_revisions ADD COLUMN compaction_threshold_percent INTEGER
  CHECK (compaction_threshold_percent IS NULL OR (compaction_threshold_percent >= 50 AND compaction_threshold_percent <= 95));
