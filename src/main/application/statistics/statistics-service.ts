import { aggregateStatistics, validateStatisticsQuery, validateTokenUsage } from "../../domain/statistics/statistics.js";
export { validateStatisticsQuery } from "../../domain/statistics/statistics.js";
import type { UsageContext, UsageRecorder, UsageSession, UsageStore } from "../ports/usage.js";
import type { StatisticsDto, StatisticsQuery } from "../../../shared/statistics.js";

export class StatisticsService implements UsageRecorder {
  #degraded = false;
  constructor(private readonly dependencies: { store: UsageStore; now: () => string; id: () => string }) {}
  #record(operation: () => void): boolean {
    let recorded = true;
    try { operation(); } catch { this.#degraded = true; recorded = false; }
    if (this.#degraded) { try { this.dependencies.store.markDegraded(); } catch { /* Retry the numeric flag on the next write; never fail the user's task. */ } }
    return recorded;
  }
  recover(): void { this.#record(() => this.dependencies.store.recover()); }
  hasRecorded(id: string): boolean {
    try { return this.dependencies.store.hasRecorded?.(id) ?? false; }
    catch {
      this.#degraded = true;
      try { this.dependencies.store.markDegraded(); } catch { /* A later numeric write retries the flag. */ }
      return false;
    }
  }
  begin(context: UsageContext, identity?: { id: string; at?: string }): UsageSession {
    const id = identity?.id ?? this.dependencies.id();
    let recorded = this.#record(() => this.dependencies.store.begin(id, context, identity?.at ?? this.dependencies.now()));
    return { id,
      isRecorded: () => recorded,
      record: (observation) => { recorded = this.#record(() => this.dependencies.store.observe(id, { ...observation, tokens: validateTokenUsage(observation.tokens) }, identity?.at ?? this.dependencies.now())) && recorded; },
      finish: (status) => { recorded = this.#record(() => this.dependencies.store.finish(id, status)) && recorded; },
    };
  }
  query(input: StatisticsQuery): StatisticsDto {
    const query = validateStatisticsQuery({ ...input });
    // Bound the SQLite scan before timezone bucketing. All IANA offsets fit within this margin.
    const fromUtc = new Date(Date.parse(query.from) - 86_400_000).toISOString();
    const toUtc = new Date(Date.parse(query.to) + 2 * 86_400_000).toISOString();
    const snapshot = this.dependencies.store.snapshot(fromUtc, toUtc);
    return aggregateStatistics(snapshot, query, this.dependencies.now(), this.#degraded || snapshot.collectionDegraded === true);
  }
}
