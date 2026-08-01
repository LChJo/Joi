import type { PartnerRunStatus } from "./partner-execution.js";

export interface PartnerWorkMemoryEntry {
  createdAt: string;
  memoryId: string;
  outcome: PartnerRunStatus;
  partnerId: string;
  sessionDataSource: string;
  title: string;
  workId?: string;
}

export interface PartnerWorkMemorySummary {
  entryCount: number;
  summary: string;
  updatedAt: string;
}

export interface PartnerWorkMemoryStore {
  append(entry: PartnerWorkMemoryEntry): Promise<void>;
  count(partnerId: string): Promise<number>;
  listEntries(partnerId: string, limit: number): Promise<PartnerWorkMemoryEntry[]>;
  loadSummary(partnerId: string): Promise<PartnerWorkMemorySummary | null>;
  outcomeCounts(partnerId: string): Promise<{ completed: number; total: number }>;
  saveSummary(input: { entryCount: number; partnerId: string; summary: string; updatedAt: string }): Promise<void>;
  trim(partnerId: string, keep: number): Promise<void>;
}

export interface PartnerMemorySummarizer {
  summarize(input: { entries: PartnerWorkMemoryEntry[]; partnerId: string; previousSummary?: string }): Promise<string | null>;
}

export interface PartnerWorkMemoryDigest {
  last3: { at: string; outcome: PartnerRunStatus; title: string }[];
  successRate: number;
  summary?: string;
}
