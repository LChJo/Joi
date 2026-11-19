import { HISTORICAL_MEMORY_KIND, type HistoricalMemoryCompaction, type HistoricalMemoryOrganizer, type HistoricalMemoryStore, type HistoricalMemoryUpdate } from "../ports/historical-memory.js";
import type { OutboxRecord } from "../ports/runtime-store.js";
import { historicalCharacters, historicalCompactionThreshold, renderHistoricalContext, type HistoricalEntry } from "../../domain/work/historical-context.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";

export class HistoricalMemoryService {
  readonly #shutdown = new AbortController();

  constructor(private readonly store: HistoricalMemoryStore, private readonly organizer: HistoricalMemoryOrganizer, private readonly diagnostics?: RuntimeDiagnostics) {}

  stop(): void { this.#shutdown.abort(); }

  async handle(record: OutboxRecord): Promise<void> {
    const { scope,sourceId } = record.payload;
    if (record.kind !== HISTORICAL_MEMORY_KIND || typeof sourceId !== "string" || (scope !== "joi" && scope !== "workbench" && scope !== "partner")) {
      throw new Error("historical_memory_job_invalid");
    }
    const update = this.store.loadUpdate(sourceId,scope);
    if (update === null) return;
    const started = Date.now();
    const signal = AbortSignal.any([this.#shutdown.signal,AbortSignal.timeout(45_000)]);
    signal.throwIfAborted();
    let status: "updated" | "fallback" = "updated";
    let entries: HistoricalEntry[];
    try {
      entries = scope === "joi" ? update.explicitPreferences ?? [] : await this.organizer.organize(update,signal);
      signal.throwIfAborted();
    } catch (error) {
      if (this.#shutdown.signal.aborted || record.attemptCount < 3) throw error;
      status = "fallback";
      entries = [];
    }
    const priorFacts = new Set(update.entries.map(entry => `${entry.section}\n${entry.text}`));
    const candidates = renderHistoricalContext(scope,entries).entries;
    const additions = (scope === "joi" ? candidates : candidates.filter(entry =>
      !priorFacts.has(`${entry.section}\n${entry.text}`))).map(entry => ({ ...entry,source: sourceId }));
    const incoming = [...(update.index === undefined ? [] : [update.index]),...additions];
    const compacted = await this.#compactOlder(update,incoming);
    if (compacted === null) status = "fallback";
    this.#shutdown.signal.throwIfAborted();
    if (this.store.commit(update,incoming,compacted ?? [])) {
      emitRuntimeDiagnostic(this.diagnostics,"joi.history.organized",{ ownerType: scope,count: additions.length,durationMs: Date.now() - started,status });
    }
  }

  async #compactOlder(update: HistoricalMemoryUpdate, incoming: HistoricalEntry[]): Promise<HistoricalMemoryCompaction[] | null> {
    if (incoming.length === 0 || this.organizer.compact === undefined) return [];
    const projected = renderHistoricalContext(update.scope,[...incoming,...update.entries]);
    if (historicalCharacters(projected.text) < historicalCompactionThreshold(update.scope)) return [];

    const older = update.entries.filter(entry => entry.compacted !== true && entry.key === undefined
      && entry.section !== "preferences" && entry.section !== "sources" && entry.section !== "evolution")
      .slice(-24);
    if (older.length === 0) return [];
    try {
      const signal = AbortSignal.any([this.#shutdown.signal,AbortSignal.timeout(15_000)]);
      const compacted = await this.organizer.compact(update,older,signal);
      signal.throwIfAborted();
      return older.map((before,index) => ({ before,text: compacted.get(index) ?? before.text }));
    } catch {
      return null;
    }
  }
}
