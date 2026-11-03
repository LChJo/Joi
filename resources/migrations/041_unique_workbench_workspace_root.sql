-- Older releases accepted the same selected directory for multiple Workbenches.
-- Keep a deterministic owner and move every displaced binding back to a fresh
-- managed workspace before adding the invariant. Existing files are untouched.
CREATE TEMP TABLE duplicate_workspace_roots_041 AS
SELECT root_path, MIN(workspace_ref) AS keep_workspace_ref
  FROM workbench_workspace_roots
 GROUP BY root_path
HAVING COUNT(*) > 1;

CREATE TEMP TABLE displaced_workspace_roots_041 AS
SELECT r.workspace_ref, b.workbench_id
  FROM workbench_workspace_roots r
  JOIN duplicate_workspace_roots_041 d ON d.root_path = r.root_path
  JOIN workbench_workspace_bindings b ON b.workspace_ref = r.workspace_ref
 WHERE r.workspace_ref <> d.keep_workspace_ref;

DELETE FROM workbench_workspace_roots
 WHERE workspace_ref IN (SELECT workspace_ref FROM displaced_workspace_roots_041);

UPDATE workbench_workspace_bindings
   SET kind = 'MANAGED',
       status = 'PROVISIONING',
       failure_reason_code = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE workspace_ref IN (SELECT workspace_ref FROM displaced_workspace_roots_041);

INSERT OR IGNORE INTO outbox
  (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
SELECT 'workbench_workspace_repair_041:' || d.workbench_id,
       'workbench.workspace.provision',
       json_object('workbenchId', d.workbench_id, 'workspaceRef', d.workspace_ref),
       'PENDING', 0, updated_at, updated_at
  FROM displaced_workspace_roots_041 d
  JOIN workbench_workspace_bindings b ON b.workspace_ref = d.workspace_ref;

DROP TABLE displaced_workspace_roots_041;
DROP TABLE duplicate_workspace_roots_041;

CREATE UNIQUE INDEX IF NOT EXISTS idx_workbench_workspace_roots_root_path
  ON workbench_workspace_roots(root_path);
