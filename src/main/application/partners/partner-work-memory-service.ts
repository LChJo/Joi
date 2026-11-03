import type { PartnerRunStatus } from "../ports/partner-execution.js";
import type {
  PartnerMemorySummarizer,
  PartnerWorkMemoryDigest,
  PartnerWorkMemoryEntry,
  PartnerWorkMemoryStore,
} from "../ports/partner-memory.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";

export const PARTNER_MEMORY_LIMITS = {
  entryLimit: 32,
  summaryCadence: 8,
  summaryMaxCharacters: 1_200,
} as const;

export function deterministicPartnerSummary(entries: PartnerWorkMemoryEntry[], previousSummary?: string): string {
  if (entries.length === 0) return "No partner runs recorded yet.";
  const completed = entries.filter((entry) => entry.outcome === "COMPLETED").length;
  const latest = entries[0];
  const latestLine = latest === undefined ? "" : `last: ${latest.outcome} on "${latest.title}"`;
  const recent = `${String(completed)} of ${String(entries.length)} recent runs completed; ${latestLine}.`
    .slice(0, PARTNER_MEMORY_LIMITS.summaryMaxCharacters);
  if (previousSummary === undefined) return recent;
  const update = `Recent outcomes: ${recent}`.slice(0, PARTNER_MEMORY_LIMITS.summaryMaxCharacters / 2);
  return `${previousSummary.slice(0, PARTNER_MEMORY_LIMITS.summaryMaxCharacters - update.length - 2)}\n\n${update}`;
}

export class PartnerWorkMemoryService {
  readonly #refreshes = new Map<string, Promise<void>>();
  readonly #refreshController = new AbortController();
  constructor(private readonly dependencies: {
    diagnostics?: RuntimeDiagnostics;
    clock: Clock;
    ids: IdGenerator;
    store: PartnerWorkMemoryStore;
    summarizer?: PartnerMemorySummarizer;
  }) {}

  emergencyStop(): void { this.#refreshController.abort(); }

  /** Records an outcome and queues durable cadence work without invoking the model. */
  async recordResult(input: { at: string; workbenchId: string; outcome: PartnerRunStatus; partnerId: string; resultId?: string; sessionDataSource: string; title: string; workId?: string }): Promise<void> {
    const resultKey = input.resultId ?? JSON.stringify([input.workId ?? null, input.sessionDataSource, input.outcome]);
    await this.dependencies.store.recordResult({
      workbenchId: input.workbenchId,
      createdAt: input.at,
      memoryId: `partner_work_memory:${JSON.stringify([input.workbenchId, input.partnerId, resultKey])}`,
      outcome: input.outcome,
      partnerId: input.partnerId,
      sessionDataSource: input.sessionDataSource,
      title: input.title,
      ...(input.workId === undefined ? {} : { workId: input.workId }),
    }, { entryLimit: PARTNER_MEMORY_LIMITS.entryLimit, resultKey, summaryCadence: PARTNER_MEMORY_LIMITS.summaryCadence });
  }

  async digest(workbenchId: string, partnerId: string): Promise<PartnerWorkMemoryDigest> {
    const [summaryRow, recent, counts] = await Promise.all([
      this.dependencies.store.loadSummary(workbenchId, partnerId),
      this.dependencies.store.listEntries(workbenchId, partnerId, 3),
      this.dependencies.store.outcomeCounts(workbenchId, partnerId),
    ]);
    return {
      last3: recent.map((entry) => ({ at: entry.createdAt, outcome: entry.outcome, title: entry.title })),
      successRate: counts.total === 0 ? 1 : counts.completed / counts.total,
      ...(summaryRow === null && recent.length === 0 ? {} : { summary: summaryRow?.summary ?? deterministicPartnerSummary(recent) }),
    };
  }

  async debugView(workbenchId: string, partnerId: string): Promise<{ entries: PartnerWorkMemoryEntry[]; summary?: string; summaryUpdatedAt?: string }> {
    const [summaryRow, entries] = await Promise.all([
      this.dependencies.store.loadSummary(workbenchId, partnerId),
      this.dependencies.store.listEntries(workbenchId, partnerId, PARTNER_MEMORY_LIMITS.entryLimit),
    ]);
    return {
      entries,
      ...(summaryRow === null ? {} : { summary: summaryRow.summary, summaryUpdatedAt: summaryRow.updatedAt }),
    };
  }

  async refreshSummary(input: { workbenchId: string; partnerId: string; throughSequence: number }): Promise<void> {
    const key = JSON.stringify([input.workbenchId, input.partnerId]);
    const previous = this.#refreshes.get(key);
    const refresh = (previous ?? Promise.resolve()).catch(() => undefined).then(() => this.#refreshThrough(input));
    this.#refreshes.set(key, refresh);
    try {
      await refresh;
    } finally {
      if (this.#refreshes.get(key) === refresh) this.#refreshes.delete(key);
    }
  }

  async #refreshThrough(input: { workbenchId: string; partnerId: string; throughSequence: number }): Promise<void> {
    const signal = this.#refreshController.signal;
    for (;;) {
      signal.throwIfAborted();
      const pending = await this.dependencies.store.loadNextRefresh(input.workbenchId, input.partnerId, input.throughSequence);
      if (pending === null) return;
      const previous = await this.dependencies.store.loadSummary(input.workbenchId, input.partnerId);
      signal.throwIfAborted();
      if (previous !== null && previous.coveredSequence >= pending.sequence) continue;
      const startedAt = this.dependencies.clock.now().getTime();
      const generated = await this.dependencies.summarizer?.summarize({
        workbenchId: input.workbenchId,
        entries: pending.entries,
        partnerId: input.partnerId,
        signal,
        ...(previous === null ? {} : { previousSummary: previous.summary }),
      });
      signal.throwIfAborted();
      const normalized = generated?.trim() ?? "";
      const summary = (normalized.length === 0 ? deterministicPartnerSummary(pending.entries, previous?.summary) : normalized).slice(0, PARTNER_MEMORY_LIMITS.summaryMaxCharacters);
      await this.dependencies.store.saveSummary({ workbenchId: input.workbenchId, coveredSequence: pending.sequence, entryCount: Math.min(pending.sequence, PARTNER_MEMORY_LIMITS.entryLimit),
        partnerId: input.partnerId, summary, updatedAt: this.dependencies.clock.now().toISOString() });
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.partner.memory_refreshed", { workbenchId: input.workbenchId,
        partnerId: input.partnerId, coveredSequence: pending.sequence, entryCount: pending.entries.length,
        durationMs: Math.max(0, this.dependencies.clock.now().getTime() - startedAt), status: normalized.length === 0 ? "fallback" : "generated" });
    }
  }
}
