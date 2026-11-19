CREATE INDEX idx_dispatch_attempts_instance_created
  ON dispatch_attempts(instance_id, created_at DESC, dispatch_attempt_id, work_id);

-- Work status and automatic path synchronization can change the displayed map
-- independently of the revision used to decide when Joi should review a goal.
ALTER TABLE joi_harness_maps ADD COLUMN detail_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE joi_harness_maps ADD COLUMN path_order_revision INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER goal_detail_path_insert AFTER INSERT ON joi_harness_paths BEGIN
  UPDATE joi_harness_maps SET detail_revision = detail_revision + 1, path_order_revision = path_order_revision + 1
  WHERE goal_input_id = NEW.goal_input_id;
END;

CREATE TRIGGER goal_detail_path_update
AFTER UPDATE OF layer, title, status, work_id, resolved_decision_id, created_at ON joi_harness_paths
WHEN OLD.layer IS NOT NEW.layer OR OLD.title IS NOT NEW.title OR OLD.status IS NOT NEW.status
  OR OLD.work_id IS NOT NEW.work_id OR OLD.resolved_decision_id IS NOT NEW.resolved_decision_id OR OLD.created_at IS NOT NEW.created_at BEGIN
  UPDATE joi_harness_maps SET detail_revision = detail_revision + 1,
    path_order_revision = path_order_revision + (OLD.layer IS NOT NEW.layer OR OLD.work_id IS NOT NEW.work_id OR OLD.created_at IS NOT NEW.created_at)
  WHERE goal_input_id = NEW.goal_input_id;
END;

CREATE TRIGGER goal_detail_path_delete AFTER DELETE ON joi_harness_paths BEGIN
  UPDATE joi_harness_maps SET detail_revision = detail_revision + 1, path_order_revision = path_order_revision + 1
  WHERE goal_input_id = OLD.goal_input_id;
END;

CREATE TRIGGER goal_detail_work_change AFTER UPDATE OF status ON work_items
WHEN OLD.status IS NOT NEW.status AND EXISTS (SELECT 1 FROM joi_harness_paths
  WHERE work_id = NEW.work_id AND goal_input_id = NEW.input_id) BEGIN
  UPDATE joi_harness_maps SET detail_revision = detail_revision + 1 WHERE goal_input_id = NEW.input_id;
END;
