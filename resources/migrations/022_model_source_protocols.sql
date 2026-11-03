ALTER TABLE model_source_revisions
  ADD COLUMN protocol TEXT NOT NULL DEFAULT 'openai'
  CHECK (protocol IN ('openai', 'anthropic'));

UPDATE model_source_revisions
   SET protocol = 'anthropic'
 WHERE kind = 'kimi'
   AND access_mode = 'coding-plan';
