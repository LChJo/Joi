-- The 10-second harness/evolution safety scans are read-heavy and query by goal/work identity.
-- Keep those lookups bounded without changing their recovery cadence.
CREATE INDEX idx_joi_turns_input_status_effect
  ON joi_turns(input_id, status, side_effect_started);

CREATE INDEX idx_work_items_input_status
  ON work_items(input_id, status, work_id);

CREATE INDEX idx_joi_harness_maps_status_updated
  ON joi_harness_maps(status, updated_at, goal_input_id);

CREATE INDEX idx_joi_harness_paths_work
  ON joi_harness_paths(work_id) WHERE work_id IS NOT NULL;

CREATE INDEX idx_partner_result_events_work
  ON partner_result_events(work_id, run_id, status, event_id);

CREATE INDEX idx_work_results_authoritative_work_created
  ON work_results(work_id, created_at DESC, result_id DESC)
  WHERE is_authoritative = 1 AND is_late = 0;
