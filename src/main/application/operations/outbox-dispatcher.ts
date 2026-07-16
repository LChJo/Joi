import type { Clock, OutboxRecord, RuntimeStore } from "../ports/runtime-store.js";

export type OutboxHandler = (record: OutboxRecord) => Promise<void>;

export class OutboxDispatcher {
  constructor(private readonly dependencies: {
    clock: Clock;
    handlers: Record<string, OutboxHandler>;
    onError?: (error: unknown, record: OutboxRecord) => void;
    owner: string;
    store: RuntimeStore;
  }) {}

  async dispatchOnce(limit = 20): Promise<number> {
    const now = this.dependencies.clock.now();
    const records = await this.dependencies.store.claimOutbox({
      claimUntil: new Date(now.getTime() + 30_000).toISOString(),
      limit,
      now: now.toISOString(),
      owner: this.dependencies.owner,
    });
    for (const record of records) {
      const handler = this.dependencies.handlers[record.kind];
      try {
        if (handler === undefined) throw new Error(`No outbox handler is registered for ${record.kind}.`);
        await handler(record);
        await this.dependencies.store.completeOutbox(record.outboxId, this.dependencies.owner);
      } catch (error) {
        const delayMinutes = Math.min(60, 2 ** Math.min(record.attemptCount, 6));
        await this.dependencies.store.releaseOutbox({
          availableAt: new Date(this.dependencies.clock.now().getTime() + delayMinutes * 60_000).toISOString(),
          outboxId: record.outboxId,
          owner: this.dependencies.owner,
        });
        this.dependencies.onError?.(error, record);
      }
    }
    return records.length;
  }
}
