import { EventService } from "../../src/main/application/events/event-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { BudgetService } from "../../src/main/application/rhythm/budget-service";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";
import { claimTestWake } from "../support/wake-fixture";

describe("daily Life budgets", () => {
  it("pauses autonomous work while allowing a committed human message when invocation budget remains", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.60/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "预算", timezone: "UTC" });
      const events = new EventService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store });
      await new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }).start(life.lifeId);
      await fixture.database.store.getDailyBudget(life.lifeId, "2026-07-15", fixture.clock.now().toISOString());
      fixture.database.transaction((database) => database.prepare(`
        UPDATE daily_budgets SET autonomous_wakes_limit = 0, invocations_limit = 1 WHERE life_id = ? AND local_date = '2026-07-15'`)
        .run(life.lifeId));
      const claim = () => claimTestWake({ clock: fixture.clock, ids: fixture.ids, leaseOwner: "runtime-budget", lifeId: life.lifeId, store: fixture.database.store });
      expect(await claim()).toBeNull();
      expect((await fixture.lives.get(life.lifeId)).state).toBe("BUDGET_PAUSED");

      await events.ingest({ lifeId: life.lifeId, payload: { text: "请现在处理" }, source: "human", type: "human.message" });
      const notify = vi.fn();
      const budgets = new BudgetService({ clock: fixture.clock, events, notify, store: fixture.database.store });
      expect(await budgets.tick()).toEqual([life.lifeId]);
      expect(notify).toHaveBeenCalledWith(life.lifeId);
      expect(await claim()).not.toBeNull();
      expect(await fixture.database.store.getDailyBudget(life.lifeId, "2026-07-15", fixture.clock.now().toISOString()))
        .toMatchObject({ autonomousWakesUsed: 0, invocationsUsed: 1 });
      await expect(budgets.extend(life.lifeId, { autonomousWakes: 1, invocations: 2 }))
        .resolves.toMatchObject({ autonomousWakesLimit: 1, invocationsLimit: 3 });
      await expect(budgets.extend(life.lifeId, { autonomousWakes: -1, invocations: 0 })).rejects.toMatchObject({ code: "budget_extension_invalid" });
      await expect(budgets.extend("life_missing", { autonomousWakes: 1, invocations: 1 })).rejects.toMatchObject({ code: "life_not_found" });
    } finally {
      await fixture.close();
    }
  });
});
