ALTER TABLE workspace_write_waiters ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'WRITE'
  CHECK (access_mode IN ('READ','WRITE'));

CREATE TRIGGER workspace_lease_released_wake AFTER DELETE ON workspace_leases BEGIN
  UPDATE outbox SET available_at=MIN(available_at,created_at)
    WHERE status='PENDING' AND (
      outbox_id IN (
        SELECT a.outbox_id FROM dispatch_attempts a JOIN workspace_write_waiters w ON w.work_id=a.work_id
        WHERE w.root_key=OLD.root_key
          OR instr(replace(w.root_key,char(92),'/'),rtrim(replace(OLD.root_key,char(92),'/'),'/')||'/')=1
          OR instr(replace(OLD.root_key,char(92),'/'),rtrim(replace(w.root_key,char(92),'/'),'/')||'/')=1)
      OR (kind='partner.continue' AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.workId') IN (
        SELECT w.work_id FROM workspace_write_waiters w WHERE w.root_key=OLD.root_key
          OR instr(replace(w.root_key,char(92),'/'),rtrim(replace(OLD.root_key,char(92),'/'),'/')||'/')=1
          OR instr(replace(OLD.root_key,char(92),'/'),rtrim(replace(w.root_key,char(92),'/'),'/')||'/')=1)));
END;

CREATE TRIGGER workspace_waiter_removed_wake AFTER DELETE ON workspace_write_waiters BEGIN
  UPDATE outbox SET available_at=MIN(available_at,created_at)
    WHERE status='PENDING' AND (
      outbox_id IN (
        SELECT a.outbox_id FROM dispatch_attempts a JOIN workspace_write_waiters w ON w.work_id=a.work_id
        WHERE w.root_key=OLD.root_key
          OR instr(replace(w.root_key,char(92),'/'),rtrim(replace(OLD.root_key,char(92),'/'),'/')||'/')=1
          OR instr(replace(OLD.root_key,char(92),'/'),rtrim(replace(w.root_key,char(92),'/'),'/')||'/')=1)
      OR (kind='partner.continue' AND json_extract(CASE WHEN json_valid(payload_json) THEN payload_json ELSE '{}' END,'$.workId') IN (
        SELECT w.work_id FROM workspace_write_waiters w WHERE w.root_key=OLD.root_key
          OR instr(replace(w.root_key,char(92),'/'),rtrim(replace(OLD.root_key,char(92),'/'),'/')||'/')=1
          OR instr(replace(OLD.root_key,char(92),'/'),rtrim(replace(w.root_key,char(92),'/'),'/')||'/')=1)));
END;

CREATE TRIGGER workspace_goal_paused_queue AFTER UPDATE OF status ON joi_goal_execution_gates
WHEN NEW.status<>'OPEN' BEGIN
  DELETE FROM workspace_write_waiters WHERE work_id IN (
    SELECT w.work_id FROM work_items w JOIN joi_inbox_messages i ON i.input_id=w.input_id
    WHERE COALESCE(i.goal_input_id,i.input_id)=NEW.goal_input_id);
END;

CREATE TRIGGER workspace_goal_closed_queue AFTER INSERT ON joi_goal_execution_gates
WHEN NEW.status<>'OPEN' BEGIN
  DELETE FROM workspace_write_waiters WHERE work_id IN (
    SELECT w.work_id FROM work_items w JOIN joi_inbox_messages i ON i.input_id=w.input_id
    WHERE COALESCE(i.goal_input_id,i.input_id)=NEW.goal_input_id);
END;

CREATE TRIGGER workspace_terminal_queue AFTER UPDATE OF status ON work_items
WHEN NEW.status IN ('COMPLETED','FAILED','CANCELED','WAITING') BEGIN
  DELETE FROM workspace_write_waiters WHERE work_id=NEW.work_id;
END;
