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
  entryCount: number;
  summary: string;
  updatedAt: string;
}

export interface PartnerWorkMemoryStore {
  append(entry: PartnerWorkMemoryEntry): Promise<void>;
  count(workbenchId: string, partnerId: string): Promise<number>;
  listEntries(workbenchId: string, partnerId: string, limit: number): Promise<PartnerWorkMemoryEntry[]>;
  loadSummary(workbenchId: string, partnerId: string): Promise<PartnerWorkMemorySummary | null>;
  outcomeCounts(workbenchId: string, partnerId: string): Promise<{ completed: number; total: number }>;
  saveSummary(input: { workbenchId: string; entryCount: number; partnerId: string; summary: string; updatedAt: string }): Promise<void>;
  trim(workbenchId: string, partnerId: string, keep: number): Promise<void>;
}

export interface PartnerMemorySummarizer {
  summarize(input: { workbenchId: string; entries: PartnerWorkMemoryEntry[]; partnerId: string; previousSummary?: string }): Promise<string | null>;
}

export interface PartnerWorkMemoryDigest {
  last3: { at: string; outcome: PartnerRunStatus; title: string }[];
  successRate: number;
  summary?: string;
}
