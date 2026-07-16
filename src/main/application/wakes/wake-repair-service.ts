import { EventRetryPolicy } from "../../domain/events/event-retry-policy.js";
import { EVENT_TYPE_REGISTRY } from "../../domain/events/event-type-registry.js";
import { DomainError } from "../../domain/errors.js";
import type { Clock, IdGenerator, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";

export class WakeRepairService {
  private readonly retryPolicy = new EventRetryPolicy();

  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; publisher: SsePublisher; store: RuntimeStore }) {}

  async handleInvalid(input: { errors: string[]; output: unknown; turnId: string; wakeId: string }) {
    const wake = await this.dependencies.store.getWake(input.wakeId);
    if (wake === null) throw new DomainError("wake_not_found", "Wake was not found.");
    const outputHash = this.dependencies.store.createManifestHash({ output: input.output });
    if (wake.repairCount === 0) {
      await this.dependencies.store.incrementWakeRepair(input.wakeId, this.dependencies.clock.now().toISOString());
      return {
        payload: { errors: input.errors.slice(0, 20), outputHash, turnId: input.turnId, wakeId: input.wakeId },
        repair: true as const,
      };
    }

    const now = this.dependencies.clock.now();
    const events = await this.dependencies.store.listWakeEvents(input.wakeId);
    const evaluated = events.map((event) => {
      const attemptCount = event.attemptCount + 1;
      const maxAttempts = EVENT_TYPE_REGISTRY.definition(event.type)?.maxAttempts ?? 1;
      return { event, result: this.retryPolicy.afterFailure({ attemptCount, maxAttempts, now }) };
    });
    const commonAvailableAt = evaluated
      .filter((item) => item.result.status === "PENDING")
      .map((item) => item.result.status === "PENDING" ? item.result.availableAt : now.toISOString())
      .sort()
      .at(-1);
    const recoveryAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const result = await this.dependencies.store.failWakeProtocol({
      eventUpdates: evaluated.map(({ event, result: retry }) => ({
        attemptCount: retry.attemptCount,
        eventId: event.eventId,
        status: retry.status,
        ...(retry.status === "PENDING" ? { availableAt: commonAvailableAt ?? retry.availableAt } : {}),
      })),
      now: now.toISOString(),
      recoveryEvent: {
        attemptCount: 0,
        availableAt: recoveryAt,
        createdAt: now.toISOString(),
        dedupeKey: `protocol:${input.wakeId}`,
        eventId: this.dependencies.ids.next("event"),
        lifeId: wake.lifeId,
        occurredAt: now.toISOString(),
        payload: { failedWakeId: input.wakeId, outputHash },
        priority: 0,
        source: "system",
        status: "PENDING",
        type: "system.recovery",
      },
      wakeId: input.wakeId,
    });
    for (const event of result.sse) await this.dependencies.publisher.publish(event);
    return { repair: false as const, status: "FAILED_PROTOCOL" as const };
  }
}
