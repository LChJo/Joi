/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { ConversationMessage, ConversationRecord, ConversationStore, ConversationTranscriptEntry } from "@rd-efficiency/agentsdk";
import type { DatabaseSync } from "node:sqlite";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function parseRecord(row: Row): ConversationRecord {
  if (typeof row.record_json !== "string") throw new Error("mana_sdk_conversation_invalid");
  const parsed: unknown = JSON.parse(row.record_json);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("mana_sdk_conversation_invalid");
  return parsed as ConversationRecord;
}

function parseEntry(row: Row): ConversationTranscriptEntry {
  if (typeof row.entry_json !== "string") throw new Error("mana_sdk_transcript_invalid");
  const parsed: unknown = JSON.parse(row.entry_json);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("mana_sdk_transcript_invalid");
  return parsed as ConversationTranscriptEntry;
}

/** agentsdk ConversationStore persistence over the joi runtime SQLite database. */
export class ManaSdkConversationStore implements ConversationStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async create(record: ConversationRecord): Promise<ConversationRecord> {
    this.database.transaction((connection) => connection.prepare(`INSERT INTO mana_sdk_conversations
      (conversation_id, project_key, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      record.id, record.projectKey, JSON.stringify(record), record.createdAt, record.updatedAt,
    ));
    return record;
  }

  async get(id: string): Promise<ConversationRecord | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT record_json FROM mana_sdk_conversations WHERE conversation_id = ?",
    ).get(id)) as Row | undefined;
    return row === undefined ? null : parseRecord(row);
  }

  async update(id: string, updater: (record: ConversationRecord) => ConversationRecord | Promise<ConversationRecord>): Promise<ConversationRecord> {
    const current = await this.get(id);
    if (current === null) throw new Error("mana_sdk_conversation_not_found");
    const next = await updater(current);
    const updatedAt = new Date().toISOString();
    this.database.transaction((connection) => connection.prepare(
      "UPDATE mana_sdk_conversations SET record_json = ?, updated_at = ? WHERE conversation_id = ?",
    ).run(JSON.stringify(next), updatedAt, id));
    return next;
  }

  async appendTranscript(id: string, entries: ConversationTranscriptEntry[]): Promise<ConversationRecord> {
    const updated = this.database.transaction((connection) => {
      const nextIndex = (connection.prepare(
        "SELECT COALESCE(MAX(entry_index), -1) + 1 AS next_index FROM mana_sdk_transcript WHERE conversation_id = ?",
      ).get(id) as { next_index: number }).next_index;
      const insert = connection.prepare(
        "INSERT INTO mana_sdk_transcript (conversation_id, entry_index, entry_json) VALUES (?, ?, ?)",
      );
      entries.forEach((entry, offset) => insert.run(id, nextIndex + offset, JSON.stringify(entry)));
      const row = connection.prepare("SELECT record_json FROM mana_sdk_conversations WHERE conversation_id = ?").get(id) as Row | undefined;
      if (row === undefined) throw new Error("mana_sdk_conversation_not_found");
      const current = parseRecord(row);
      // The transcript table is the paged source of truth; record.transcript mirrors it for the SDK.
      const next: ConversationRecord = { ...current, transcript: [...current.transcript, ...entries], updatedAt: new Date().toISOString() };
      connection.prepare("UPDATE mana_sdk_conversations SET record_json = ?, updated_at = ? WHERE conversation_id = ?")
        .run(JSON.stringify(next), next.updatedAt, id);
      return next;
    });
    return updated;
  }

  async listMessages(id: string, options?: { limit?: number; offset?: number }): Promise<ConversationMessage[]> {
    const rows = this.database.transaction((connection) => connection.prepare(
      "SELECT entry_json FROM mana_sdk_transcript WHERE conversation_id = ? ORDER BY entry_index",
    ).all(id)) as Row[];
    const messages = rows.map((row): ConversationMessage => {
      const entry = parseEntry(row);
      return {
        ...(entry.content === undefined ? {} : { content: entry.content }),
        conversationId: id,
        createdAt: entry.createdAt,
        id: entry.id,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
        ...(entry.native === undefined ? {} : { native: entry.native }),
        role: entry.role,
        ...(entry.status === undefined ? {} : { status: entry.status }),
        turnId: entry.turnId,
        ...(entry.usage === undefined ? {} : { usage: entry.usage }),
      };
    });
    const offset = options?.offset ?? 0;
    const limited = options?.limit === undefined ? messages.slice(offset) : messages.slice(offset, offset + options.limit);
    return limited;
  }

  async fork(id: string, next: { id: string; metadata?: Record<string, unknown>; projectKey?: string }): Promise<ConversationRecord> {
    const base = await this.get(id);
    if (base === null) throw new Error("mana_sdk_conversation_not_found");
    const createdAt = new Date().toISOString();
    const record: ConversationRecord = {
      ...base,
      createdAt,
      id: next.id,
      ...(next.metadata === undefined ? {} : { metadata: next.metadata }),
      projectKey: next.projectKey ?? base.projectKey,
      updatedAt: createdAt,
    };
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO mana_sdk_conversations
        (conversation_id, project_key, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
        record.id, record.projectKey, JSON.stringify(record), record.createdAt, record.updatedAt,
      );
      connection.prepare(`INSERT INTO mana_sdk_transcript (conversation_id, entry_index, entry_json)
        SELECT ?, entry_index, entry_json FROM mana_sdk_transcript WHERE conversation_id = ?`).run(record.id, id);
    });
    return record;
  }

  async delete(id: string): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare("DELETE FROM mana_sdk_transcript WHERE conversation_id = ?").run(id);
      connection.prepare("DELETE FROM mana_sdk_conversations WHERE conversation_id = ?").run(id);
    });
  }
}
