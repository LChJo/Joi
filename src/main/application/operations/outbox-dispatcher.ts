import type { Clock, OutboxRecord, RuntimeStore } from "../ports/runtime-store.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
  type RuntimeDiagnostics,
} from "../ports/runtime-diagnostics.js";

export type OutboxHandler = (record: OutboxRecord) => Promise<void>;

export class OutboxDispatcher {
  #inFlight: Promise<number> | null = null;

  constructor(private readonly dependencies: {
    clock: Clock;
    diagnostics?: RuntimeDiagnostics;
    /** Kinds delivered by actors outside this dispatcher (e.g. partner.dispatch via agent actors). */
    excludeKinds?: string[];
    handlers: Record<string, OutboxHandler>;
    onError?: (error: unknown, record: OutboxRecord) => void;
    owner: string;
    store: RuntimeStore;
  }) {}

  async dispatchOnce(limit = 20): Promise<number> {
    if (this.#inFlight !== null) return this.#inFlight;
    const pass = this.#dispatchOnce(limit);
    this.#inFlight = pass;
    try {
      return await pass;
    } finally {
      if (this.#inFlight === pass) this.#inFlight = null;
    }
  }

  async #dispatchOnce(limit: number): Promise<number> {
    const now = this.dependencies.clock.now();
    const records = await this.dependencies.store.claimOutbox({
      claimUntil: new Date(now.getTime() + 30_000).toISOString(),
      ...(this.dependencies.excludeKinds === undefined ? {} : { excludeKinds: this.dependencies.excludeKinds }),
      limit,
      now: now.toISOString(),
      owner: this.dependencies.owner,
    });
    if (records.length > 0) {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.outbox.claimed", { limit, recordCount: records.length });
    }
    for (const record of records) {
      const handler = this.dependencies.handlers[record.kind];
      const startedAt = this.dependencies.clock.now().getTime();
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.outbox.delivery_started", {
        attemptCount: record.attemptCount,
        kind: record.kind,
        outboxId: record.outboxId,
      });
      try {
        if (handler === undefined) throw new Error(`No outbox handler is registered for ${record.kind}.`);
        await handler(record);
        await this.dependencies.store.completeOutbox(record.outboxId, this.dependencies.owner);
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.outbox.delivery_completed", {
          attemptCount: record.attemptCount,
          durationMs: Math.max(0, this.dependencies.clock.now().getTime() - startedAt),
          kind: record.kind,
          outboxId: record.outboxId,
        });
      } catch (error) {
        const delayMinutes = Math.min(60, 2 ** Math.min(record.attemptCount, 6));
        await this.dependencies.store.releaseOutbox({
          availableAt: new Date(this.dependencies.clock.now().getTime() + delayMinutes * 60_000).toISOString(),
          outboxId: record.outboxId,
          owner: this.dependencies.owner,
        });
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.outbox.delivery_released", {
          attemptCount: record.attemptCount,
          durationMs: Math.max(0, this.dependencies.clock.now().getTime() - startedAt),
          errorCode: runtimeDiagnosticErrorCode(error),
          kind: record.kind,
          outboxId: record.outboxId,
        });
        this.dependencies.onError?.(error, record);
      }
    }
    return records.length;
  }
}
