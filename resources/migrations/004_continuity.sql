CREATE TABLE life_agent_bindings (
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  agent_connection_id TEXT NOT NULL REFERENCES agent_connections(agent_connection_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('PRIMARY', 'COLLABORATOR')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (life_id, agent_connection_id)
);

INSERT OR IGNORE INTO life_agent_bindings (life_id, agent_connection_id, role, created_at)
SELECT life_id, main_agent_connection_id, 'PRIMARY', created_at FROM lives;

CREATE TABLE affairs (
  affair_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RUNNING', 'WAITING', 'DONE', 'FAILED', 'CANCELED')),
  waiting_reason TEXT CHECK (waiting_reason IS NULL OR waiting_reason IN ('HUMAN_INPUT', 'AUTH', 'AGENT_RESULT', 'TIME', 'BUDGET')),
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_affairs_life_status ON affairs(life_id, status, updated_at DESC);

CREATE TABLE todos (
  todo_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  affair_id TEXT REFERENCES affairs(affair_id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELED')),
  due_at TEXT,
  assignee TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_todos_life_due ON todos(life_id, status, due_at);

CREATE TABLE todo_occurrences (
  todo_id TEXT NOT NULL REFERENCES todos(todo_id) ON DELETE CASCADE,
  occurrence_at TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES life_events(event_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (todo_id, occurrence_at)
);

CREATE TABLE alarms (
  alarm_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  affair_id TEXT REFERENCES affairs(affair_id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  next_at TEXT NOT NULL,
  repeat_every_minutes INTEGER,
  status TEXT NOT NULL CHECK (status IN ('SCHEDULED', 'FIRED', 'CANCELED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_alarms_due ON alarms(status, next_at);

CREATE TABLE alarm_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  alarm_id TEXT NOT NULL REFERENCES alarms(alarm_id) ON DELETE CASCADE,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  occurrence_at TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES life_events(event_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (alarm_id, occurrence_at)
);

CREATE TABLE schedules (
  schedule_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  local_time TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_local_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (life_id, kind)
);

CREATE TRIGGER create_default_life_continuity AFTER INSERT ON lives BEGIN
  INSERT INTO life_agent_bindings (life_id, agent_connection_id, role, created_at)
  VALUES (NEW.life_id, NEW.main_agent_connection_id, 'PRIMARY', NEW.created_at);
  INSERT INTO schedules (schedule_id, life_id, kind, local_time, timezone, created_at, updated_at)
  VALUES
    ('schedule_morning_' || NEW.life_id, NEW.life_id, 'morning_plan', '08:00', NEW.timezone, NEW.created_at, NEW.created_at),
    ('schedule_evening_' || NEW.life_id, NEW.life_id, 'evening_review', '21:00', NEW.timezone, NEW.created_at, NEW.created_at),
    ('schedule_memory_' || NEW.life_id, NEW.life_id, 'memory_metabolism', '03:00', NEW.timezone, NEW.created_at, NEW.created_at);
END;

INSERT OR IGNORE INTO schedules (schedule_id, life_id, kind, local_time, timezone, created_at, updated_at)
SELECT 'schedule_morning_' || life_id, life_id, 'morning_plan', '08:00', timezone, created_at, updated_at FROM lives;
INSERT OR IGNORE INTO schedules (schedule_id, life_id, kind, local_time, timezone, created_at, updated_at)
SELECT 'schedule_evening_' || life_id, life_id, 'evening_review', '21:00', timezone, created_at, updated_at FROM lives;
INSERT OR IGNORE INTO schedules (schedule_id, life_id, kind, local_time, timezone, created_at, updated_at)
SELECT 'schedule_memory_' || life_id, life_id, 'memory_metabolism', '03:00', timezone, created_at, updated_at FROM lives;

CREATE TABLE memory_fragments (
  memory_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  affair_id TEXT REFERENCES affairs(affair_id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('EPISODIC', 'SEMANTIC', 'CARD')),
  content TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_event_id TEXT REFERENCES life_events(event_id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'FORGOTTEN')),
  last_accessed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE memory_fragments_fts USING fts5(
  content,
  content='memory_fragments',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER memory_fragments_ai AFTER INSERT ON memory_fragments BEGIN
  INSERT INTO memory_fragments_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;
CREATE TRIGGER memory_fragments_ad AFTER DELETE ON memory_fragments BEGIN
  INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
END;
CREATE TRIGGER memory_fragments_au AFTER UPDATE OF content ON memory_fragments BEGIN
  INSERT INTO memory_fragments_fts(memory_fragments_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
  INSERT INTO memory_fragments_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TABLE memory_revisions (
  memory_revision_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory_fragments(memory_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  previous_content TEXT NOT NULL,
  new_content TEXT NOT NULL,
  source_wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (memory_id, revision)
);

CREATE TABLE delegations (
  delegation_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  affair_id TEXT REFERENCES affairs(affair_id) ON DELETE SET NULL,
  agent_connection_id TEXT NOT NULL REFERENCES agent_connections(agent_connection_id) ON DELETE RESTRICT,
  source_wake_id TEXT NOT NULL REFERENCES wakes(wake_id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')),
  invocation_id TEXT REFERENCES invocations(invocation_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_budgets (
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  local_date TEXT NOT NULL,
  autonomous_wakes_used INTEGER NOT NULL DEFAULT 0,
  invocations_used INTEGER NOT NULL DEFAULT 0,
  idle_explorations_used INTEGER NOT NULL DEFAULT 0,
  autonomous_wakes_limit INTEGER NOT NULL DEFAULT 24,
  invocations_limit INTEGER NOT NULL DEFAULT 100,
  idle_explorations_limit INTEGER NOT NULL DEFAULT 3,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (life_id, local_date)
);

ALTER TABLE expressions ADD COLUMN deliver_after TEXT;
ALTER TABLE expressions ADD COLUMN delivered_at TEXT;
UPDATE expressions SET deliver_after = created_at, delivered_at = created_at;
CREATE INDEX idx_expressions_delivery ON expressions(delivered_at, deliver_after);
