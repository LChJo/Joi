import type { HistoricalEntry, HistoricalScope } from "../../domain/work/historical-context.js";
import type { GoalResultSummaryDto } from "../../../shared/goal-results.js";

export const HISTORICAL_MEMORY_KIND = "history.organize";
export const JOI_MEMORY_OWNER = "local";

export interface PublishedWorkbenchResults {
  items: (GoalResultSummaryDto & { title: string })[];
  nextCursor?: string;
}

export interface HistoricalMemoryReader {
  entries(scope: HistoricalScope, ownerId: string): HistoricalEntry[];
  listPublishedResults(workbenchId: string, limit: number, cursor?: string): PublishedWorkbenchResults | null;
  readEvidence(workbenchId: string, sourceId: string, offset: number, limit: number, part?: "input" | "conclusion"): { text: string; total: number } | null;
}

export interface HistoricalMemoryUpdate {
  sourceId: string;
  workbenchId: string;
  ownerId: string;
  scope: HistoricalScope;
  revision: number;
  entries: HistoricalEntry[];
  facts: { conclusion?: string; requirements?: string; verification?: string };
  index?: HistoricalEntry;
  explicitPreferences?: HistoricalEntry[];
  partner?: { revisionId: string; instanceId?: string; workId: string; actionId: string };
}

export interface HistoricalMemoryStore extends HistoricalMemoryReader {
  loadUpdate(sourceId: string, scope: HistoricalScope): HistoricalMemoryUpdate | null;
  commit(update: HistoricalMemoryUpdate, entries: HistoricalEntry[], compacted?: readonly HistoricalMemoryCompaction[]): boolean;
}

export interface HistoricalMemoryCompaction {
  before: HistoricalEntry;
  text: string;
}

export interface HistoricalMemoryOrganizer {
  organize(update: HistoricalMemoryUpdate, signal: AbortSignal): Promise<HistoricalEntry[]>;
  compact?(update: HistoricalMemoryUpdate, older: readonly HistoricalEntry[], signal: AbortSignal): Promise<ReadonlyMap<number,string>>;
}
