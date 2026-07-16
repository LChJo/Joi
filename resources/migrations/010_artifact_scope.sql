ALTER TABLE artifacts ADD COLUMN life_id TEXT REFERENCES lives(life_id) ON DELETE CASCADE;
ALTER TABLE artifacts ADD COLUMN affair_id TEXT REFERENCES affairs(affair_id) ON DELETE SET NULL;

UPDATE artifacts
   SET life_id = COALESCE(
     (SELECT d.life_id FROM delegations d WHERE d.invocation_id = artifacts.invocation_id LIMIT 1),
     (SELECT w.life_id
        FROM wake_turns wt JOIN wakes w ON w.wake_id = wt.wake_id
       WHERE wt.invocation_id = artifacts.invocation_id LIMIT 1)
   ),
       affair_id = (SELECT d.affair_id FROM delegations d WHERE d.invocation_id = artifacts.invocation_id LIMIT 1);

CREATE INDEX idx_artifacts_life_affair ON artifacts(life_id, affair_id, created_at);
