-- A conversation is a business history containing multiple engine-owned execution sessions.
CREATE TABLE conversation_execution_segments (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  segment_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  partner_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  capability_key TEXT NOT NULL,
  predecessor_id TEXT,
  state_json TEXT,
  PRIMARY KEY(conversation_id, segment_id),
  UNIQUE(conversation_id, sequence)
);
CREATE TABLE conversation_turn_segments (
  turn_id TEXT PRIMARY KEY REFERENCES conversation_turns(turn_id),
  conversation_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  FOREIGN KEY(conversation_id, segment_id) REFERENCES conversation_execution_segments(conversation_id, segment_id)
);
