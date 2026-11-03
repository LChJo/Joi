CREATE INDEX idx_outbox_kind_ready ON outbox(kind, status, available_at, created_at, outbox_id);
