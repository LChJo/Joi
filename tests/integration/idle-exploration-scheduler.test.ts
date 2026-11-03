import { EventService } from "../../src/main/application/events/event-service";
import { IdleExplorationScheduler } from "../../src/main/application/rhythm/idle-exploration-scheduler";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("idle exploration", () => {
  it("creates one bounded event after 120 minutes and skips quiet hours or pending work", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.70/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "探索", timezone: "UTC" });
      await fixture.database.store.setLifeState(life.lifeId, "SLEEPING", fixture.clock.now().toISOString());
      const events = new EventService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store });
      const notify = vi.fn();
      const scheduler = new IdleExplorationScheduler({ clock: fixture.clock, events, notify, store: fixture.database.store });

      expect(await scheduler.tick()).toEqual([]);
      fixture.clock.advance(121 * 60_000);
      expect(await scheduler.tick()).toHaveLength(1);
      expect(await scheduler.tick()).toEqual([]);
      expect(notify).toHaveBeenCalledWith(life.lifeId);
      expect(await fixture.database.store.listLifeEvents(life.lifeId)).toEqual([
        expect.objectContaining({ status: "PENDING", type: "idle.explore" }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
