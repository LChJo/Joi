import { DomainError } from "../../domain/errors.js";
import type { ConnectionBreakerStore } from "../ports/a2a-ports.js";
import type { Clock, RuntimeStore } from "../ports/runtime-store.js";

const MIN_COOLDOWN_MS = 10_000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

export class PersistentConnectionBreaker {
  constructor(private readonly dependencies: {
    clock: Clock;
    store: ConnectionBreakerStore & Pick<RuntimeStore, "createManifestHash">;
  }) {}

  keyFor(input: { agentConnectionId: string; credentialVersion: number; origin: string }): string {
    return this.dependencies.store.createManifestHash({
      agentConnectionId: input.agentConnectionId,
      credentialVersion: input.credentialVersion,
      origin: input.origin,
    });
  }

  async assertAvailable(key: string): Promise<void> {
    const now = this.dependencies.clock.now();
    // Opportunistically reap lapsed breaker rows so the table and the openBreakers metric
    // do not accumulate expired entries forever (they were previously never cleaned up).
    await this.dependencies.store.deleteExpiredConnectionBreakers(now.toISOString());
    const record = await this.dependencies.store.getConnectionBreaker(key);
    if (record !== null && Date.parse(record.openUntil) > now.getTime()) {
      throw new DomainError("agent_rate_limited", "Agent connection is cooling down after a retryable response.");
    }
  }

  async recordRetryableResponse(input: { key: string; retryAfter: string | null; status: 429 | 503 }): Promise<{ openUntil: string }> {
    const now = this.dependencies.clock.now();
    const duration = this.retryAfterMilliseconds(input.retryAfter, now);
    const openUntil = new Date(now.getTime() + duration).toISOString();
    const current = await this.dependencies.store.getConnectionBreaker(input.key);
    const effectiveOpenUntil = current !== null && current.openUntil > openUntil ? current.openUntil : openUntil;
    await this.dependencies.store.saveConnectionBreaker({
      breakerKey: input.key,
      lastStatus: input.status,
      openUntil: effectiveOpenUntil,
      updatedAt: now.toISOString(),
    });
    return { openUntil: effectiveOpenUntil };
  }

  private retryAfterMilliseconds(value: string | null, now: Date): number {
    let milliseconds = MIN_COOLDOWN_MS;
    if (value !== null && /^\d+$/.test(value.trim())) {
      milliseconds = Number(value.trim()) * 1000;
    } else if (value !== null) {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) milliseconds = timestamp - now.getTime();
    }
    return Math.max(MIN_COOLDOWN_MS, Math.min(MAX_COOLDOWN_MS, milliseconds));
  }
}
