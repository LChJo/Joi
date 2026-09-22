import type { TokenUsage, UsageStatus } from "../../../shared/statistics.js";
import type { UsageContext, StatisticsSnapshot } from "../../domain/statistics/usage-types.js";
export type { UsageContext, UsageRecord, StatisticsGoalFact, StatisticsSnapshot } from "../../domain/statistics/usage-types.js";
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
export interface UsageStore {
  markDegraded(): void;
  begin(id: string, context: UsageContext, at: string): void;
  observe(id: string, observation: UsageObservation, at: string): void;
  finish(id: string, status: Exclude<UsageStatus, "running">): void;
  recover(): void;
  snapshot(fromUtc: string, toUtc: string): StatisticsSnapshot;
}
