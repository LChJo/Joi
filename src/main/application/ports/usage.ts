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
export interface UsageObservation {
  /** Stable within this invocation. Cumulative updates replace this key, never add to it. */
  key: string;
  modelId?: string;
  sourceId?: string;
  sourceName?: string;
  tokens: TokenUsage | null;
}
export interface UsageSession {
  readonly id: string;
  record(observation: UsageObservation): void;
  finish(status: Exclude<UsageStatus, "running">): void;
}
/** Local numeric telemetry only. Implementations must isolate storage faults from task execution. */
export interface UsageRecorder {
  begin(context: UsageContext): UsageSession;
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
  collectedSince: string;
  records: UsageRecord[];
  workbenches: { workbenchId: string; name: string; archived: boolean }[];
  goals: StatisticsGoalFact[];
}
export interface UsageStore {
  begin(id: string, context: UsageContext, at: string): void;
  observe(id: string, observation: UsageObservation, at: string): void;
  finish(id: string, status: Exclude<UsageStatus, "running">): void;
  recover(): void;
  snapshot(fromUtc: string, toUtc: string): StatisticsSnapshot;
}
