import { DomainError } from "../../domain/errors.js";
import { transitionLifeState } from "../../domain/lives/life-state-machine.js";
import type { Clock, RuntimeStore } from "../ports/runtime-store.js";
import type { EventService } from "../events/event-service.js";

export class LifeRuntimeService {
  constructor(private readonly dependencies: { clock: Clock; events: EventService; store: RuntimeStore }) {}

  async start(lifeId: string) {
    const life = await this.requireLife(lifeId);
    const now = this.dependencies.clock.now().toISOString();
    const eventId = `event_birth_${lifeId}`;
    const result = await this.dependencies.store.startLifeWithBirth({
      event: {
        attemptCount: 0,
        availableAt: now,
        createdAt: now,
        dedupeKey: "system.birth",
        eventId,
        lifeId,
        occurredAt: now,
        payload: life.initialGoal === undefined ? {} : { initialGoal: life.initialGoal },
        priority: 1,
        source: "system",
        status: "PENDING",
        type: "system.birth",
      },
      lifeId,
      now,
    });
    await this.dependencies.events.publishPersisted(result.sse);
    return result.life;
  }

  async pause(lifeId: string) {
    const life = await this.requireLife(lifeId);
    if (life.state === "RUNNING") return this.emergencyStop(lifeId);
    return this.transition(lifeId, transitionLifeState(life.state, "PAUSE"));
  }

  async resume(lifeId: string) {
    return this.transition(lifeId, transitionLifeState("PAUSED", "RESUME"));
  }

  async stop(lifeId: string) {
    const life = await this.requireLife(lifeId);
    return this.transition(lifeId, transitionLifeState(life.state, "STOP"));
  }

  async emergencyStop(lifeId: string) {
    const result = await this.dependencies.store.emergencyStopLife(lifeId, this.dependencies.clock.now().toISOString());
    await this.dependencies.events.publishPersisted(result.sse);
    return result.life;
  }

  async stopRun(lifeId: string) {
    const result = await this.dependencies.store.cancelActiveWake(lifeId, this.dependencies.clock.now().toISOString());
    await this.dependencies.events.publishPersisted(result.sse);
    return result.life;
  }

  private async requireLife(lifeId: string) {
    const life = await this.dependencies.store.getLife(lifeId);
    if (life === null) throw new DomainError("life_not_found", "Life was not found.");
    return life;
  }

  private async transition(lifeId: string, state: Parameters<RuntimeStore["setLifeState"]>[1]) {
    const life = await this.dependencies.store.setLifeState(lifeId, state, this.dependencies.clock.now().toISOString());
    if (life === null) throw new DomainError("life_not_found", "Life was not found.");
    return life;
  }
}
