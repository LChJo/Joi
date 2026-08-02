/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { AppendPartnerRevisionInput, PartnerRegistryRepository } from "../../application/ports/partner-registry.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import { mapStoredEngine, storageCliProtocol, storageEngine } from "./partner-engine-storage.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

const SELECT_REVISIONS = `SELECT p.partner_id, p.kind, p.created_by, r.status AS revision_status, r.partner_revision_id, r.registry_revision,
  r.display_name, r.capabilities_json, r.skills_json, r.tools_json, r.prompt_ref, r.workspace_ref,
  r.description, r.engine, r.cli_protocol, r.model_source_id, r.model_id_override, r.engine_model_id,
  r.provenance_json, r.created_at
  FROM partners p JOIN partner_revisions r ON r.partner_id = p.partner_id`;

function stringArray(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("partner_registry_record_invalid");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("partner_registry_record_invalid");
  return parsed as string[];
}

function rowText(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("partner_registry_record_invalid");
  return value;
}

function mapRow(row: Row): PartnerRevision {
  const registryRevision = row.registry_revision;
  const provenanceValue = row.provenance_json;
  if (typeof registryRevision !== "number" || typeof provenanceValue !== "string") throw new Error("partner_registry_record_invalid");
  const provenance: unknown = JSON.parse(provenanceValue);
  if (provenance === null || Array.isArray(provenance) || typeof provenance !== "object") throw new Error("partner_registry_record_invalid");
  const stored = provenance as Partial<PartnerRevision["provenance"]>;
  const promptRef = row.prompt_ref;
  const description = row.description;
  const engineModelId = row.engine_model_id;
  const modelIdOverride = row.model_id_override;
  const modelSourceId = row.model_source_id;
  return {
    capabilities: stringArray(row.capabilities_json),
    createdAt: rowText(row, "created_at"),
    createdBy: row.created_by === "JOI" ? "joi" : "user",
    ...(typeof description === "string" ? { description } : {}),
    displayName: rowText(row, "display_name"),
    engine: mapStoredEngine(row.engine, row.cli_protocol),
    ...(typeof engineModelId === "string" ? { engineModelId } : {}),
    kind: rowText(row, "kind") === "LOCAL_PI" ? "local-pi" : "a2a",
    ...(typeof modelIdOverride === "string" ? { modelIdOverride } : {}),
    ...(typeof modelSourceId === "string" ? { modelSourceId } : {}),
    partnerId: rowText(row, "partner_id"),
    partnerRevisionId: rowText(row, "partner_revision_id"),
    ...(typeof promptRef === "string" ? { promptRef } : {}),
    provenance: {
      capabilities: stored.capabilities ?? "local",
      description: stored.description ?? "local",
      displayName: stored.displayName ?? "local",
      skills: stored.skills ?? "local",
      tools: stored.tools ?? "local",
    },
    registryRevision,
    skills: stringArray(row.skills_json),
    status: rowText(row, "revision_status") as PartnerRevision["status"],
    tools: stringArray(row.tools_json),
  };
}

export class SqlitePartnerRegistryRepository implements PartnerRegistryRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async append(input: AppendPartnerRevisionInput): Promise<PartnerRevision> {
    return this.database.transaction((connection) => {
      const state = connection.prepare("SELECT registry_revision FROM partner_registry_state WHERE singleton_id = 1").get() as { registry_revision?: unknown } | undefined;
      if (typeof state?.registry_revision !== "number") throw new Error("partner_registry_state_invalid");
      const registryRevision = state.registry_revision + 1;
      connection.prepare("UPDATE partner_registry_state SET registry_revision = ?, updated_at = ? WHERE singleton_id = 1").run(registryRevision, input.createdAt);
      connection.prepare(`INSERT INTO partners
        (partner_id, legacy_agent_connection_id, kind, status, created_by, active_revision_id, created_at, updated_at)
        VALUES (?, NULL, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(partner_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`).run(
        input.partnerId, input.kind === "local-pi" ? "LOCAL_PI" : "A2A", input.status,
        input.createdBy === "joi" ? "JOI" : "USER", input.createdAt, input.createdAt,
      );
      connection.prepare(`INSERT INTO partner_revisions
        (partner_revision_id, partner_id, registry_revision, display_name, capabilities_json, skills_json,
         tools_json, prompt_ref, workspace_ref, execution_policy_json, provenance_json, status, created_at,
         description, engine, cli_protocol, model_source_id, model_id_override, engine_model_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.partnerRevisionId, input.partnerId, registryRevision, input.displayName,
        JSON.stringify(input.capabilities), JSON.stringify(input.skills), JSON.stringify(input.tools),
        input.promptRef ?? null, null,
        JSON.stringify({ transport: input.kind, localOverridesWin: true }), JSON.stringify(input.provenance), input.status, input.createdAt,
        input.description ?? null, storageEngine(input.engine), storageCliProtocol(input.engine),
        input.modelSourceId ?? null, input.modelIdOverride ?? null, input.engineModelId ?? null,
      );
      connection.prepare("UPDATE partners SET active_revision_id = ? WHERE partner_id = ?").run(input.partnerRevisionId, input.partnerId);
      return { ...input, registryRevision };
    });
  }

  async getActive(partnerId: string): Promise<PartnerRevision | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      `${SELECT_REVISIONS} WHERE p.partner_id = ? AND r.partner_revision_id = p.active_revision_id`,
    ).get(partnerId)) as Row | undefined;
    return row === undefined ? null : mapRow(row);
  }

  async countInFlight(partnerId: string): Promise<number> {
    return this.database.transaction((connection) => {
      const row = connection.prepare(`SELECT COUNT(*) AS count
        FROM dispatch_attempts d JOIN partner_revisions r ON r.partner_revision_id = d.partner_revision_id
        WHERE r.partner_id = ? AND d.status IN
          ('PENDING', 'DISPATCHED', 'ACCEPTED', 'RUNNING', 'WAITING_INPUT', 'WAITING_AUTH', 'UNKNOWN')`
      ).get(partnerId) as { count: number };
      return row.count;
    });
  }

  async getRevision(partnerRevisionId: string): Promise<PartnerRevision | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      `${SELECT_REVISIONS} WHERE r.partner_revision_id = ?`,
    ).get(partnerRevisionId)) as Row | undefined;
    return row === undefined ? null : mapRow(row);
  }

  async listActive(): Promise<PartnerRevision[]> {
    return this.database.transaction((connection) => connection.prepare(
      `${SELECT_REVISIONS} WHERE r.partner_revision_id = p.active_revision_id AND p.status <> 'DELETED' ORDER BY r.registry_revision`,
    ).all()).map((row) => mapRow(row as Row));
  }
}
