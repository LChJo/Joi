-- Workbenches isolate context, not filesystem ownership. Multiple Workbenches
-- may intentionally point at one existing project directory. Runtime READ/WRITE
-- safety is enforced by workspace leases across every ref for the same root.
DROP INDEX IF EXISTS idx_workbench_workspace_roots_root_path;
CREATE INDEX IF NOT EXISTS idx_workbench_workspace_roots_path
  ON workbench_workspace_roots(root_path);
