export type UsagePurpose = "orchestration" | "routing" | "partner" | "evolution" | "summary" | "probe";
export type UsageEngine = "pi" | "codex" | "claude-code" | "a2a";
export type UsageStatus = "running" | "completed" | "failed" | "canceled" | "interrupted";
/** Input includes cache reads/writes; output includes reasoning. Breakdowns are subsets. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
}
export interface StatisticsQuery {
  from: string; // inclusive YYYY-MM-DD in timeZone
  to: string; // inclusive YYYY-MM-DD in timeZone; at most 366 days
  timeZone: string;
  workbenchId?: string; // "unassigned" selects global activity
  modelKey?: string;
  purpose?: UsagePurpose;
}
export interface UsageTotals {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  cacheKnownRecords: number;
  reasoningKnownRecords: number;
  records: number;
  knownRecords: number;
  unknownRecords: number;
  failedRecords: number;
}
export interface StatisticsModelRow extends UsageTotals {
  modelKey: string;
  modelId: string;
  sourceName: string;
  engine: UsageEngine;
}
export interface StatisticsWorkbenchRow extends UsageTotals {
  workbenchId: string;
  name: string;
  archived: boolean;
  completedGoals: number;
  failedGoals: number;
  waitingGoals: number;
}
export interface StatisticsGoalRow extends UsageTotals {
  goalId: string;
  title: string;
  workbenchId: string;
  workbenchName: string;
  status: "completed" | "failed" | "waiting" | "running" | "canceled";
}
export interface StatisticsDto {
  query: StatisticsQuery;
  collectedSince: string;
  updatedAt: string;
  collectionDegraded: boolean;
  overview: UsageTotals & { completedGoals: number };
  daily: (UsageTotals & { date: string })[];
  hourly: (UsageTotals & { weekday: number; hour: number })[]; // Monday=0
  models: StatisticsModelRow[];
  workbenches: StatisticsWorkbenchRow[];
  purposes: (UsageTotals & { purpose: UsagePurpose })[];
  goals: StatisticsGoalRow[]; // top 10 by known total
  filters: {
    workbenches: { workbenchId: string; name: string; archived: boolean }[];
    models: { modelKey: string; modelId: string; sourceName: string; engine: UsageEngine }[];
  };
}
