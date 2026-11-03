-- Persists the concrete question shown by a structured clarification card.
-- Absolute workspace paths remain private to Avatar workspace infrastructure.
ALTER TABLE joi_inbox_messages ADD COLUMN clarification_prompt TEXT;
