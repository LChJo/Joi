/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiReasoningSessionSnapshot, ReasoningSessionStore } from "../../application/ports/primary-reasoning-runtime.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

interface StoredMetadata {
  summaryRetry?: JoiReasoningSessionSnapshot["summaryRetry"];
  archivedMessages?: unknown[];
  archivedMessageCount?: number;
  compaction?: JoiReasoningSessionSnapshot["compaction"];
  modelRevisionId: string;
  sourceRevisionId: string;
  systemPrompt: string;
  updatedAt: string;
}

interface SerializedSession {
  workbenchId: string;
  metadataJson: string;
  messages: string[];
  archived: string[];
  archiveValues: readonly unknown[];
}

function validCoverage(value: unknown): NonNullable<JoiReasoningSessionSnapshot["compaction"]>["coverage"] {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("pi_session_record_invalid");
  const coverage = value as Record<string, unknown>;
  if (typeof coverage.checkpointId !== "string" || coverage.checkpointId.length === 0 || typeof coverage.transcriptId !== "string"
    || coverage.coveredFrom !== 0 || !Number.isSafeInteger(coverage.coveredTo) || (coverage.coveredTo as number) < 0) throw new Error("pi_session_record_invalid");
  return { checkpointId: coverage.checkpointId, coveredFrom: 0, coveredTo: coverage.coveredTo as number, transcriptId: coverage.transcriptId };
}

function metadata(value: unknown): StoredMetadata {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("pi_session_record_invalid");
  const record = value as Record<string, unknown>;
  let summaryRetry: JoiReasoningSessionSnapshot["summaryRetry"];
  if (record.summaryRetry !== undefined) {
    const state = record.summaryRetry;
    if (state === null || typeof state !== "object" || Array.isArray(state)
      || !("routeKey" in state) || typeof state.routeKey !== "string" || !/^[a-f0-9]{64}$/u.test(state.routeKey)
      || !("failures" in state) || typeof state.failures !== "number" || !Number.isSafeInteger(state.failures) || state.failures < 1
      || !("until" in state) || typeof state.until !== "number" || !Number.isFinite(state.until) || state.until < 0) throw new Error("pi_session_record_invalid");
    summaryRetry = { routeKey: state.routeKey, failures: state.failures, until: state.until };
  }
  if (typeof record.modelRevisionId !== "string" || typeof record.sourceRevisionId !== "string"
    || typeof record.systemPrompt !== "string" || typeof record.updatedAt !== "string") throw new Error("pi_session_record_invalid");
  let compaction: JoiReasoningSessionSnapshot["compaction"];
  if (record.compaction !== undefined) {
    if (record.compaction === null || Array.isArray(record.compaction) || typeof record.compaction !== "object") {
      throw new Error("pi_session_record_invalid");
    }
    const storedCompaction = record.compaction as Record<string, unknown>;
    if (typeof storedCompaction.compactedMessages !== "number" || typeof storedCompaction.count !== "number"
      || typeof storedCompaction.lastCompactedAt !== "string" || typeof storedCompaction.summary !== "string") {
      throw new Error("pi_session_record_invalid");
    }
    const coverage = validCoverage(storedCompaction.coverage);
    compaction = {
      ...(storedCompaction.softPending === true ? { softPending: true } : {}),
      compactedMessages: storedCompaction.compactedMessages,
      count: storedCompaction.count,
      lastCompactedAt: storedCompaction.lastCompactedAt,
      summary: storedCompaction.summary,
      ...(coverage === undefined ? {} : { coverage }),
    };
  }
  if (record.archivedMessageCount !== undefined && (!Number.isSafeInteger(record.archivedMessageCount) || (record.archivedMessageCount as number) < 0)) {
    throw new Error("pi_session_record_invalid");
  }
  return {
    ...(summaryRetry === undefined ? {} : { summaryRetry }),
    ...(Array.isArray(record.archivedMessages) ? { archivedMessages: record.archivedMessages } : {}),
    ...(record.archivedMessageCount === undefined ? {} : { archivedMessageCount: record.archivedMessageCount as number }),
    compaction,
    modelRevisionId: record.modelRevisionId,
    sourceRevisionId: record.sourceRevisionId,
    systemPrompt: record.systemPrompt,
    updatedAt: record.updatedAt,
  };
}

export class SqlitePiReasoningSessionStore implements ReasoningSessionStore {
  readonly #serialized = new Map<string, SerializedSession>();

  constructor(private readonly database: TransactionalDatabase) {}

  async load(sessionId: string): Promise<JoiReasoningSessionSnapshot | null> {
    const loaded = this.database.transaction(connection => this.#read(connection, sessionId));
    if (loaded === null) return null;
    this.#serialized.set(sessionId, loaded.serialized);
    return loaded.snapshot;
  }

  #read(connection: DatabaseSync, sessionId: string): { snapshot: JoiReasoningSessionSnapshot; serialized: SerializedSession } | null {
      const rows = connection.prepare(`SELECT workbench_id, sequence, message_json
        FROM joi_session_messages WHERE session_id = ? ORDER BY sequence`).all(sessionId) as { workbench_id: unknown; message_json: unknown; sequence: unknown }[];
      const first = rows[0];
      if (first === undefined) return null;
      if (typeof first.workbench_id !== "string" || typeof first.message_json !== "string" || first.sequence !== 0) {
        throw new Error("pi_session_record_invalid");
      }
      const stored = metadata(JSON.parse(first.message_json) as unknown);
      const archiveRows = connection.prepare(`SELECT sequence, message_json FROM joi_session_archived_messages
        WHERE session_id = ? ORDER BY sequence`).all(sessionId) as { sequence: unknown; message_json: unknown }[];
      const archived = archiveRows.map((row, index) => {
        if (row.sequence !== index || typeof row.message_json !== "string") throw new Error("pi_session_record_invalid");
        return row.message_json;
      });
      if (stored.archivedMessageCount !== undefined && stored.archivedMessageCount !== archived.length) throw new Error("pi_session_record_invalid");
      const archiveValues = stored.archivedMessages ?? archived.map(value => JSON.parse(value) as unknown);
      const coverage = stored.compaction?.coverage;
      if (coverage !== undefined && (coverage.transcriptId !== sessionId || coverage.coveredTo !== archiveValues.length)) throw new Error("pi_session_record_invalid");
      const messages = rows.slice(1).map((row, index) => {
        if (typeof row.message_json !== "string" || row.sequence !== index + 1 || row.workbench_id !== first.workbench_id) throw new Error("pi_session_record_invalid");
        return row.message_json;
      });
      const snapshot: JoiReasoningSessionSnapshot = {
        ...(stored.summaryRetry === undefined ? {} : { summaryRetry: stored.summaryRetry }),
        workbenchId: first.workbench_id,
        ...(stored.archivedMessageCount === undefined && stored.archivedMessages === undefined ? {} : { archivedMessages: archiveValues }),
        compaction: stored.compaction,
        messages: messages.map(value => JSON.parse(value) as unknown),
        modelRevisionId: stored.modelRevisionId,
        sessionId,
        sourceRevisionId: stored.sourceRevisionId,
        systemPrompt: stored.systemPrompt,
        updatedAt: stored.updatedAt,
      };
      return { snapshot, serialized: { workbenchId: first.workbench_id, metadataJson: first.message_json, messages, archived,
        archiveValues: stored.archivedMessages === undefined ? archiveValues : [] } };
  }

  async save(snapshot: JoiReasoningSessionSnapshot): Promise<void> {
    const serialized = this.database.transaction((connection) => {
      const previous = this.#serialized.get(snapshot.sessionId) ?? this.#read(connection, snapshot.sessionId)?.serialized;
      if (previous !== undefined && previous.workbenchId !== snapshot.workbenchId) throw new Error("pi_session_workbench_mismatch");
      const archiveValues = snapshot.archivedMessages ?? [];
      const coverage = validCoverage(snapshot.compaction?.coverage);
      if (coverage !== undefined && (coverage.transcriptId !== snapshot.sessionId || coverage.coveredTo !== archiveValues.length)) throw new Error("pi_session_record_invalid");
      const metadataJson = JSON.stringify({
          summaryRetry: snapshot.summaryRetry,
          ...(snapshot.archivedMessages === undefined ? {} : { archivedMessageCount: archiveValues.length }),
          compaction: snapshot.compaction,
          modelRevisionId: snapshot.modelRevisionId,
          sourceRevisionId: snapshot.sourceRevisionId,
          systemPrompt: snapshot.systemPrompt,
          updatedAt: snapshot.updatedAt,
        });
      const messages = snapshot.messages.map(message => JSON.stringify(message) || "null");
      const archived = archiveValues.map((message, index) => previous !== undefined && previous.archiveValues[index] === message
        ? previous.archived[index] ?? (JSON.stringify(message) || "null") : JSON.stringify(message) || "null");
      const upsert = connection.prepare(`INSERT INTO joi_session_messages
        (message_id, session_id, workbench_id, sequence, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id, sequence) DO UPDATE SET message_json = excluded.message_json`);
      if (previous?.metadataJson !== metadataJson) upsert.run(`${snapshot.sessionId}:metadata`, snapshot.sessionId, snapshot.workbenchId, 0, metadataJson, snapshot.updatedAt);
      messages.forEach((message, index) => {
        if (previous?.messages[index] !== message) upsert.run(`${snapshot.sessionId}:message:${String(index + 1)}`, snapshot.sessionId, snapshot.workbenchId, index + 1, message, snapshot.updatedAt);
      });
      if ((previous?.messages.length ?? 0) > messages.length) connection.prepare("DELETE FROM joi_session_messages WHERE session_id = ? AND sequence > ?").run(snapshot.sessionId, messages.length);
      const archiveUpsert = connection.prepare(`INSERT INTO joi_session_archived_messages
        (session_id, sequence, message_json, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, sequence) DO UPDATE SET message_json = excluded.message_json`);
      archived.forEach((message, index) => {
        if (previous?.archived[index] !== message) archiveUpsert.run(snapshot.sessionId, index, message, snapshot.updatedAt);
      });
      if ((previous?.archived.length ?? 0) > archived.length) connection.prepare("DELETE FROM joi_session_archived_messages WHERE session_id = ? AND sequence >= ?").run(snapshot.sessionId, archived.length);
      return { workbenchId: snapshot.workbenchId, metadataJson, messages, archived, archiveValues: [...archiveValues] };
    });
    this.#serialized.set(snapshot.sessionId, serialized);
  }
}
