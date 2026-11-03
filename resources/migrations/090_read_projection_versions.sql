-- Read caches observe only related committed facts; opaque tokens also distinguish writes after rollback.
CREATE TABLE read_projection_versions (
  projection_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL
);
INSERT INTO read_projection_versions VALUES ('method_learning_facts', lower(hex(randomblob(16))));

CREATE TABLE work_result_artifact_versions (
  result_id TEXT PRIMARY KEY REFERENCES work_results(result_id) ON DELETE CASCADE,
  revision TEXT NOT NULL
);
INSERT INTO work_result_artifact_versions SELECT result_id, lower(hex(randomblob(16))) FROM work_results;

CREATE TRIGGER work_result_artifact_version_insert AFTER INSERT ON work_results
BEGIN
  INSERT INTO work_result_artifact_versions VALUES (NEW.result_id, lower(hex(randomblob(16))));
END;
CREATE TRIGGER work_result_artifact_version_update AFTER UPDATE OF artifacts_json ON work_results
BEGIN
  UPDATE work_result_artifact_versions SET revision = lower(hex(randomblob(16))) WHERE result_id = NEW.result_id;
END;
CREATE TRIGGER work_result_artifact_version_delete AFTER DELETE ON work_results
BEGIN
  DELETE FROM work_result_artifact_versions WHERE result_id = OLD.result_id;
END;

CREATE TRIGGER projection_learning_work_results_insert AFTER INSERT ON work_results
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_results_update AFTER UPDATE OF result_id, work_id, run_id, workbench_id, status, created_at, is_authoritative, is_late ON work_results
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_results_delete AFTER DELETE ON work_results
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_result_verifications_insert AFTER INSERT ON work_result_verifications
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_result_verifications_update AFTER UPDATE ON work_result_verifications
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_result_verifications_delete AFTER DELETE ON work_result_verifications
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_partner_runs_insert AFTER INSERT ON partner_runs
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_partner_runs_update AFTER UPDATE OF run_id, requirements_revision, requirement_ids_json ON partner_runs
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_partner_runs_delete AFTER DELETE ON partner_runs
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_items_insert AFTER INSERT ON work_items
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_items_update AFTER UPDATE OF work_id, input_id, workbench_id, status ON work_items
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_items_delete AFTER DELETE ON work_items
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_inbox_messages_insert AFTER INSERT ON joi_inbox_messages
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_inbox_messages_update AFTER UPDATE OF input_id, workbench_id, body, updated_at, goal_input_id, status, canceled_at, dismissed_at, failed_at ON joi_inbox_messages
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_inbox_messages_delete AFTER DELETE ON joi_inbox_messages
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_workbenches_insert AFTER INSERT ON workbenches
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_workbenches_update AFTER UPDATE OF workbench_id, status ON workbenches
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_workbenches_delete AFTER DELETE ON workbenches
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_outcomes_insert AFTER INSERT ON joi_goal_outcomes
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_outcomes_update AFTER UPDATE ON joi_goal_outcomes
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_outcomes_delete AFTER DELETE ON joi_goal_outcomes
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirements_insert AFTER INSERT ON joi_goal_requirements
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirements_update AFTER UPDATE ON joi_goal_requirements
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirements_delete AFTER DELETE ON joi_goal_requirements
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirement_snapshots_insert AFTER INSERT ON joi_goal_requirement_snapshots
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirement_snapshots_update AFTER UPDATE ON joi_goal_requirement_snapshots
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirement_snapshots_delete AFTER DELETE ON joi_goal_requirement_snapshots
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_result_sets_insert AFTER INSERT ON joi_goal_result_sets
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_result_sets_update AFTER UPDATE ON joi_goal_result_sets
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_result_sets_delete AFTER DELETE ON joi_goal_result_sets
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_dependencies_insert AFTER INSERT ON work_dependencies
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_dependencies_update AFTER UPDATE ON work_dependencies
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_work_dependencies_delete AFTER DELETE ON work_dependencies
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_evidence_reads_insert AFTER INSERT ON method_learning_evidence_reads
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_evidence_reads_update AFTER UPDATE ON method_learning_evidence_reads
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_evidence_reads_delete AFTER DELETE ON method_learning_evidence_reads
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_turns_insert AFTER INSERT ON joi_turns
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_turns_update AFTER UPDATE OF input_id, status ON joi_turns
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_turns_delete AFTER DELETE ON joi_turns
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_harness_maps_insert AFTER INSERT ON joi_harness_maps
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_harness_maps_update AFTER UPDATE OF goal_input_id, status ON joi_harness_maps
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_harness_maps_delete AFTER DELETE ON joi_harness_maps
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirement_sources_insert AFTER INSERT ON joi_goal_requirement_sources
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirement_sources_update AFTER UPDATE ON joi_goal_requirement_sources
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_requirement_sources_delete AFTER DELETE ON joi_goal_requirement_sources
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_fact_receipts_insert AFTER INSERT ON method_learning_fact_receipts
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_fact_receipts_update AFTER UPDATE ON method_learning_fact_receipts
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_fact_receipts_delete AFTER DELETE ON method_learning_fact_receipts
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_cases_insert AFTER INSERT ON method_learning_cases
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_cases_update AFTER UPDATE ON method_learning_cases
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_cases_delete AFTER DELETE ON method_learning_cases
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_exposure_invalidations_insert AFTER INSERT ON method_learning_exposure_invalidations
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_exposure_invalidations_update AFTER UPDATE ON method_learning_exposure_invalidations
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_method_learning_exposure_invalidations_delete AFTER DELETE ON method_learning_exposure_invalidations
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_execution_gates_insert AFTER INSERT ON joi_goal_execution_gates
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_execution_gates_update AFTER UPDATE ON joi_goal_execution_gates
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;

CREATE TRIGGER projection_learning_joi_goal_execution_gates_delete AFTER DELETE ON joi_goal_execution_gates
BEGIN
  UPDATE read_projection_versions SET revision = lower(hex(randomblob(16))) WHERE projection_id = 'method_learning_facts';
END;
