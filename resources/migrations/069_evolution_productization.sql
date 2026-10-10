ALTER TABLE evolution_evidence ADD COLUMN cause TEXT NOT NULL DEFAULT 'unknown'
  CHECK(cause IN ('none','context','completion','execution','environment','unknown'));

UPDATE evolution_evidence
SET cause = CASE
  WHEN outcome = 'VERIFIED' THEN 'none'
  WHEN outcome = 'ENVIRONMENT_FAILED' THEN 'environment'
  ELSE 'unknown'
END;
