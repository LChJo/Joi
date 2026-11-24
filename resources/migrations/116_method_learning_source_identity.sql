CREATE TABLE IF NOT EXISTS method_learning_sources (
  goal_id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  split TEXT NOT NULL CHECK(split IN ('development','sealed')),
  split_version INTEGER NOT NULL CHECK(split_version = 1)
) STRICT;
CREATE TABLE IF NOT EXISTS method_learning_legacy_sources (
  goal_id TEXT NOT NULL,
  workbench_id TEXT NOT NULL,
  legacy_group TEXT NOT NULL,
  split TEXT NOT NULL CHECK(split IN ('development','sealed')),
  PRIMARY KEY(legacy_group,goal_id,split)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_method_learning_legacy_root ON method_learning_legacy_sources(goal_id);

-- Old group labels prove a matching submitted request within a workbench. A
-- root links all of its own historical labels, including edits and reopenings.
WITH history(goal_id, workbench_id, legacy_group, split) AS (
    SELECT json_extract(case_json,'$.goalId'),workbench_id,group_id,json_extract(case_json,'$.split')
      FROM method_learning_cases
    UNION
    SELECT json_extract(c.value,'$.goalId'),json_extract(c.value,'$.workbenchId'),
      json_extract(c.value,'$.groupId'),json_extract(c.value,'$.split')
      FROM method_learning_experiments e,json_each(e.state_json,'$.state.dataset') c
  )
INSERT OR IGNORE INTO method_learning_legacy_sources
SELECT h.* FROM history h JOIN joi_inbox_messages i
  ON i.input_id=h.goal_id AND i.workbench_id=h.workbench_id AND i.goal_input_id IS NULL
WHERE h.legacy_group IS NOT NULL AND h.split IN ('development','sealed');

WITH RECURSIVE
  seen(legacy_group) AS (
    SELECT legacy_group FROM method_learning_legacy_sources WHERE split='development'
    UNION
    SELECT other.legacy_group FROM seen s JOIN method_learning_legacy_sources own ON own.legacy_group=s.legacy_group
      JOIN method_learning_legacy_sources other ON other.goal_id=own.goal_id
  ),
  reachable(root, peer, workbench_id) AS (
    SELECT DISTINCT goal_id,goal_id,workbench_id FROM method_learning_legacy_sources
    UNION
    SELECT r.root,other.goal_id,r.workbench_id FROM reachable r
      JOIN method_learning_legacy_sources own ON own.goal_id=r.peer
      JOIN method_learning_legacy_sources other ON other.legacy_group=own.legacy_group AND other.workbench_id=r.workbench_id
  )
INSERT OR IGNORE INTO method_learning_sources
SELECT r.root,'legacy:' || MIN(r.peer),
  CASE WHEN MAX(seen.legacy_group IS NOT NULL)=1 THEN 'development' ELSE 'sealed' END,1
FROM reachable r JOIN method_learning_legacy_sources k ON k.goal_id=r.peer
LEFT JOIN seen ON seen.legacy_group=k.legacy_group
GROUP BY r.root;

-- Previous reservations remain billed. Retire unfinished manifests with the
-- old split so a new run has a fresh identity and cannot reuse their trials.
UPDATE method_learning_calls SET completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE completed_at IS NULL AND call_id IN (
  SELECT json_extract(state_json,'$.state.pendingCall') FROM method_learning_experiments
  WHERE status IN ('RUNNING','PAUSED') AND json_extract(state_json,'$.state.version')=2
    AND json_extract(state_json,'$.state.splitVersion') IS NULL
);
UPDATE outbox SET status='DONE' WHERE kind='evolution.model' AND outbox_id IN (
  SELECT json_extract(state_json,'$.state.pendingCall') FROM method_learning_experiments
  WHERE status IN ('RUNNING','PAUSED') AND json_extract(state_json,'$.state.version')=2
    AND json_extract(state_json,'$.state.splitVersion') IS NULL
);
UPDATE method_learning_experiments
SET status='REJECTED',
    state_json=json_set(state_json,'$.status','REJECTED','$.state.reason','revalidation_required','$.state.pendingCall',NULL)
WHERE status IN ('RUNNING','PAUSED') AND json_extract(state_json,'$.state.version')=2
  AND json_extract(state_json,'$.state.splitVersion') IS NULL;
