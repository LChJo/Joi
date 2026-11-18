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
  /** A recoverable collector may retry stable facts when persistence was unavailable. */
  isRecorded?(): boolean;
  record(observation: UsageObservation): void;
  finish(status: Exclude<UsageStatus, "running">): void;
}
/** Local numeric telemetry only. Implementations must isolate storage faults from task execution. */
export interface UsageRecorder {
  /** Checks a durable numeric receipt before reusing progress held outside the ledger. */
  hasRecorded?(id: string): boolean;
  begin(context: UsageContext, identity?: { id: string; at?: string }): UsageSession;
}
export interface UsageStore {
  hasRecorded?(id: string): boolean;
  markDegraded(): void;
  begin(id: string, context: UsageContext, at: string): void;
  observe(id: string, observation: UsageObservation, at: string): void;
  finish(id: string, status: Exclude<UsageStatus, "running">): void;
  recover(): void;
  snapshot(fromUtc: string, toUtc: string): StatisticsSnapshot;
}
