/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { PartnerRunStatus } from "../../application/ports/partner-execution.js";
import { PARTNER_MEMORY_REFRESH_KIND, type PartnerWorkMemoryEntry, type PartnerWorkMemoryRefresh, type PartnerWorkMemoryStore, type PartnerWorkMemorySummary } from "../../application/ports/partner-memory.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function mapEntry(row: Row): PartnerWorkMemoryEntry {
  if (typeof row.memory_id !== "string" || typeof row.workbench_id !== "string" || typeof row.partner_id !== "string" || typeof row.session_data_source !== "string"
    || typeof row.outcome !== "string" || typeof row.title !== "string" || typeof row.created_at !== "string") {
    throw new Error("partner_work_memory_record_invalid");
  }
  return {
    workbenchId: row.workbench_id,
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

  async recordResult(entry: PartnerWorkMemoryEntry, options: { entryLimit: number; resultKey: string; summaryCadence: number }): Promise<void> {
    this.database.transaction((connection) => {
      const exists = connection.prepare(`SELECT 1 FROM workbench_partner_work_memory_receipts
        WHERE workbench_id = ? AND partner_id = ? AND result_key = ?`).get(entry.workbenchId, entry.partnerId, options.resultKey);
      if (exists !== undefined) return;
      const current = connection.prepare(`SELECT total_count, covered_sequence FROM workbench_partner_work_memory_summaries
        WHERE workbench_id = ? AND partner_id = ?`).get(entry.workbenchId, entry.partnerId) as { covered_sequence: number; total_count: number } | undefined;
      const sequence = (current?.total_count ?? 0) + 1;
      connection.prepare(`INSERT INTO workbench_partner_work_memories
        (memory_id, workbench_id, partner_id, work_id, session_data_source, outcome, title, created_at, sequence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.memoryId, entry.workbenchId, entry.partnerId, entry.workId ?? null,
        entry.sessionDataSource, entry.outcome, entry.title, entry.createdAt, sequence);
      connection.prepare(`INSERT INTO workbench_partner_work_memory_receipts (workbench_id, partner_id, result_key, sequence)
        VALUES (?, ?, ?, ?)`).run(entry.workbenchId, entry.partnerId, options.resultKey, sequence);
      connection.prepare(`INSERT INTO workbench_partner_work_memory_summaries
        (workbench_id, partner_id, summary, entry_count, updated_at, covered_sequence, total_count) VALUES (?, ?, '', 0, ?, 0, ?)
        ON CONFLICT(workbench_id, partner_id) DO UPDATE SET total_count = excluded.total_count`).run(entry.workbenchId, entry.partnerId, entry.createdAt, sequence);
      connection.prepare(`DELETE FROM workbench_partner_work_memories WHERE workbench_id = ? AND partner_id = ? AND memory_id NOT IN (
        SELECT memory_id FROM workbench_partner_work_memories WHERE workbench_id = ? AND partner_id = ?
        ORDER BY sequence DESC, created_at DESC, memory_id DESC LIMIT ?
      )`).run(entry.workbenchId, entry.partnerId, entry.workbenchId, entry.partnerId, options.entryLimit);
      if (sequence !== 1 && sequence % options.summaryCadence !== 0) return;
      const queued = connection.prepare(`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workbench_partner_work_memory_refreshes
        WHERE workbench_id = ? AND partner_id = ?`).get(entry.workbenchId, entry.partnerId) as { sequence: number };
      const afterSequence = Math.max(current?.covered_sequence ?? 0, queued.sequence);
      const entries = (connection.prepare(`SELECT memory_id, workbench_id, partner_id, work_id, session_data_source, outcome, title, created_at
        FROM workbench_partner_work_memories WHERE workbench_id = ? AND partner_id = ? AND sequence > ?
        ORDER BY sequence DESC, created_at DESC, memory_id DESC LIMIT ?`).all(entry.workbenchId, entry.partnerId, afterSequence, options.entryLimit) as Row[]).map(mapEntry);
      connection.prepare(`INSERT INTO workbench_partner_work_memory_refreshes
        (workbench_id, partner_id, sequence, entries_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(entry.workbenchId, entry.partnerId, sequence, JSON.stringify(entries), entry.createdAt);
      const outboxId = `partner_memory_refresh:${JSON.stringify([entry.workbenchId, entry.partnerId, sequence])}`;
      connection.prepare(`INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
        VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`).run(outboxId, PARTNER_MEMORY_REFRESH_KIND,
        JSON.stringify({ workbenchId: entry.workbenchId, partnerId: entry.partnerId, throughSequence: sequence }), entry.createdAt, entry.createdAt);
    });
  }

  async listEntries(workbenchId: string, partnerId: string, limit: number): Promise<PartnerWorkMemoryEntry[]> {
    const rows = this.database.transaction((connection) => connection.prepare(
      `SELECT memory_id, workbench_id, partner_id, work_id, session_data_source, outcome, title, created_at
         FROM workbench_partner_work_memories WHERE workbench_id = ? AND partner_id = ? ORDER BY sequence DESC, created_at DESC, memory_id DESC LIMIT ?`,
    ).all(workbenchId, partnerId, limit)) as Row[];
    return rows.map((row) => mapEntry(row));
  }

  async loadNextRefresh(workbenchId: string, partnerId: string, throughSequence: number): Promise<PartnerWorkMemoryRefresh | null> {
    const row = this.database.transaction((connection) => connection.prepare(`SELECT sequence, entries_json, created_at
      FROM workbench_partner_work_memory_refreshes WHERE workbench_id = ? AND partner_id = ? AND sequence <= ?
      AND sequence > COALESCE((SELECT covered_sequence FROM workbench_partner_work_memory_summaries WHERE workbench_id = ? AND partner_id = ?), 0)
      ORDER BY sequence LIMIT 1`).get(workbenchId, partnerId, throughSequence, workbenchId, partnerId)) as Row | undefined;
    if (row === undefined) return null;
    if (typeof row.sequence !== "number" || typeof row.entries_json !== "string" || typeof row.created_at !== "string") {
      throw new Error("partner_work_memory_record_invalid");
    }
    const parsed: unknown = JSON.parse(row.entries_json);
    if (!Array.isArray(parsed)) throw new Error("partner_work_memory_record_invalid");
    const entries = parsed.map((value: unknown) => {
      if (value === null || typeof value !== "object") throw new Error("partner_work_memory_record_invalid");
      const item = value as Record<string, unknown>;
      return mapEntry({ memory_id: item.memoryId, workbench_id: item.workbenchId, partner_id: item.partnerId, work_id: item.workId,
        session_data_source: item.sessionDataSource, outcome: item.outcome, title: item.title, created_at: item.createdAt });
    });
    return { createdAt: row.created_at, entries, sequence: row.sequence };
  }

  async loadSummary(workbenchId: string, partnerId: string): Promise<PartnerWorkMemorySummary | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT summary, entry_count, updated_at, covered_sequence FROM workbench_partner_work_memory_summaries WHERE workbench_id = ? AND partner_id = ? AND summary <> ''",
    ).get(workbenchId, partnerId)) as Row | undefined;
    if (row === undefined) return null;
    if (typeof row.summary !== "string" || typeof row.entry_count !== "number" || typeof row.updated_at !== "string" || typeof row.covered_sequence !== "number") {
      throw new Error("partner_work_memory_record_invalid");
    }
    return { coveredSequence: row.covered_sequence, entryCount: row.entry_count, summary: row.summary, updatedAt: row.updated_at };
  }

  async outcomeCounts(workbenchId: string, partnerId: string): Promise<{ completed: number; total: number }> {
    const row = this.database.transaction((connection) => connection.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
         FROM workbench_partner_work_memories WHERE workbench_id = ? AND partner_id = ?`,
    ).get(workbenchId, partnerId)) as { completed: number | null; total: number };
    return { completed: row.completed ?? 0, total: row.total };
  }

  async saveSummary(input: { workbenchId: string; coveredSequence: number; entryCount: number; partnerId: string; summary: string; updatedAt: string }): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare(`INSERT INTO workbench_partner_work_memory_summaries
        (workbench_id, partner_id, summary, entry_count, updated_at, covered_sequence, total_count) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workbench_id, partner_id) DO UPDATE SET summary = excluded.summary, entry_count = excluded.entry_count,
        updated_at = excluded.updated_at, covered_sequence = excluded.covered_sequence
        WHERE excluded.covered_sequence > workbench_partner_work_memory_summaries.covered_sequence`
      ).run(input.workbenchId, input.partnerId, input.summary, input.entryCount, input.updatedAt, input.coveredSequence, input.coveredSequence);
      connection.prepare(`DELETE FROM workbench_partner_work_memory_refreshes
        WHERE workbench_id = ? AND partner_id = ? AND sequence <= ?`).run(input.workbenchId, input.partnerId, input.coveredSequence);
    });
  }

}
