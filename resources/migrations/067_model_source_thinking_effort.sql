-- Per-model thinking effort, so the settings page can pick how hard this exact model is asked
-- to think. Some gateways only accept a specific effort tier (or reject the thinking parameter
-- outright), which no baseUrl allowlist can express — the choice belongs to the model revision,
-- next to the window/output limits it shares a revision row with.
--
-- NULL means "not configured": every row written before this migration keeps resolving through
-- joi's endpoint allowlist (always-on hosts get "low", everything else "off"), so there is
-- nothing to backfill and "cleared" is indistinguishable from "never set" — which is what the
-- settings page wants. The table is append-only; the service layer carries the value forward
-- on edits that keep the model, and drops it when the Model ID changes.
--
-- The allowed set mirrors THINKING_EFFORTS in src/shared/joi.ts and must be changed with it.
ALTER TABLE model_source_model_revisions ADD COLUMN thinking_effort TEXT
  CHECK (thinking_effort IS NULL OR thinking_effort IN ('off', 'low', 'medium', 'high', 'xhigh', 'max'));
