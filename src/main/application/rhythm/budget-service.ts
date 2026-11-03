import { DomainError } from "../../domain/errors.js";
import { RhythmPolicy } from "../../domain/rhythm/rhythm-policy.js";
import type { EventService } from "../events/event-service.js";
import type { Clock, RuntimeStore } from "../ports/runtime-store.js";

export class BudgetService {
  private readonly rhythm = new RhythmPolicy();

  constructor(private readonly dependencies: {
    clock: Clock;
    events: EventService;
    notify?: (lifeId: string) => void;
    store: RuntimeStore;
  }) {}

  async tick(): Promise<string[]> {
    const resumed: string[] = [];
    let after: { createdAt: string; lifeId: string } | undefined;
    do {
      const page = await this.dependencies.store.listLives({ ...(after === undefined ? {} : { after }), limit: 100 });
      for (const life of page.items.filter((item) => item.state === "BUDGET_PAUSED")) {
        const now = this.dependencies.clock.now();
        const localDate = this.rhythm.localDate(now, life.timezone);
        const budget = await this.dependencies.store.getDailyBudget(life.lifeId, localDate, now.toISOString());
        const pending = (await this.dependencies.store.listLifeEvents(life.lifeId)).filter((event) => event.status === "PENDING" && event.availableAt <= now.toISOString());
        const decision = this.rhythm.authorize({
          autonomousLimit: budget.autonomousWakesLimit,
          autonomousUsed: budget.autonomousWakesUsed,
          eventTypes: pending.map((event) => event.type),
          invocationLimit: budget.invocationsLimit,
          invocationsUsed: budget.invocationsUsed,
        });
        if (!decision.allowed) continue;
        await this.dependencies.store.setLifeState(life.lifeId, "QUEUED", now.toISOString());
        await this.dependencies.events.ingest({
          dedupeKey: localDate,
          lifeId: life.lifeId,
          payload: { localDate },
          source: "system",
          type: "budget.reset",
        });
        resumed.push(life.lifeId);
        this.dependencies.notify?.(life.lifeId);
      }
      after = page.next;
    } while (after !== undefined);
    return resumed;
  }

  async extend(lifeId: string, additions: { autonomousWakes: number; invocations: number }) {
    if (!Number.isInteger(additions.autonomousWakes) || !Number.isInteger(additions.invocations)
      || additions.autonomousWakes < 0 || additions.invocations < 0
      || additions.autonomousWakes > 1000 || additions.invocations > 10_000) {
      throw new DomainError("budget_extension_invalid", "Budget additions are outside supported limits.");
    }
    const life = await this.dependencies.store.getLife(lifeId);
    if (life === null) throw new DomainError("life_not_found", "Life was not found.");
    const now = this.dependencies.clock.now();
    const budget = await this.dependencies.store.extendDailyBudget({
      ...additions,
      lifeId,
      localDate: this.rhythm.localDate(now, life.timezone),
      now: now.toISOString(),
    });
    await this.tick();
    return budget;
  }
}
