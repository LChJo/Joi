import type {
  UsageContext,
  UsageObservation,
  UsageRecorder,
  UsageSession,
} from "../../application/ports/usage.js";
import type { TokenUsage, UsageStatus } from "../../../shared/statistics.js";

export interface SafeUsageSession {
  record(observation: UsageObservation): void;
  finish(status: Exclude<UsageStatus, "running">): void;
}

const NOOP_SESSION: SafeUsageSession = {
  record: () => undefined,
  finish: () => undefined,
};

function token(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sumTokens(...values: number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function safeProviderLabel(value: string | undefined, fallback: string): string {
  if (value === undefined || value.length === 0 || value.length > 120 || value.includes("://")) return fallback;
  return value;
}

export function observation(context: UsageContext, tokens: TokenUsage | null): UsageObservation {
  return {
    key: "result",
    ...(context.modelId === undefined ? {} : { modelId: context.modelId }),
    ...(context.sourceId === undefined ? {} : { sourceId: context.sourceId }),
    ...(context.sourceName === undefined ? {} : { sourceName: context.sourceName }),
    tokens,
  };
}

/** Recorder faults are telemetry faults and must never change model execution. */
export function beginUsage(recorder: UsageRecorder | undefined, context: UsageContext): SafeUsageSession {
  if (recorder === undefined) return NOOP_SESSION;
  let session: UsageSession;
  try {
    session = recorder.begin(context);
  } catch {
    return NOOP_SESSION;
  }
  let finished = false;
  return {
    record: (value) => {
      if (finished) return;
      try { session.record(value); } catch { /* numeric telemetry is non-authoritative */ }
    },
    finish: (status) => {
      if (finished) return;
      finished = true;
      try { session.finish(status); } catch { /* numeric telemetry is non-authoritative */ }
    },
  };
}

export function usageFailureStatus(signal?: AbortSignal): "canceled" | "failed" {
  return signal?.aborted === true ? "canceled" : "failed";
}

export function normalizePiUsage(value: unknown): TokenUsage | null {
  const row = record(value);
  if (row === undefined) return null;
  const input = token(row.input);
  const output = token(row.output);
  const cacheRead = token(row.cacheRead);
  const cacheWrite = token(row.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return null;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  const inclusiveInput = sumTokens(input, cacheRead, cacheWrite);
  if (inclusiveInput === undefined) return null;
  const reasoning = row.reasoning === undefined ? null : token(row.reasoning);
  if (reasoning === undefined) return null;
  return { input: inclusiveInput, output, cacheRead, cacheWrite, reasoning };
}

export function normalizeCodexUsage(value: unknown): TokenUsage | null {
  const row = record(value);
  if (row === undefined) return null;
  const input = token(row.input_tokens);
  const output = token(row.output_tokens);
  const cacheRead = row.cached_input_tokens === undefined ? null : token(row.cached_input_tokens);
  const cacheWrite = row.cache_write_input_tokens === undefined ? null : token(row.cache_write_input_tokens);
  const reasoningValue = row.reasoning_output_tokens ?? record(row.output_tokens_details)?.reasoning_tokens;
  const reasoning = reasoningValue === undefined ? null : token(reasoningValue);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || reasoning === undefined) return null;
  // Codex input_tokens and output_tokens already include their cache/reasoning subsets.
  return { input, output, cacheRead, cacheWrite, reasoning };
}

export function normalizeClaudeModelUsage(value: unknown): TokenUsage | null {
  const row = record(value);
  if (row === undefined) return null;
  const input = token(row.inputTokens);
  const output = token(row.outputTokens);
  const cacheRead = token(row.cacheReadInputTokens);
  const cacheWrite = token(row.cacheCreationInputTokens);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return null;
  const inclusiveInput = sumTokens(input, cacheRead, cacheWrite);
  return inclusiveInput === undefined
    ? null
    : { input: inclusiveInput, output, cacheRead, cacheWrite, reasoning: null };
}


export function unknownUsageObservation(context: UsageContext, key = "result"): UsageObservation {
  return { ...observation(context, null), key };
}
