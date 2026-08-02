/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { PartnerRunStatus } from "../../application/ports/partner-execution.js";
import type { PartnerWorkMemoryEntry, PartnerWorkMemoryStore, PartnerWorkMemorySummary } from "../../application/ports/partner-memory.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function mapEntry(row: Row): PartnerWorkMemoryEntry {
  if (typeof row.memory_id !== "string" || typeof row.avatar_id !== "string" || typeof row.partner_id !== "string" || typeof row.session_data_source !== "string"
    || typeof row.outcome !== "string" || typeof row.title !== "string" || typeof row.created_at !== "string") {
    throw new Error("partner_work_memory_record_invalid");
  }
  return {
    avatarId: row.avatar_id,
    createdAt: row.created_at,
    memoryId: row.memory_id,
    outcome: row.outcome as PartnerRunStatus,
    partnerId: row.partner_id,
    sessionDataSource: row.session_data_source,
    title: row.title,
    ...(typeof row.work_id === "string" ? { workId: row.work_id } : {}),
  };
}

export class SqlitePartnerWorkMemoryStore implements PartnerWorkMemoryStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async append(entry: PartnerWorkMemoryEntry): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`INSERT INTO avatar_partner_work_memories
      (memory_id, avatar_id, partner_id, work_id, session_data_source, outcome, title, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.memoryId, entry.avatarId, entry.partnerId, entry.workId ?? null, entry.sessionDataSource, entry.outcome, entry.title, entry.createdAt,
    ));
  }

  async count(avatarId: string, partnerId: string): Promise<number> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT COUNT(*) AS count FROM avatar_partner_work_memories WHERE avatar_id = ? AND partner_id = ?",
    ).get(avatarId, partnerId)) as { count: number };
    return row.count;
  }

  async listEntries(avatarId: string, partnerId: string, limit: number): Promise<PartnerWorkMemoryEntry[]> {
    const rows = this.database.transaction((connection) => connection.prepare(
      `SELECT memory_id, avatar_id, partner_id, work_id, session_data_source, outcome, title, created_at
         FROM avatar_partner_work_memories WHERE avatar_id = ? AND partner_id = ? ORDER BY created_at DESC, memory_id DESC LIMIT ?`,
    ).all(avatarId, partnerId, limit)) as Row[];
    return rows.map((row) => mapEntry(row));
  }

  async loadSummary(avatarId: string, partnerId: string): Promise<PartnerWorkMemorySummary | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT summary, entry_count, updated_at FROM avatar_partner_work_memory_summaries WHERE avatar_id = ? AND partner_id = ?",
    ).get(avatarId, partnerId)) as Row | undefined;
    if (row === undefined) return null;
    if (typeof row.summary !== "string" || typeof row.entry_count !== "number" || typeof row.updated_at !== "string") {
      throw new Error("partner_work_memory_record_invalid");
    }
    return { entryCount: row.entry_count, summary: row.summary, updatedAt: row.updated_at };
  }

  async outcomeCounts(avatarId: string, partnerId: string): Promise<{ completed: number; total: number }> {
    const row = this.database.transaction((connection) => connection.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
         FROM avatar_partner_work_memories WHERE avatar_id = ? AND partner_id = ?`,
    ).get(avatarId, partnerId)) as { completed: number | null; total: number };
    return { completed: row.completed ?? 0, total: row.total };
  }

  async saveSummary(input: { avatarId: string; entryCount: number; partnerId: string; summary: string; updatedAt: string }): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`INSERT INTO avatar_partner_work_memory_summaries
      (avatar_id, partner_id, summary, entry_count, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(avatar_id, partner_id) DO UPDATE SET summary = excluded.summary, entry_count = excluded.entry_count, updated_at = excluded.updated_at`
    ).run(input.avatarId, input.partnerId, input.summary, input.entryCount, input.updatedAt));
  }

  async trim(avatarId: string, partnerId: string, keep: number): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`DELETE FROM avatar_partner_work_memories
      WHERE avatar_id = ? AND partner_id = ? AND memory_id NOT IN (
        SELECT memory_id FROM avatar_partner_work_memories WHERE avatar_id = ? AND partner_id = ? ORDER BY created_at DESC, memory_id DESC LIMIT ?
      )`).run(avatarId, partnerId, avatarId, partnerId, keep));
  }
}
