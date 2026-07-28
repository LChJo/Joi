/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { AppendPartnerRevisionInput, PartnerRegistryRepository } from "../../application/ports/partner-registry.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

const SELECT_REVISIONS = `SELECT p.partner_id, p.kind, p.status, r.partner_revision_id, r.registry_revision,
  r.display_name, r.capabilities_json, r.skills_json, r.tools_json, r.prompt_ref, r.workspace_ref,
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
  const promptRef = row.prompt_ref;
  const workspaceRef = row.workspace_ref;
  return {
    capabilities: stringArray(row.capabilities_json),
    createdAt: rowText(row, "created_at"),
    displayName: rowText(row, "display_name"),
    kind: rowText(row, "kind") === "LOCAL_PI" ? "local-pi" : "a2a",
    partnerId: rowText(row, "partner_id"),
    partnerRevisionId: rowText(row, "partner_revision_id"),
    ...(typeof promptRef === "string" ? { promptRef } : {}),
    provenance: provenance as PartnerRevision["provenance"],
    registryRevision,
    skills: stringArray(row.skills_json),
    status: rowText(row, "status") as PartnerRevision["status"],
    tools: stringArray(row.tools_json),
    ...(typeof workspaceRef === "string" ? { workspaceRef } : {}),
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
        (partner_id, legacy_agent_connection_id, kind, status, active_revision_id, created_at, updated_at)
        VALUES (?, NULL, ?, ?, NULL, ?, ?)
        ON CONFLICT(partner_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`).run(
        input.partnerId, input.kind === "local-pi" ? "LOCAL_PI" : "A2A", input.status, input.createdAt, input.createdAt,
      );
      connection.prepare(`INSERT INTO partner_revisions
        (partner_revision_id, partner_id, registry_revision, display_name, capabilities_json, skills_json,
         tools_json, prompt_ref, workspace_ref, execution_policy_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.partnerRevisionId, input.partnerId, registryRevision, input.displayName,
        JSON.stringify(input.capabilities), JSON.stringify(input.skills), JSON.stringify(input.tools),
        input.promptRef ?? null, input.workspaceRef ?? null,
        JSON.stringify({ transport: input.kind, localOverridesWin: true }), JSON.stringify(input.provenance), input.createdAt,
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

  async getRevision(partnerRevisionId: string): Promise<PartnerRevision | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      `${SELECT_REVISIONS} WHERE r.partner_revision_id = ?`,
    ).get(partnerRevisionId)) as Row | undefined;
    return row === undefined ? null : mapRow(row);
  }

  async listActive(): Promise<PartnerRevision[]> {
    return this.database.transaction((connection) => connection.prepare(
      `${SELECT_REVISIONS} WHERE r.partner_revision_id = p.active_revision_id ORDER BY r.registry_revision`,
    ).all()).map((row) => mapRow(row as Row));
  }
}
