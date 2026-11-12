import type { Clock, OutboxRecord, RuntimeStore } from "../ports/runtime-store.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
  type RuntimeDiagnostics,
} from "../ports/runtime-diagnostics.js";

export type OutboxHandler = (record: OutboxRecord) => Promise<void>;

export class OutboxDispatcher {
  #inFlight: Promise<number> | null = null;
  readonly #passes = new Set<Promise<number>>();
  #claiming = false;
  #closed = false;
  #backgroundError: Error | undefined;
  readonly #leaseDurationMs: number;
  readonly #renewIntervalMs: number;

  constructor(private readonly dependencies: {
    clock: Clock;
    diagnostics?: RuntimeDiagnostics;
    /** Kinds delivered by actors outside this dispatcher (e.g. partner.dispatch via agent actors). */
    excludeKinds?: string[];
    includeKinds?: string[];
    canStart?: () => boolean;
    /** Independent deliveries retain their claims while later batches may start. */
    concurrent?: boolean;
    leaseDurationMs?: number;
    renewIntervalMs?: number;
    handlers: Record<string, OutboxHandler>;
    onError?: (error: unknown, record: OutboxRecord) => void;
    onBackgroundError?: (error: unknown) => void;
    owner: string;
    store: RuntimeStore;
  }) {
    this.#leaseDurationMs = dependencies.leaseDurationMs ?? 30_000;
    this.#renewIntervalMs = dependencies.renewIntervalMs ?? Math.floor(this.#leaseDurationMs / 3);
    if (!Number.isSafeInteger(this.#leaseDurationMs) || this.#leaseDurationMs <= 0 || !Number.isSafeInteger(this.#renewIntervalMs)
      || this.#renewIntervalMs <= 0 || this.#renewIntervalMs >= this.#leaseDurationMs) throw new Error("outbox_lease_interval_invalid");
  }

  get isRunning(): boolean { return this.#passes.size > 0; }

  startOnce(limit = 1): boolean {
    if (this.#closed || this.#claiming || (this.dependencies.concurrent !== true && this.isRunning) || this.dependencies.canStart?.() === false) return false;
    void this.#begin(limit).catch((error: unknown) => {
      this.#backgroundError = error instanceof Error ? error : new Error("outbox_background_failed");
      try { this.dependencies.onBackgroundError?.(error); } catch { /* The delivery failure remains observable through drain. */ }
    });
    return true;
  }

  async drain(): Promise<void> {
    let failure: PromiseRejectedResult | undefined;
    while (this.#passes.size > 0) {
      const results = await Promise.allSettled([...this.#passes]);
      failure ??= results.find(result => result.status === "rejected");
    }
    if (failure !== undefined) { this.#backgroundError = undefined;throw failure.reason; }
    if (this.#backgroundError !== undefined) {
      const error = this.#backgroundError;
      this.#backgroundError = undefined;
      throw error;
    }
  }

  async close(): Promise<void> { this.#closed = true; await this.drain(); }

  async dispatchOnce(limit = 20): Promise<number> {
    if (this.#claiming || (this.dependencies.concurrent !== true && this.isRunning)) return this.#inFlight ?? 0;
    if (this.#closed || this.dependencies.canStart?.() === false) return 0;
    return this.#begin(limit);
  }

  #begin(limit: number): Promise<number> {
    if (!this.isRunning) this.#backgroundError = undefined;
    this.#claiming = true;
    const pass = Promise.resolve().then(() => this.#dispatchOnce(limit));
    this.#inFlight = pass;
    this.#passes.add(pass);
    const clear = () => { this.#passes.delete(pass);if (this.#inFlight === pass) this.#inFlight = null; };
    void pass.then(clear,clear);
    return pass;
  }

  #keepClaim(record: OutboxRecord) {
    const renew = this.dependencies.store.renewOutboxClaim?.bind(this.dependencies.store);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: Promise<void> | null = null;
    let renewAt = this.dependencies.clock.now().getTime() + this.#renewIntervalMs;
    const ensure = async () => {
      if (renew === undefined) return;
      const now = this.dependencies.clock.now().getTime();
      if (now < renewAt) return;
      if (!await renew({ outboxId: record.outboxId,owner: this.dependencies.owner,
        claimUntil: new Date(now + this.#leaseDurationMs).toISOString() })) throw new Error("outbox_claim_lost");
      renewAt = now + this.#renewIntervalMs;
    };
    const schedule = () => {
      if (stopped || renew === undefined) return;
      timer = setTimeout(() => {
        pending = ensure().catch(() => undefined).finally(() => { pending = null; schedule(); });
      },this.#renewIntervalMs);
    };
    schedule();
    return { ensure,stop: async () => { stopped = true; clearTimeout(timer); await pending; } };
  }

  async #claim(limit: number): Promise<OutboxRecord[]> {
    try {
      if (!this.#canDeliver()) return [];
      const now = this.dependencies.clock.now();
      return await this.dependencies.store.claimOutbox({
        claimUntil: new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
        ...(this.dependencies.excludeKinds === undefined ? {} : { excludeKinds: this.dependencies.excludeKinds }),
        ...(this.dependencies.includeKinds === undefined ? {} : { includeKinds: this.dependencies.includeKinds }),
        limit,
        now: now.toISOString(),
        owner: this.dependencies.owner,
      });
    } finally { this.#claiming = false; }
  }

  async #dispatchOnce(limit: number): Promise<number> {
    const records = await this.#claim(limit);
    if (records.length > 0) {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.outbox.claimed", { limit, recordCount: records.length });
    }
    const deliveries = records.map(record => ({ record,keeper: this.#keepClaim(record) }));
    let delivered = 0;
    try {
      const deliver = async ({ record,keeper }: (typeof deliveries)[number]) => {
        if (!this.#canDeliver()) {
          await keeper.stop();
          await this.dependencies.store.releaseOutbox({ outboxId: record.outboxId,owner: this.dependencies.owner,
            availableAt: this.dependencies.clock.now().toISOString(),preserveAttemptCount: true });
          return;
        }
        delivered++;
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
          await keeper.stop();
          await keeper.ensure();
          await this.dependencies.store.completeOutbox(record.outboxId, this.dependencies.owner);
          emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.outbox.delivery_completed", {
            attemptCount: record.attemptCount,
            durationMs: Math.max(0, this.dependencies.clock.now().getTime() - startedAt),
            kind: record.kind,
            outboxId: record.outboxId,
          });
        } catch (error) {
          await keeper.stop();
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
      };
      if (this.dependencies.concurrent === true) {
        const results = await Promise.allSettled(deliveries.map(deliver));
        const rejected = results.find(result => result.status === "rejected");
        if (rejected !== undefined) throw rejected.reason;
      } else {
        for (const delivery of deliveries) await deliver(delivery);
      }
      return delivered;
    } finally { await Promise.all(deliveries.map(({ keeper }) => keeper.stop())); }
  }

  #canDeliver(): boolean { return !this.#closed && this.dependencies.canStart?.() !== false; }
}
