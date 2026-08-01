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
  if (typeof row.memory_id !== "string" || typeof row.partner_id !== "string" || typeof row.session_data_source !== "string"
    || typeof row.outcome !== "string" || typeof row.title !== "string" || typeof row.created_at !== "string") {
    throw new Error("partner_work_memory_record_invalid");
  }
  return {
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
    this.database.transaction((connection) => connection.prepare(`INSERT INTO partner_work_memories
      (memory_id, partner_id, work_id, session_data_source, outcome, title, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      entry.memoryId, entry.partnerId, entry.workId ?? null, entry.sessionDataSource, entry.outcome, entry.title, entry.createdAt,
    ));
  }

  async count(partnerId: string): Promise<number> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT COUNT(*) AS count FROM partner_work_memories WHERE partner_id = ?",
    ).get(partnerId)) as { count: number };
    return row.count;
  }

  async listEntries(partnerId: string, limit: number): Promise<PartnerWorkMemoryEntry[]> {
    const rows = this.database.transaction((connection) => connection.prepare(
      `SELECT memory_id, partner_id, work_id, session_data_source, outcome, title, created_at
         FROM partner_work_memories WHERE partner_id = ? ORDER BY created_at DESC, memory_id DESC LIMIT ?`,
    ).all(partnerId, limit)) as Row[];
    return rows.map((row) => mapEntry(row));
  }

  async loadSummary(partnerId: string): Promise<PartnerWorkMemorySummary | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT summary, entry_count, updated_at FROM partner_work_memory_summaries WHERE partner_id = ?",
    ).get(partnerId)) as Row | undefined;
    if (row === undefined) return null;
    if (typeof row.summary !== "string" || typeof row.entry_count !== "number" || typeof row.updated_at !== "string") {
      throw new Error("partner_work_memory_record_invalid");
    }
    return { entryCount: row.entry_count, summary: row.summary, updatedAt: row.updated_at };
  }

  async outcomeCounts(partnerId: string): Promise<{ completed: number; total: number }> {
    const row = this.database.transaction((connection) => connection.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
         FROM partner_work_memories WHERE partner_id = ?`,
    ).get(partnerId)) as { completed: number | null; total: number };
    return { completed: row.completed ?? 0, total: row.total };
  }

  async saveSummary(input: { entryCount: number; partnerId: string; summary: string; updatedAt: string }): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`INSERT INTO partner_work_memory_summaries
      (partner_id, summary, entry_count, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(partner_id) DO UPDATE SET summary = excluded.summary, entry_count = excluded.entry_count, updated_at = excluded.updated_at`
    ).run(input.partnerId, input.summary, input.entryCount, input.updatedAt));
  }

  async trim(partnerId: string, keep: number): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`DELETE FROM partner_work_memories
      WHERE partner_id = ? AND memory_id NOT IN (
        SELECT memory_id FROM partner_work_memories WHERE partner_id = ? ORDER BY created_at DESC, memory_id DESC LIMIT ?
      )`).run(partnerId, partnerId, keep));
  }
}
