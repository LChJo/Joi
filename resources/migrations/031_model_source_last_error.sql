-- Stores the raw validator error text for the most recent failed validation so the UI can show
-- the exact cause (e.g. an HTTP status + body, or "Connection error."). The application layer
-- truncates this to 1000 characters before persisting. Cleared (NULL) on edit and on a READY re-validation.
ALTER TABLE model_source_health ADD COLUMN last_error TEXT;
