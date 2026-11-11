CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_conversations_workbench ON conversations(workbench_id, updated_at DESC);
CREATE TABLE conversation_turns (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  config_json TEXT NOT NULL,
  revision_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','STOPPED','INTERRUPTED')),
  entries_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_conversation_active_turn ON conversation_turns(conversation_id) WHERE status IN ('QUEUED','RUNNING');
CREATE TABLE workspace_git_commands (
  command_id TEXT PRIMARY KEY,
  workbench_id TEXT NOT NULL REFERENCES workbenches(workbench_id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED','INTERRUPTED')),
  error_code TEXT,
  created_at TEXT NOT NULL
);
-- Work belongs to its original goal; a scoped recovery Turn may create its first Work.
DROP TRIGGER work_items_require_goal_binding_insert;
DROP TRIGGER work_items_require_goal_binding_update;

CREATE TRIGGER work_items_require_goal_binding_insert
BEFORE INSERT ON work_items
WHEN NOT EXISTS (SELECT 1 FROM conversation_turns ct JOIN conversations c ON c.conversation_id=ct.conversation_id WHERE ct.turn_id=NEW.work_id AND c.workbench_id=NEW.workbench_id) AND NOT EXISTS (SELECT 1 FROM workspace_git_commands g WHERE g.command_id=NEW.work_id AND g.workbench_id=NEW.workbench_id) AND (
NEW.input_id IS NULL OR (
  NOT EXISTS (
    SELECT 1 FROM joi_turns t
    WHERE t.input_id = NEW.input_id AND t.workbench_id = NEW.workbench_id
  ) AND NOT EXISTS (
    SELECT 1 FROM joi_inbox_messages turn_input
    JOIN joi_turns t ON t.input_id = turn_input.input_id
    JOIN joi_inbox_messages goal ON goal.input_id = turn_input.goal_input_id
    WHERE turn_input.goal_input_id = NEW.input_id
      AND turn_input.workbench_id = NEW.workbench_id
      AND t.workbench_id = NEW.workbench_id
      AND goal.workbench_id = NEW.workbench_id
      AND goal.goal_input_id IS NULL
  )
)
)
BEGIN
  SELECT RAISE(ABORT, 'work_goal_binding_invalid');
END;

CREATE TRIGGER work_items_require_goal_binding_update
BEFORE UPDATE OF input_id, workbench_id ON work_items
WHEN NOT EXISTS (SELECT 1 FROM conversation_turns ct JOIN conversations c ON c.conversation_id=ct.conversation_id WHERE ct.turn_id=NEW.work_id AND c.workbench_id=NEW.workbench_id) AND NOT EXISTS (SELECT 1 FROM workspace_git_commands g WHERE g.command_id=NEW.work_id AND g.workbench_id=NEW.workbench_id) AND (
NEW.input_id IS NULL OR (
  NOT EXISTS (
    SELECT 1 FROM joi_turns t
    WHERE t.input_id = NEW.input_id AND t.workbench_id = NEW.workbench_id
  ) AND NOT EXISTS (
    SELECT 1 FROM joi_inbox_messages turn_input
    JOIN joi_turns t ON t.input_id = turn_input.input_id
    JOIN joi_inbox_messages goal ON goal.input_id = turn_input.goal_input_id
    WHERE turn_input.goal_input_id = NEW.input_id
      AND turn_input.workbench_id = NEW.workbench_id
      AND t.workbench_id = NEW.workbench_id
      AND goal.workbench_id = NEW.workbench_id
      AND goal.goal_input_id IS NULL
  )
)
)
BEGIN
  SELECT RAISE(ABORT, 'work_goal_binding_invalid');
END;
