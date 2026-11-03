-- joi:migration foreign-keys-off
-- Rename the active persistent-context schema while preserving every stable row id.

DROP TRIGGER mirror_new_life_as_avatar;
DROP TRIGGER mirror_life_update_to_avatar;
DROP TRIGGER initialize_new_avatar_private_context;

DROP INDEX idx_avatar_agent_entries_agent_sequence;
DROP INDEX idx_avatar_agent_sessions_avatar_created;
DROP INDEX idx_avatar_change_pending;
DROP INDEX idx_avatar_context_snapshots_work;
DROP INDEX idx_avatar_partner_work_memories_scope;
DROP INDEX idx_partner_instances_avatar_partner;
DROP INDEX idx_partner_runs_avatar_status;
DROP INDEX idx_work_items_avatar_status;
DROP INDEX idx_work_results_authoritative_avatar_created;
DROP INDEX idx_work_results_avatar_created;

ALTER TABLE avatars RENAME TO workbenches;
ALTER TABLE avatar_partner_policies RENAME TO workbench_partner_policies;
ALTER TABLE avatar_change_requests RENAME TO workbench_change_requests;
ALTER TABLE avatar_merges RENAME TO workbench_merges;
ALTER TABLE avatar_workspace_bindings RENAME TO workbench_workspace_bindings;
ALTER TABLE avatar_persona_revisions RENAME TO workbench_persona_revisions;
ALTER TABLE avatar_workspace_roots RENAME TO workbench_workspace_roots;
ALTER TABLE avatar_task_projections RENAME TO workbench_task_projections;
ALTER TABLE avatar_context_snapshots RENAME TO workbench_context_snapshots;
ALTER TABLE avatar_partner_work_memories RENAME TO workbench_partner_work_memories;
ALTER TABLE avatar_partner_work_memory_summaries RENAME TO workbench_partner_work_memory_summaries;
ALTER TABLE avatar_agent_sessions RENAME TO workbench_agent_sessions;
ALTER TABLE avatar_agent_conversation_entries RENAME TO workbench_agent_conversation_entries;

ALTER TABLE workbenches RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE workbench_partner_policies RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE workbench_change_requests RENAME COLUMN source_avatar_id TO source_workbench_id;
ALTER TABLE workbench_change_requests RENAME COLUMN target_avatar_id TO target_workbench_id;
ALTER TABLE workbench_merges RENAME COLUMN source_avatar_id TO source_workbench_id;
ALTER TABLE workbench_merges RENAME COLUMN target_avatar_id TO target_workbench_id;
ALTER TABLE workbench_workspace_bindings RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE workbench_persona_revisions RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE workbench_task_projections RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE workbench_context_snapshots RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE workbench_partner_work_memories RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE workbench_partner_work_memory_summaries RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE workbench_agent_sessions RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE joi_harness_maps RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE joi_inbox_messages RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE joi_session_messages RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE joi_turns RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE partner_instances RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE partner_result_events RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE partner_runs RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE work_items RENAME COLUMN avatar_id TO workbench_id;
ALTER TABLE work_results RENAME COLUMN avatar_id TO workbench_id;

CREATE TABLE joi_harness_decisions_038 (
  decision_id TEXT PRIMARY KEY,
  goal_input_id TEXT NOT NULL REFERENCES joi_harness_maps(goal_input_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('APPROACH', 'SCOPE', 'OUT_OF_SCOPE', 'WORKBENCH_REFINE')),
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  turn_id TEXT REFERENCES joi_turns(turn_id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
INSERT INTO joi_harness_decisions_038
  (decision_id, goal_input_id, kind, summary, detail, turn_id, created_at)
SELECT decision_id, goal_input_id,
       CASE kind WHEN 'AVATAR_REFINE' THEN 'WORKBENCH_REFINE' ELSE kind END,
       summary, detail, turn_id, created_at
  FROM joi_harness_decisions;
DROP TABLE joi_harness_decisions;
ALTER TABLE joi_harness_decisions_038 RENAME TO joi_harness_decisions;

CREATE INDEX idx_workbench_agent_entries_agent_sequence
  ON workbench_agent_conversation_entries(agent_id, sequence, entry_id);
CREATE INDEX idx_workbench_agent_sessions_workbench_created
  ON workbench_agent_sessions(workbench_id, created_at DESC, agent_id DESC);
CREATE INDEX idx_workbench_change_pending
  ON workbench_change_requests(status, created_at, request_id);
CREATE INDEX idx_workbench_context_snapshots_work
  ON workbench_context_snapshots(workbench_id, work_id, created_at DESC);
CREATE INDEX idx_workbench_partner_work_memories_scope
  ON workbench_partner_work_memories(workbench_id, partner_id, created_at DESC);
CREATE INDEX idx_partner_instances_workbench_partner
  ON partner_instances(workbench_id, partner_id, status);
CREATE INDEX idx_partner_runs_workbench_status
  ON partner_runs(workbench_id, status, created_at);
CREATE INDEX idx_work_items_workbench_status
  ON work_items(workbench_id, status, created_at);
CREATE INDEX idx_work_results_authoritative_workbench_created
  ON work_results(workbench_id, is_authoritative, created_at DESC, result_id DESC);
CREATE INDEX idx_work_results_workbench_created
  ON work_results(workbench_id, created_at DESC, result_id DESC);
CREATE INDEX idx_joi_harness_decisions_goal
  ON joi_harness_decisions(goal_input_id, created_at, decision_id);

CREATE TRIGGER mirror_new_life_as_workbench
AFTER INSERT ON lives
BEGIN
  INSERT OR IGNORE INTO workbenches
    (workbench_id, legacy_life_id, name, persona_revision_id, persona_summary, scope_summary,
     project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
  VALUES (
    NEW.life_id, NEW.life_id, NEW.name, NEW.current_persona_version_id,
    COALESCE((SELECT summary FROM persona_versions WHERE persona_version_id = NEW.current_persona_version_id), ''),
    NEW.name, NEW.name, 'memory_' || NEW.life_id, '',
    CASE WHEN NEW.archived_at IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END,
    NEW.created_at, NEW.updated_at
  );
END;

CREATE TRIGGER mirror_life_update_to_workbench
AFTER UPDATE OF name, current_persona_version_id, archived_at, updated_at ON lives
BEGIN
  INSERT OR IGNORE INTO workbenches
    (workbench_id, legacy_life_id, name, persona_revision_id, persona_summary, scope_summary,
     project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
  SELECT NEW.life_id, NEW.life_id, NEW.name, NEW.current_persona_version_id,
         COALESCE((SELECT summary FROM persona_versions WHERE persona_version_id = NEW.current_persona_version_id), ''),
         NEW.name, NEW.name, 'memory_' || NEW.life_id, '',
         CASE WHEN NEW.archived_at IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END,
         NEW.created_at, NEW.updated_at
   WHERE NEW.current_persona_version_id IS NOT NULL;
  UPDATE workbenches
     SET name = NEW.name,
         persona_revision_id = NEW.current_persona_version_id,
         persona_summary = COALESCE((SELECT summary FROM persona_versions WHERE persona_version_id = NEW.current_persona_version_id), persona_summary),
         scope_summary = CASE WHEN scope_summary = OLD.name THEN NEW.name ELSE scope_summary END,
         project_label = CASE WHEN project_label = OLD.name THEN NEW.name ELSE project_label END,
         status = CASE WHEN NEW.archived_at IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END,
         updated_at = NEW.updated_at
   WHERE legacy_life_id = NEW.life_id;
END;

CREATE TRIGGER initialize_new_workbench_private_context
AFTER INSERT ON workbenches
WHEN NEW.status = 'ACTIVE'
BEGIN
  INSERT OR IGNORE INTO workbench_persona_revisions
    (persona_revision_id, workbench_id, body, created_at)
  VALUES (NEW.persona_revision_id, NEW.workbench_id, NEW.persona_summary, NEW.created_at);

  INSERT OR IGNORE INTO workbench_workspace_bindings
    (workbench_id, workspace_ref, kind, status, display_name, created_at, updated_at)
  VALUES (NEW.workbench_id, 'workbench_workspace:' || NEW.workbench_id, 'MANAGED', 'PROVISIONING',
          NEW.name || ' 工作区', NEW.created_at, NEW.updated_at);

  INSERT OR IGNORE INTO workbench_task_projections
    (workbench_id, active_work_json, recent_results_json, updated_at)
  VALUES (NEW.workbench_id, '[]', '[]', NEW.updated_at);

  INSERT OR IGNORE INTO outbox
    (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
  VALUES ('workbench_workspace_provision:' || NEW.workbench_id,
          'workbench.workspace.provision',
          json_object('workbenchId', NEW.workbench_id, 'workspaceRef', 'workbench_workspace:' || NEW.workbench_id),
          'PENDING', 0, NEW.updated_at, NEW.created_at);
END;

UPDATE outbox
   SET kind = 'workbench.workspace.provision',
       payload_json = json_set(
         json_remove(payload_json, '$.avatarId'),
         '$.workbenchId', json_extract(payload_json, '$.avatarId')
       )
 WHERE kind = 'avatar.workspace.provision';

UPDATE joi_inbox_messages
   SET clarification_reason_code = replace(clarification_reason_code, 'avatar', 'workbench')
 WHERE clarification_reason_code LIKE 'avatar%';

UPDATE joi_goal_outcomes
   SET completion_summary = '历史工作已完成；Agent 结果可在工作台详情中查看。'
 WHERE completion_summary = '历史工作已完成；Agent 结果可在 Avatar 详情中查看。';
