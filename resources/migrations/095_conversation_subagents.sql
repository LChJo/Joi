CREATE TABLE conversation_subagents (
 child_id TEXT PRIMARY KEY,
 parent_turn_id TEXT NOT NULL REFERENCES conversation_turns(turn_id),
 call_id TEXT NOT NULL,
 input_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELED','INTERRUPTED')),
 body TEXT,
 session_json TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 UNIQUE(parent_turn_id,call_id)
);
CREATE INDEX conversation_subagents_parent ON conversation_subagents(parent_turn_id,status);
