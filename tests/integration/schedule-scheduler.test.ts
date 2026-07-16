import { ScheduleScheduler } from "../../src/main/application/rhythm/schedule-scheduler";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("default Schedule Scheduler", () => {
  it("fires each due local schedule once per Life local date under concurrent ticks", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.50/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "作息", timezone: "UTC" });
      fixture.clock.advance(10 * 60 * 60_000);
      const scheduler = new ScheduleScheduler({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store });

      const [first, concurrent] = await Promise.all([scheduler.tick(), scheduler.tick()]);
      expect([...first, ...concurrent]).toHaveLength(3);
      expect((await fixture.database.store.listLifeEvents(life.lifeId)).map((event) => event.type).sort()).toEqual([
        "schedule.evening_review",
        "schedule.memory_metabolism",
        "schedule.morning_plan",
      ]);
      expect(await scheduler.tick()).toEqual([]);
      fixture.clock.advance(24 * 60 * 60_000);
      expect(await scheduler.tick()).toHaveLength(3);
    } finally {
      await fixture.close();
    }
  });
});
