/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiReasoningSessionSnapshot, ReasoningSessionStore } from "../../application/ports/primary-reasoning-runtime.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

interface StoredMetadata {
  compaction?: JoiReasoningSessionSnapshot["compaction"];
  modelRevisionId: string;
  sourceRevisionId: string;
  systemPrompt: string;
  updatedAt: string;
}

function metadata(value: unknown): StoredMetadata {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("pi_session_record_invalid");
  const record = value as Record<string, unknown>;
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
    compaction = {
      compactedMessages: storedCompaction.compactedMessages,
      count: storedCompaction.count,
      lastCompactedAt: storedCompaction.lastCompactedAt,
      summary: storedCompaction.summary,
    };
  }
  return {
    compaction,
    modelRevisionId: record.modelRevisionId,
    sourceRevisionId: record.sourceRevisionId,
    systemPrompt: record.systemPrompt,
    updatedAt: record.updatedAt,
  };
}

export class SqlitePiReasoningSessionStore implements ReasoningSessionStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async load(sessionId: string): Promise<JoiReasoningSessionSnapshot | null> {
    return this.database.transaction((connection) => {
      const rows = connection.prepare(`SELECT avatar_id, sequence, message_json
        FROM joi_session_messages WHERE session_id = ? ORDER BY sequence`).all(sessionId) as { avatar_id: unknown; message_json: unknown; sequence: unknown }[];
      const first = rows[0];
      if (first === undefined) return null;
      if (typeof first.avatar_id !== "string" || typeof first.message_json !== "string" || first.sequence !== 0) {
        throw new Error("pi_session_record_invalid");
      }
      const stored = metadata(JSON.parse(first.message_json) as unknown);
      return {
        avatarId: first.avatar_id,
        compaction: stored.compaction,
        messages: rows.slice(1).map((row) => {
          if (typeof row.message_json !== "string") throw new Error("pi_session_record_invalid");
          return JSON.parse(row.message_json) as unknown;
        }),
        modelRevisionId: stored.modelRevisionId,
        sessionId,
        sourceRevisionId: stored.sourceRevisionId,
        systemPrompt: stored.systemPrompt,
        updatedAt: stored.updatedAt,
      };
    });
  }

  async save(snapshot: JoiReasoningSessionSnapshot): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare("DELETE FROM joi_session_messages WHERE session_id = ?").run(snapshot.sessionId);
      const insert = connection.prepare(`INSERT INTO joi_session_messages
        (message_id, session_id, avatar_id, sequence, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      insert.run(
        `${snapshot.sessionId}:metadata`, snapshot.sessionId, snapshot.avatarId, 0,
        JSON.stringify({
          compaction: snapshot.compaction,
          modelRevisionId: snapshot.modelRevisionId,
          sourceRevisionId: snapshot.sourceRevisionId,
          systemPrompt: snapshot.systemPrompt,
          updatedAt: snapshot.updatedAt,
        }), snapshot.updatedAt,
      );
      snapshot.messages.forEach((message, index) => insert.run(
        `${snapshot.sessionId}:message:${String(index + 1)}`, snapshot.sessionId, snapshot.avatarId,
        index + 1, JSON.stringify(message), snapshot.updatedAt,
      ));
    });
  }
}
