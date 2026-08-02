import type { PartnerRunStatus } from "../ports/partner-execution.js";
import type {
  PartnerMemorySummarizer,
  PartnerWorkMemoryDigest,
  PartnerWorkMemoryEntry,
  PartnerWorkMemoryStore,
} from "../ports/partner-memory.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

export const PARTNER_MEMORY_LIMITS = {
  entryLimit: 32,
  summaryCadence: 8,
  summaryMaxCharacters: 1_200,
} as const;

export function deterministicPartnerSummary(entries: PartnerWorkMemoryEntry[]): string {
  if (entries.length === 0) return "No partner runs recorded yet.";
  const completed = entries.filter((entry) => entry.outcome === "COMPLETED").length;
  const latest = entries[0];
  const latestLine = latest === undefined ? "" : `last: ${latest.outcome} on "${latest.title}"`;
  return `${String(completed)} of ${String(entries.length)} recent runs completed; ${latestLine}.`
    .slice(0, PARTNER_MEMORY_LIMITS.summaryMaxCharacters);
}

export class PartnerWorkMemoryService {
  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    store: PartnerWorkMemoryStore;
    summarizer?: PartnerMemorySummarizer;
  }) {}

  /** Appends one ground-truth outcome, trims the ledger and refreshes the rolling summary on cadence. */
  async recordResult(input: { at: string; avatarId: string; outcome: PartnerRunStatus; partnerId: string; sessionDataSource: string; title: string; workId?: string }): Promise<void> {
    await this.dependencies.store.append({
      avatarId: input.avatarId,
      createdAt: input.at,
      memoryId: this.dependencies.ids.next("partner_work_memory"),
      outcome: input.outcome,
      partnerId: input.partnerId,
      sessionDataSource: input.sessionDataSource,
      title: input.title,
      ...(input.workId === undefined ? {} : { workId: input.workId }),
    });
    await this.dependencies.store.trim(input.avatarId, input.partnerId, PARTNER_MEMORY_LIMITS.entryLimit);
    const count = await this.dependencies.store.count(input.avatarId, input.partnerId);
    const previous = await this.dependencies.store.loadSummary(input.avatarId, input.partnerId);
    if (previous === null || count % PARTNER_MEMORY_LIMITS.summaryCadence === 0) {
      await this.#refreshSummary(input.avatarId, input.partnerId, input.at, previous?.summary);
    }
  }

  async digest(avatarId: string, partnerId: string): Promise<PartnerWorkMemoryDigest> {
    const [summaryRow, recent, counts] = await Promise.all([
      this.dependencies.store.loadSummary(avatarId, partnerId),
      this.dependencies.store.listEntries(avatarId, partnerId, 3),
      this.dependencies.store.outcomeCounts(avatarId, partnerId),
    ]);
    return {
      last3: recent.map((entry) => ({ at: entry.createdAt, outcome: entry.outcome, title: entry.title })),
      successRate: counts.total === 0 ? 1 : counts.completed / counts.total,
      ...(summaryRow === null ? {} : { summary: summaryRow.summary }),
    };
  }

  async debugView(avatarId: string, partnerId: string): Promise<{ entries: PartnerWorkMemoryEntry[]; summary?: string; summaryUpdatedAt?: string }> {
    const [summaryRow, entries] = await Promise.all([
      this.dependencies.store.loadSummary(avatarId, partnerId),
      this.dependencies.store.listEntries(avatarId, partnerId, PARTNER_MEMORY_LIMITS.entryLimit),
    ]);
    return {
      entries,
      ...(summaryRow === null ? {} : { summary: summaryRow.summary, summaryUpdatedAt: summaryRow.updatedAt }),
    };
  }

  async #refreshSummary(avatarId: string, partnerId: string, at: string, previous?: string): Promise<void> {
    const entries = await this.dependencies.store.listEntries(avatarId, partnerId, PARTNER_MEMORY_LIMITS.entryLimit);
    let generated: string | null = null;
    if (this.dependencies.summarizer !== undefined) {
      generated = await this.dependencies.summarizer.summarize({
        avatarId,
        entries,
        partnerId,
        ...(previous === undefined ? {} : { previousSummary: previous }),
      });
    }
    const summary = (generated ?? deterministicPartnerSummary(entries)).slice(0, PARTNER_MEMORY_LIMITS.summaryMaxCharacters);
    await this.dependencies.store.saveSummary({ avatarId, entryCount: entries.length, partnerId, summary, updatedAt: at });
  }
}
