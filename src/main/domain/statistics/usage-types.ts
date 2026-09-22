import type { TokenUsage, UsageEngine, UsagePurpose, UsageStatus } from "../../../shared/statistics.js";

export interface UsageContext {
  engine: UsageEngine;
  purpose: UsagePurpose;
  workbenchId?: string;
  goalId?: string;
  workId?: string;
  partnerId?: string;
  sourceId?: string;
  sourceName?: string;
  modelId?: string;
}
export interface UsageRecord extends UsageContext {
  id: string;
  invocationId: string;
  at: string;
  status: UsageStatus;
  tokens: TokenUsage | null;
}
export interface StatisticsGoalFact {
  goalId: string;
  workbenchId: string;
  title: string;
  status: "completed" | "failed" | "waiting" | "running" | "canceled";
  completedAt: string | null;
}
export interface StatisticsSnapshot {
  collectionDegraded?: boolean;
  collectedSince: string;
  records: UsageRecord[];
  workbenches: { workbenchId: string; name: string; archived: boolean }[];
  goals: StatisticsGoalFact[];
}
