ALTER TABLE joi_harness_maps ADD COLUMN desktop_retired_through_layer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE joi_harness_maps ADD COLUMN continuation_used INTEGER NOT NULL DEFAULT 0 CHECK (continuation_used >= 0);

-- The visible window counts the canonical path of each Work once.
CREATE VIEW joi_desktop_harness_paths AS
SELECT p.goal_input_id, p.layer, p.path_id FROM joi_harness_paths p
WHERE p.work_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM joi_harness_paths newer
  WHERE newer.goal_input_id = p.goal_input_id AND newer.work_id = p.work_id
    AND (newer.layer, newer.created_at, newer.path_id) > (p.layer, p.created_at, p.path_id)
);

UPDATE joi_harness_maps SET
  desktop_retired_through_layer = COALESCE((SELECT layer FROM joi_desktop_harness_paths
    WHERE goal_input_id = joi_harness_maps.goal_input_id GROUP BY layer ORDER BY layer DESC LIMIT 1 OFFSET 100), 0),
  continuation_used = COALESCE((SELECT MAX(layer) - 1 FROM joi_harness_paths
    WHERE goal_input_id = joi_harness_maps.goal_input_id), 0);

-- Adding another card to a populated layer cannot increase the number of visible layers.
CREATE TRIGGER goal_desktop_retire_layers_insert AFTER INSERT ON joi_harness_paths
WHEN NEW.layer > (SELECT desktop_retired_through_layer FROM joi_harness_maps WHERE goal_input_id = NEW.goal_input_id)
  AND NOT EXISTS (SELECT 1 FROM joi_desktop_harness_paths
    WHERE goal_input_id = NEW.goal_input_id AND layer = NEW.layer AND path_id <> NEW.path_id) BEGIN
  UPDATE joi_harness_maps SET desktop_retired_through_layer = COALESCE((
    SELECT layer FROM joi_desktop_harness_paths
    WHERE goal_input_id = NEW.goal_input_id AND layer > joi_harness_maps.desktop_retired_through_layer
    GROUP BY layer ORDER BY layer DESC LIMIT 1 OFFSET 100
  ), desktop_retired_through_layer) WHERE goal_input_id = NEW.goal_input_id;
END;

CREATE TRIGGER goal_desktop_retire_layers_update AFTER UPDATE OF layer, work_id ON joi_harness_paths
WHEN OLD.layer IS NOT NEW.layer OR OLD.work_id IS NOT NEW.work_id BEGIN
  UPDATE joi_harness_maps SET desktop_retired_through_layer = COALESCE((
    SELECT layer FROM joi_desktop_harness_paths
    WHERE goal_input_id = NEW.goal_input_id AND layer > joi_harness_maps.desktop_retired_through_layer
    GROUP BY layer ORDER BY layer DESC LIMIT 1 OFFSET 100
  ), desktop_retired_through_layer) WHERE goal_input_id = NEW.goal_input_id;
END;

CREATE TRIGGER goal_desktop_retire_layers_delete AFTER DELETE ON joi_harness_paths
WHEN OLD.work_id IS NOT NULL BEGIN
  UPDATE joi_harness_maps SET desktop_retired_through_layer = COALESCE((
    SELECT layer FROM joi_desktop_harness_paths
    WHERE goal_input_id = OLD.goal_input_id AND layer > joi_harness_maps.desktop_retired_through_layer
    GROUP BY layer ORDER BY layer DESC LIMIT 1 OFFSET 100
  ), desktop_retired_through_layer) WHERE goal_input_id = OLD.goal_input_id;
END;

ALTER TABLE work_items ADD COLUMN planned_by_turn_id TEXT REFERENCES joi_turns(turn_id) ON DELETE SET NULL;

-- The first dispatch plan owns the Work; reassignment and replay retain that origin.
UPDATE work_items SET planned_by_turn_id = (
  SELECT plan.turn_id FROM dispatch_attempts attempt
  JOIN dispatch_plans plan ON plan.dispatch_plan_id = attempt.dispatch_plan_id
  WHERE attempt.work_id = work_items.work_id ORDER BY attempt.rowid LIMIT 1
) WHERE input_id IS NOT NULL;

CREATE INDEX idx_work_items_planned_by_turn ON work_items(planned_by_turn_id, input_id)
  WHERE planned_by_turn_id IS NOT NULL;
