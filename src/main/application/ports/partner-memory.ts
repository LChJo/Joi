import type { PartnerRunStatus } from "./partner-execution.js";

export interface PartnerWorkMemoryEntry {
  workbenchId: string;
  createdAt: string;
  memoryId: string;
  outcome: PartnerRunStatus;
  partnerId: string;
  sessionDataSource: string;
  title: string;
  workId?: string;
}

export interface PartnerWorkMemorySummary {
  coveredSequence: number;
  entryCount: number;
  summary: string;
  updatedAt: string;
}

export const PARTNER_MEMORY_REFRESH_KIND = "partner.memory.refresh";

export interface PartnerWorkMemoryRefresh {
  createdAt: string;
  entries: PartnerWorkMemoryEntry[];
  sequence: number;
}

export interface PartnerWorkMemoryStore {
  /** Commits the deduplicated outcome, cumulative sequence, bounded ledger and refresh outbox atomically. */
  recordResult(entry: PartnerWorkMemoryEntry, options: { entryLimit: number; resultKey: string; summaryCadence: number }): Promise<void>;
  listEntries(workbenchId: string, partnerId: string, limit: number): Promise<PartnerWorkMemoryEntry[]>;
  loadNextRefresh(workbenchId: string, partnerId: string, throughSequence: number): Promise<PartnerWorkMemoryRefresh | null>;
  loadSummary(workbenchId: string, partnerId: string): Promise<PartnerWorkMemorySummary | null>;
  outcomeCounts(workbenchId: string, partnerId: string): Promise<{ completed: number; total: number }>;
  /** Advances coverage monotonically and retires committed private refresh snapshots. */
  saveSummary(input: { workbenchId: string; coveredSequence: number; entryCount: number; partnerId: string; summary: string; updatedAt: string }): Promise<void>;
}

export interface PartnerMemorySummarizer {
  summarize(input: { workbenchId: string; entries: PartnerWorkMemoryEntry[]; partnerId: string; previousSummary?: string; signal?: AbortSignal }): Promise<string | null>;
}

export interface PartnerWorkMemoryDigest {
  last3: { at: string; outcome: PartnerRunStatus; title: string }[];
  successRate: number;
  summary?: string;
}
