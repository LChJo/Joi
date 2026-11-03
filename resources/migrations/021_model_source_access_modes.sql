ALTER TABLE model_source_revisions
  ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'api'
  CHECK (access_mode IN ('api', 'coding-plan', 'custom'));

UPDATE model_source_revisions
   SET access_mode = 'custom'
 WHERE kind = 'generic-openai';
