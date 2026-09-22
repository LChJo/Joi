import { aggregateStatistics, validateStatisticsQuery, validateTokenUsage } from "../../domain/statistics/statistics.js";
export { validateStatisticsQuery } from "../../domain/statistics/statistics.js";
import type { UsageContext, UsageRecorder, UsageSession, UsageStore } from "../ports/usage.js";
import type { StatisticsDto, StatisticsQuery } from "../../../shared/statistics.js";

export class StatisticsService implements UsageRecorder {
  #degraded = false;
  constructor(private readonly dependencies: { store: UsageStore; now: () => string; id: () => string }) {}
  #record(operation: () => void): void {
    try { operation(); } catch { this.#degraded = true; }
    if (this.#degraded) { try { this.dependencies.store.markDegraded(); } catch { /* Retry the numeric flag on the next write; never fail the user's task. */ } }
  }
  recover(): void { this.#record(() => this.dependencies.store.recover()); }
  begin(context: UsageContext): UsageSession {
    const id = this.dependencies.id();
    this.#record(() => this.dependencies.store.begin(id, context, this.dependencies.now()));
    return { id,
      record: (observation) => this.#record(() => this.dependencies.store.observe(id, { ...observation, tokens: validateTokenUsage(observation.tokens) }, this.dependencies.now())),
      finish: (status) => this.#record(() => this.dependencies.store.finish(id, status)),
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
