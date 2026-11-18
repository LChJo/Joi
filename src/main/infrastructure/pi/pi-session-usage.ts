import { createHash } from "node:crypto";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { UsageContext, UsageRecorder } from "../../application/ports/usage.js";
import { normalizePiUsage } from "../usage/sdk-usage.js";

export interface PiUsageCursor {
  sessionId: string;
  offset: number;
  lastEntryId: string | null;
  lastInvocationId?: string;
  context?: UsageContext;
  background?: UsageContext;
  tracedSummaries: boolean;
}

/** Canonical entries retain their attribution across compaction, restart and Work boundaries. */
export class PiSessionUsage {
  constructor(private readonly recorder: UsageRecorder | undefined, private cursor?: PiUsageCursor) {}

  reconcile(manager: SessionManager): PiUsageCursor {
    const entries = manager.getEntries(), prior = this.cursor;
    const valid = prior?.sessionId === manager.getSessionId() && Number.isSafeInteger(prior.offset) && prior.offset >= 0
      && prior.offset <= entries.length && prior.lastEntryId === (entries[prior.offset - 1]?.id ?? null);
    let context = valid ? prior.context : undefined;
    let background = valid ? prior.background : undefined;
    let tracedSummaries = valid && prior.tracedSummaries;
    let offset = valid ? prior.offset : 0;
    let lastInvocationId = valid ? prior.lastInvocationId : undefined;
    for (; offset < entries.length; offset++) {
      const entry = entries[offset];if (entry === undefined) break;
      if (entry.type === "custom" && entry.customType === "joi.summary_usage_mode") { tracedSummaries = true; continue; }
      if (entry.type === "custom" && entry.customType === "joi.usage_context") {
        context = entry.data as UsageContext;
        background = { engine: context.engine, purpose: context.purpose, ...(context.workbenchId === undefined ? {} : { workbenchId: context.workbenchId }),
          ...(context.sourceName === undefined ? {} : { sourceName: context.sourceName }),
          ...(context.sourceId === undefined ? {} : { sourceId: context.sourceId }), ...(context.modelId === undefined ? {} : { modelId: context.modelId }) };
        continue;
      }
      if (entry.type === "custom" && entry.customType === "joi.usage_idle") { context = undefined; continue; }
      const warming = entry.type === "usage" && entry.kind === "cache_warm" || entry.type === "custom" && entry.customType === "joi.cache_warm_usage";
      const owner = warming ? background : context ?? background;
      if (owner === undefined) continue;
      if (tracedSummaries && (entry.type === "compaction" || entry.type === "branch_summary")) continue;
      const usage = this.#usage(entry);
      if (usage === undefined) continue;
      if (this.recorder === undefined) break;
      const id = `pi-entry:${createHash("sha256").update(`${manager.getSessionId()}:${entry.id}`).digest("hex")}`;
      try {
        const summary = entry.type === "custom" && (entry.customType === "joi.summary_usage" || entry.customType === "joi.cache_warm_usage") ? entry.data as { model: string; status: "completed" | "failed" | "canceled" } : undefined;
        const source = entry.type === "message" && entry.message.role === "assistant" ? { modelId: entry.message.model }
          : entry.type === "usage" ? { modelId: entry.model } : summary === undefined ? {} : { modelId: summary.model };
        const invocation = this.recorder.begin({ ...owner, ...source,
          ...(warming ? { purpose: "cache_warming" as const } : entry.type === "compaction" || entry.type === "branch_summary" || summary !== undefined ? { purpose: "summary" as const } : {}) }, { id, at: entry.timestamp });
        invocation.record({ key: "usage", ...source, tokens: normalizePiUsage(usage) });
        invocation.finish(summary?.status ?? (entry.type === "message" && entry.message.role === "assistant"
          ? entry.message.stopReason === "error" ? "failed" : entry.message.stopReason === "aborted" ? "canceled" : "completed" : "completed"));
        if (invocation.isRecorded?.() === false) break;
        lastInvocationId = id;
      } catch { break; /* A later reconciliation retries the same stable numeric identity. */ }
    }
    this.cursor = { sessionId: manager.getSessionId(),offset,lastEntryId: entries[offset - 1]?.id ?? null,tracedSummaries,
      ...(lastInvocationId === undefined ? {} : { lastInvocationId }),
      ...(context === undefined ? {} : { context }),...(background === undefined ? {} : { background }) };
    return this.cursor;
  }

  #usage(entry: SessionEntry): unknown {
    if (entry.type === "message" && entry.message.role === "assistant") return entry.message.usage;
    if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") return entry.usage;
    if (entry.type === "custom" && (entry.customType === "joi.summary_usage" || entry.customType === "joi.cache_warm_usage")) return (entry.data as { usage?: unknown } | null)?.usage;
    return undefined;
  }
}
