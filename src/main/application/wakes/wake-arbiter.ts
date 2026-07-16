import { EVENT_TYPE_REGISTRY } from "../../domain/events/event-type-registry.js";
import { RhythmPolicy } from "../../domain/rhythm/rhythm-policy.js";
import type { Clock, IdGenerator, RuntimeStore, SsePublisher } from "../ports/runtime-store.js";

export class WakeArbiter {
  private readonly rhythm = new RhythmPolicy();

  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; publisher?: SsePublisher; store: RuntimeStore }) {}

  async claim(lifeId: string, leaseOwner: string) {
    const now = this.dependencies.clock.now();
    const life = await this.dependencies.store.getLife(lifeId);
    if (life === null) return null;
    const result = await this.dependencies.store.claimWake({
      allowedEventTypes: EVENT_TYPE_REGISTRY.types().filter((type) => EVENT_TYPE_REGISTRY.definition(type)?.autoWake === true),
      autonomousExemptEventTypes: ["human.auth_resolved", "human.input_answered", "human.message", "system.recovery"],
      budgetLocalDate: this.rhythm.localDate(now, life.timezone),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
      leaseOwner,
      lifeId,
      maxBytes: 64 * 1024,
      maxEvents: 50,
      now: now.toISOString(),
      wakeId: this.dependencies.ids.next("wake"),
    });
    if (result === null) {
      const current = await this.dependencies.store.getLife(lifeId);
      const active = await this.dependencies.store.getActiveWake(lifeId);
      if (current?.state === "QUEUED" && active === null) {
        await this.dependencies.store.setLifeState(lifeId, "SLEEPING", now.toISOString());
        const event = await this.dependencies.store.appendSseEvent({
          entityId: lifeId,
          payload: { lifeId, reason: "no_executable_events", state: "SLEEPING" },
          type: "life.state.changed",
        });
        await this.dependencies.publisher?.publish(event);
      }
    }
    if (result !== null && this.dependencies.publisher !== undefined) {
      for (const event of result.sse) await this.dependencies.publisher.publish(event);
    }
    return result;
  }
}
