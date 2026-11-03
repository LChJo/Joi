-- Activity probes traverse current operations independently of retained history.
CREATE INDEX idx_joi_turns_running ON joi_turns(input_id) WHERE status = 'RUNNING';

CREATE INDEX idx_work_items_foreground ON work_items(status, input_id, workbench_id, work_id)
  WHERE status IN ('PLANNED','READY','RUNNING','WAITING');

CREATE INDEX idx_dispatch_attempts_outbox ON dispatch_attempts(outbox_id) WHERE outbox_id IS NOT NULL;

CREATE INDEX idx_dispatch_attempts_active ON dispatch_attempts(work_id, partner_revision_id)
  WHERE status NOT IN ('COMPLETED','FAILED','WAITING_INPUT','WAITING_AUTH','UNKNOWN');

CREATE INDEX idx_partner_instances_live ON partner_instances(workbench_id, partner_id, status)
  WHERE status <> 'DISPOSED';

CREATE INDEX idx_partner_runs_active ON partner_runs(workbench_id, partner_revision_id)
  WHERE status NOT IN ('COMPLETED','FAILED','WAITING_INPUT','WAITING_AUTH','UNKNOWN');
