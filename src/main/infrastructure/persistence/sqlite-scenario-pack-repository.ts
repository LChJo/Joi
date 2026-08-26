/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { ScenarioPackBinding, ScenarioPackRepository } from "../../application/ports/scenario-packs.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

interface Row {
  definition_version: number;
  installed_at: string;
  pack_id: string;
  partner_id: string;
  role_id: string;
  updated_at: string;
}

function mapRow(row: Row): ScenarioPackBinding {
  return {
    definitionVersion: row.definition_version,
    installedAt: row.installed_at,
    packId: row.pack_id,
    partnerId: row.partner_id,
    roleId: row.role_id,
    updatedAt: row.updated_at,
  };
}

export class SqliteScenarioPackRepository implements ScenarioPackRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async find(packId: string, roleId: string): Promise<ScenarioPackBinding | null> {
    const row = this.database.transaction((connection) => connection.prepare(`SELECT pack_id, role_id, partner_id,
      definition_version, installed_at, updated_at FROM scenario_pack_partner_bindings WHERE pack_id = ? AND role_id = ?`
    ).get(packId, roleId)) as Row | undefined;
    return row === undefined ? null : mapRow(row);
  }

  async list(packId: string): Promise<ScenarioPackBinding[]> {
    const rows = this.database.transaction((connection) => connection.prepare(`SELECT pack_id, role_id, partner_id,
      definition_version, installed_at, updated_at FROM scenario_pack_partner_bindings WHERE pack_id = ? ORDER BY role_id`
    ).all(packId)) as unknown as Row[];
    return rows.map(mapRow);
  }

  async save(binding: ScenarioPackBinding): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`INSERT INTO scenario_pack_partner_bindings
      (pack_id, role_id, partner_id, definition_version, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pack_id, role_id) DO UPDATE SET partner_id = excluded.partner_id,
        definition_version = excluded.definition_version, updated_at = excluded.updated_at`
    ).run(binding.packId, binding.roleId, binding.partnerId, binding.definitionVersion, binding.installedAt, binding.updatedAt));
  }
}
