import { RhythmPolicy } from "../../domain/rhythm/rhythm-policy.js";
import type { EventService } from "../events/event-service.js";
import type { Clock, RuntimeStore } from "../ports/runtime-store.js";

export class IdleExplorationScheduler {
  private readonly rhythm = new RhythmPolicy();

  constructor(private readonly dependencies: {
    clock: Clock;
    events: EventService;
    notify?: (lifeId: string) => void;
    store: RuntimeStore;
  }) {}

  async tick(): Promise<string[]> {
    const now = this.dependencies.clock.now();
    const created: string[] = [];
    let after: { createdAt: string; lifeId: string } | undefined;
    do {
      const page = await this.dependencies.store.listLives({ ...(after === undefined ? {} : { after }), limit: 100 });
      for (const life of page.items) {
        if (life.state !== "SLEEPING" || now.getTime() - Date.parse(life.updatedAt) < 120 * 60_000
          || this.rhythm.isQuiet(now, life.timezone, { end: life.quietEnd, start: life.quietStart })) continue;
        const pending = (await this.dependencies.store.listLifeEvents(life.lifeId)).some((event) => event.status === "PENDING");
        if (pending) continue;
        const localDate = this.rhythm.localDate(now, life.timezone);
        const budget = await this.dependencies.store.getDailyBudget(life.lifeId, localDate, now.toISOString());
        if (budget.idleExplorationsUsed >= budget.idleExplorationsLimit) continue;
        const event = await this.dependencies.events.ingest({
          dedupeKey: `${localDate}:${String(budget.idleExplorationsUsed)}`,
          lifeId: life.lifeId,
          payload: { idleMinutes: Math.floor((now.getTime() - Date.parse(life.updatedAt)) / 60_000) },
          source: "system",
          type: "idle.explore",
        });
        created.push(event.eventId);
        this.dependencies.notify?.(life.lifeId);
      }
      after = page.next;
    } while (after !== undefined);
    return created;
  }
}
