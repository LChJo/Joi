CREATE TABLE IF NOT EXISTS scenario_pack_partner_bindings (
  pack_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pack_id, role_id),
  UNIQUE (partner_id),
  FOREIGN KEY (partner_id) REFERENCES partners(partner_id)
);

CREATE INDEX IF NOT EXISTS idx_scenario_pack_bindings_pack
  ON scenario_pack_partner_bindings(pack_id, role_id);
