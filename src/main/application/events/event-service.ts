import { EVENT_TYPE_REGISTRY, type EventTypeRegistry } from "../../domain/events/event-type-registry.js";
import type { Clock, IdGenerator, SsePublisher } from "../ports/runtime-store.js";
import type { EventSignal, LifeEventSource, RuntimeCoreStore } from "../ports/runtime-core-ports.js";

export class EventService {
  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    publisher: SsePublisher;
    registry?: EventTypeRegistry;
    signal: EventSignal;
    store: RuntimeCoreStore;
  }) {}

  async ingest(input: {
    affairId?: string;
    attachmentIds?: string[];
    availableAt?: string;
    dedupeKey?: string;
    lifeId: string;
    occurredAt?: string;
    payload: Record<string, unknown>;
    source: LifeEventSource;
    type: string;
  }) {
    const registry = this.dependencies.registry ?? EVENT_TYPE_REGISTRY;
    const inspection = registry.inspect(input.type, input.payload);
    const definition = registry.definition(input.type);
    const now = this.dependencies.clock.now().toISOString();
    const result = await this.dependencies.store.createLifeEvent({
      attemptCount: 0,
      availableAt: input.availableAt ?? now,
      eventId: this.dependencies.ids.next("event"),
      lifeId: input.lifeId,
      occurredAt: input.occurredAt ?? now,
      payload: input.payload,
      priority: definition?.defaultPriority ?? 3,
      source: input.source,
      status: !inspection.registered ? "DEFERRED" : inspection.valid ? "PENDING" : "DEAD_LETTER",
      type: input.type,
      createdAt: now,
      ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds }),
      ...(input.affairId === undefined ? {} : { affairId: input.affairId }),
      ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
    });
    if (result.sse !== undefined) await this.dependencies.publisher.publish(result.sse);
    if (result.created && result.event.status === "PENDING" && result.activeWakeId !== undefined) {
      this.dependencies.signal.publish(result.activeWakeId, result.event.eventId);
    }
    return result.event;
  }

  async publishPersisted(events: Parameters<SsePublisher["publish"]>[0][]): Promise<void> {
    for (const event of events) await this.dependencies.publisher.publish(event);
  }

  list(lifeId: string, input: { before?: { eventId: string; occurredAt: string }; limit?: number } = {}) {
    return this.dependencies.store.listLifeEventsPage({
      ...(input.before === undefined ? {} : { before: input.before }),
      lifeId,
      limit: input.limit ?? 100,
    });
  }

  activity(lifeId: string, limit = 100) {
    return this.dependencies.store.listLifeRuntimeActivity(lifeId, limit);
  }
}
