-- Private per-call tool bodies for local debugging. The main timeline keeps only a
-- one-line summary (AC-60/AC-61), with absolute paths abbreviated to their last three
-- segments; the full command and output are appended here once per completed call, keyed by
-- the opaque tool call id, and read on demand only. Credentials are masked before insert;
-- absolute paths are deliberately kept in full here, because this table is how a reader
-- recovers the part the timeline summary elided. No history is backfilled: pre-062
-- TOOL_CALL rows carry neither a tool_call_id nor any source for a body.
CREATE TABLE workbench_agent_tool_traces (
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  command TEXT NOT NULL,
  result TEXT NOT NULL,
  is_error INTEGER NOT NULL CHECK (is_error IN (0, 1)),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, tool_call_id)
);

-- agent_id is intentionally denormalized: the reveal route resolves a run through the
-- conversation entry, and dismiss clears one agent's traces in a single statement.
CREATE INDEX idx_workbench_agent_tool_traces_agent_call
  ON workbench_agent_tool_traces(agent_id, tool_call_id, created_at DESC);

ALTER TABLE workbench_agent_conversation_entries ADD COLUMN tool_call_id TEXT;

CREATE INDEX idx_workbench_agent_entries_tool_call
  ON workbench_agent_conversation_entries(agent_id, tool_call_id);
