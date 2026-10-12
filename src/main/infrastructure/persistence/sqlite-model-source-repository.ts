/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { ModelSourceHealthRevision, ModelSourceRecord, ModelSourceRepository } from "../../application/ports/model-source-ports.js";
import type { ModelCapability, ModelSourceAccessMode, ModelSourceKind, ModelSourceProtocol, ModelSourceStatus } from "../../domain/model-sources/model-source.js";
import type { ThinkingEffort } from "../../../shared/joi.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

const SELECT_RECORDS = `
  SELECT s.source_id, s.status, s.created_at, s.updated_at,
         sr.source_revision_id, sr.kind, sr.access_mode, sr.protocol, sr.display_name, sr.base_url,
         sr.credential_ref, sr.credential_version, sr.created_at AS source_revision_created_at,
         mr.model_revision_id, mr.model_id, mr.capability, mr.preset_version,
         mr.context_window, mr.max_output_tokens, mr.compaction_threshold_percent, mr.thinking_effort,
         mr.created_at AS model_revision_created_at,
         (SELECT p.proven_at FROM model_source_tool_proofs p
           WHERE p.source_revision_id = sr.source_revision_id AND p.model_revision_id = mr.model_revision_id) AS tool_proof_at,
         h.reason_code, h.last_error, h.last_validated_at, h.anthropic_auth_mode, o.position, o.is_primary
    FROM model_sources s
    JOIN model_source_revisions sr ON sr.source_revision_id = s.active_source_revision_id
    JOIN model_source_model_revisions mr ON mr.model_revision_id = s.active_model_revision_id
    JOIN model_source_health h ON h.source_id = s.source_id
    JOIN model_source_order o ON o.source_id = s.source_id`;

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new Error("model_source_record_invalid");
  return value;
}

function integer(row: Row, field: string): number {
  const value = row[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("model_source_record_invalid");
  return value;
}

function optionalText(row: Row, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("model_source_record_invalid");
  return value;
}

/** NULL is the "not configured" state for the per-model size limits, so unlike `integer` this
 *  treats it as absent rather than as corruption. */
function optionalInteger(row: Row, field: string): number | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("model_source_record_invalid");
  return value;
}

function isLocal(baseUrl: string | undefined): boolean {
  if (baseUrl === undefined) return false;
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    throw new Error("model_source_record_invalid");
  }
}

function mapRow(row: Row): ModelSourceRecord {
  const baseUrl = optionalText(row, "base_url");
  const lastError = optionalText(row, "last_error");
  const reasonCode = optionalText(row, "reason_code");
  const lastValidatedAt = optionalText(row, "last_validated_at");
  const presetVersion = optionalText(row, "preset_version");
  const toolProofAt = optionalText(row, "tool_proof_at");
  const contextWindow = optionalInteger(row, "context_window");
  const maxOutputTokens = optionalInteger(row, "max_output_tokens");
  const compactionThresholdPercent = optionalInteger(row, "compaction_threshold_percent");
  const thinkingEffort = optionalText(row, "thinking_effort");
  const anthropicAuthMode = optionalText(row, "anthropic_auth_mode");
  return {
    ...(anthropicAuthMode === "bearer" ? { anthropicAuthMode } : {}),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastValidatedAt === undefined ? {} : { lastValidatedAt }),
    local: isLocal(baseUrl),
    order: integer(row, "position"),
    ...(presetVersion === undefined ? {} : { presetVersion }),
    primary: integer(row, "is_primary") === 1,
    ...(reasonCode === undefined ? {} : { reasonCode }),
    source: {
      activeModelRevision: {
        capability: text(row, "capability") as ModelCapability,
        ...(compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        createdAt: text(row, "model_revision_created_at"),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
        modelId: text(row, "model_id"),
        modelRevisionId: text(row, "model_revision_id"),
        ...(thinkingEffort === undefined ? {} : { thinkingEffort: thinkingEffort as ThinkingEffort }),
      },
      activeSourceRevision: {
        accessMode: text(row, "access_mode") as ModelSourceAccessMode,
        createdAt: text(row, "source_revision_created_at"),
        credentialRef: text(row, "credential_ref"),
        credentialVersion: integer(row, "credential_version"),
        displayName: text(row, "display_name"),
        kind: text(row, "kind") as ModelSourceKind,
        protocol: text(row, "protocol") as ModelSourceProtocol,
        sourceRevisionId: text(row, "source_revision_id"),
      },
      createdAt: text(row, "created_at"),
      sourceId: text(row, "source_id"),
      status: text(row, "status") as ModelSourceStatus,
      ...(toolProofAt === undefined ? {} : { toolProofAt }),
      updatedAt: text(row, "updated_at"),
    },
  };
}

export class SqliteModelSourceRepository implements ModelSourceRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async create(record: ModelSourceRecord): Promise<void> {
    this.database.transaction((connection) => {
      const source = record.source;
        connection.prepare(`INSERT INTO model_sources
          (source_id, status, active_source_revision_id, active_model_revision_id, created_at, updated_at)
          VALUES (?, ?, NULL, NULL, ?, ?)`).run(source.sourceId, source.status, source.createdAt, source.updatedAt);
        connection.prepare(`INSERT INTO model_source_revisions
          (source_revision_id, source_id, kind, access_mode, protocol, display_name, base_url, credential_ref, credential_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          source.activeSourceRevision.sourceRevisionId, source.sourceId, source.activeSourceRevision.kind,
          source.activeSourceRevision.accessMode, source.activeSourceRevision.protocol, source.activeSourceRevision.displayName, record.baseUrl ?? null, source.activeSourceRevision.credentialRef,
          source.activeSourceRevision.credentialVersion, source.activeSourceRevision.createdAt,
        );
        connection.prepare(`INSERT INTO model_source_model_revisions
          (model_revision_id, source_id, model_id, capability, preset_version,
           context_window, max_output_tokens, compaction_threshold_percent, thinking_effort, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          source.activeModelRevision.modelRevisionId, source.sourceId, source.activeModelRevision.modelId,
          source.activeModelRevision.capability, record.presetVersion ?? null,
          source.activeModelRevision.contextWindow ?? null,
          source.activeModelRevision.maxOutputTokens ?? null,
          source.activeModelRevision.compactionThresholdPercent ?? null,
          source.activeModelRevision.thinkingEffort ?? null,
          source.activeModelRevision.createdAt,
        );
        connection.prepare(`UPDATE model_sources SET active_source_revision_id = ?, active_model_revision_id = ? WHERE source_id = ?`).run(
          source.activeSourceRevision.sourceRevisionId, source.activeModelRevision.modelRevisionId, source.sourceId,
        );
        connection.prepare(`INSERT INTO model_source_health
          (source_id, status, reason_code, last_error, last_validated_at, updated_at, anthropic_auth_mode) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          source.sourceId, source.status, record.reasonCode ?? null, record.lastError ?? null, record.lastValidatedAt ?? null, source.updatedAt, record.anthropicAuthMode ?? null,
        );
        connection.prepare(`INSERT INTO model_source_order (source_id, position, is_primary) VALUES (?, ?, ?)`).run(
          source.sourceId, record.order, record.primary ? 1 : 0,
        );
    });
  }

  async get(sourceId: string): Promise<ModelSourceRecord | null> {
    const row = this.database.transaction((connection) => connection.prepare(`${SELECT_RECORDS} WHERE s.source_id = ?`).get(sourceId)) as Row | undefined;
    return row === undefined ? null : mapRow(row);
  }

  async list(): Promise<ModelSourceRecord[]> {
    return this.database.transaction((connection) => connection.prepare(`${SELECT_RECORDS} ORDER BY o.position`).all())
      .map((row) => mapRow(row as Row));
  }

  async save(record: ModelSourceRecord): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare("UPDATE model_sources SET status = ?, updated_at = ? WHERE source_id = ?").run(
        record.source.status, record.source.updatedAt, record.source.sourceId,
      );
      connection.prepare(`UPDATE model_source_health
        SET status = ?, reason_code = ?, last_error = ?, last_validated_at = ?, updated_at = ?, anthropic_auth_mode = ? WHERE source_id = ?`).run(
        record.source.status, record.reasonCode ?? null, record.lastError ?? null, record.lastValidatedAt ?? null,
        record.source.updatedAt, record.anthropicAuthMode ?? null, record.source.sourceId,
      );
    });
  }

  async saveHealthIfCurrent(record: ModelSourceRecord, expected: ModelSourceHealthRevision): Promise<boolean> {
    return this.database.transaction((connection) => {
      const updated = connection.prepare(`UPDATE model_sources
        SET status = ?, updated_at = ?
        WHERE source_id = ?
          AND active_source_revision_id = ?
          AND active_model_revision_id = ?
          AND updated_at = ?
          AND (? IS NULL OR status = ?)
          AND EXISTS (
            SELECT 1 FROM model_source_revisions sr
            WHERE sr.source_revision_id = model_sources.active_source_revision_id
              AND sr.source_id = model_sources.source_id
              AND sr.credential_version = ?
          )`).run(
        record.source.status, record.source.updatedAt, record.source.sourceId,
        expected.sourceRevisionId, expected.modelRevisionId, expected.sourceUpdatedAt, expected.sourceStatus ?? null, expected.sourceStatus ?? null, expected.credentialVersion,
      );
      if (updated.changes !== 1) return false;
      connection.prepare(`UPDATE model_source_health
        SET status = ?, reason_code = ?, last_error = ?, last_validated_at = ?, updated_at = ?, anthropic_auth_mode = ? WHERE source_id = ?`).run(
        record.source.status, record.reasonCode ?? null, record.lastError ?? null, record.lastValidatedAt ?? null,
        record.source.updatedAt, record.anthropicAuthMode ?? null, record.source.sourceId,
      );
      return true;
    });
  }

  async recordToolProof(input: { modelRevisionId: string; provenAt: string; sourceRevisionId: string }): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO model_source_tool_proofs (source_revision_id, model_revision_id, proven_at)
        VALUES (?, ?, ?) ON CONFLICT (source_revision_id, model_revision_id) DO NOTHING`).run(
        input.sourceRevisionId, input.modelRevisionId, input.provenAt,
      );
    });
  }

  async revise(record: ModelSourceRecord): Promise<void> {
    this.database.transaction((connection) => {
      const source = record.source;
      connection.prepare(`INSERT INTO model_source_revisions
        (source_revision_id, source_id, kind, access_mode, protocol, display_name, base_url, credential_ref, credential_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        source.activeSourceRevision.sourceRevisionId, source.sourceId, source.activeSourceRevision.kind,
        source.activeSourceRevision.accessMode, source.activeSourceRevision.protocol, source.activeSourceRevision.displayName, record.baseUrl ?? null, source.activeSourceRevision.credentialRef,
        source.activeSourceRevision.credentialVersion, source.activeSourceRevision.createdAt,
      );
      connection.prepare(`INSERT INTO model_source_model_revisions
        (model_revision_id, source_id, model_id, capability, preset_version,
         context_window, max_output_tokens, compaction_threshold_percent, thinking_effort, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        source.activeModelRevision.modelRevisionId, source.sourceId, source.activeModelRevision.modelId,
        source.activeModelRevision.capability, record.presetVersion ?? null,
        source.activeModelRevision.contextWindow ?? null,
        source.activeModelRevision.maxOutputTokens ?? null,
        source.activeModelRevision.compactionThresholdPercent ?? null,
        source.activeModelRevision.thinkingEffort ?? null,
        source.activeModelRevision.createdAt,
      );
      connection.prepare(`UPDATE model_sources
        SET status = ?, active_source_revision_id = ?, active_model_revision_id = ?, updated_at = ? WHERE source_id = ?`).run(
        source.status, source.activeSourceRevision.sourceRevisionId, source.activeModelRevision.modelRevisionId,
        source.updatedAt, source.sourceId,
      );
      connection.prepare(`UPDATE model_source_health
        SET status = ?, reason_code = NULL, last_error = NULL, last_validated_at = NULL, updated_at = ?, anthropic_auth_mode = ? WHERE source_id = ?`).run(
        source.status, source.updatedAt, record.anthropicAuthMode ?? null, source.sourceId,
      );
    });
  }

  async setOrder(sourceIds: string[]): Promise<void> {
    this.database.transaction((connection) => {
      const offset = sourceIds.length + 1;
      connection.prepare("UPDATE model_source_order SET position = position + ?, is_primary = 0").run(offset);
      const update = connection.prepare("UPDATE model_source_order SET position = ?, is_primary = ? WHERE source_id = ?");
      sourceIds.forEach((sourceId, position) => update.run(position, position === 0 ? 1 : 0, sourceId));
    });
  }

  async delete(sourceId: string): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare("DELETE FROM model_source_order WHERE source_id = ?").run(sourceId);
      connection.prepare("DELETE FROM model_source_health WHERE source_id = ?").run(sourceId);
      // Historical turns pin immutable revisions. Remove the active configuration,
      // retaining its identity and revisions solely for those historical references.
      connection.prepare(`UPDATE model_sources SET status = 'DISABLED',
        active_source_revision_id = NULL, active_model_revision_id = NULL WHERE source_id = ?`).run(sourceId);
    });
  }
}
