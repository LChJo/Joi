ALTER TABLE agent_connections ADD COLUMN token_required INTEGER NOT NULL DEFAULT 0 CHECK (token_required IN (0, 1));
