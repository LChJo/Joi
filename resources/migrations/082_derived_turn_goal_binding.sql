-- Work belongs to its original goal; a scoped recovery Turn may create its first Work.
DROP TRIGGER work_items_require_goal_binding_insert;
DROP TRIGGER work_items_require_goal_binding_update;

CREATE TRIGGER work_items_require_goal_binding_insert
BEFORE INSERT ON work_items
WHEN NEW.input_id IS NULL OR (
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
BEGIN
  SELECT RAISE(ABORT, 'work_goal_binding_invalid');
END;

CREATE TRIGGER work_items_require_goal_binding_update
BEFORE UPDATE OF input_id, workbench_id ON work_items
WHEN NEW.input_id IS NULL OR (
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
BEGIN
  SELECT RAISE(ABORT, 'work_goal_binding_invalid');
END;
