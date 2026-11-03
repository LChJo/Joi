-- Local CLI partners (Claude Code / Codex) are driven by the same Agent SDK
-- runtime that the old MANA_SDK engine token represented; the specific CLI the
-- SDK spawns is recorded here so the legacy engine CHECK column is left intact
-- (no SQLite table rebuild) while the domain exposes three engines.
ALTER TABLE partner_revisions ADD COLUMN cli_protocol TEXT
  CHECK (cli_protocol IS NULL OR cli_protocol IN ('CLAUDE', 'CODEX'));

UPDATE partner_revisions SET cli_protocol = 'CLAUDE' WHERE engine = 'MANA_SDK' AND cli_protocol IS NULL;

ALTER TABLE partner_instances ADD COLUMN cli_protocol TEXT
  CHECK (cli_protocol IS NULL OR cli_protocol IN ('CLAUDE', 'CODEX'));

UPDATE partner_instances SET cli_protocol = 'CLAUDE' WHERE engine = 'MANA_SDK' AND cli_protocol IS NULL;
