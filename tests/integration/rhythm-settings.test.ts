import { ContinuityService } from "../../src/main/application/continuity/continuity-service";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("editable Life rhythm settings", () => {
  it("persists schedule edits, quiet hours, and defaults for the next daily budget", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.71/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId, name: "作息生命", personaSummary: "可编辑节奏", timezone: "Asia/Shanghai",
      });
      const service = new ContinuityService({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store });
      const schedule = (await fixture.database.store.listSchedules(life.lifeId)).find((item) => item.kind === "morning_plan");
      if (schedule === undefined) throw new Error("missing morning schedule");

      await expect(service.updateSchedule(life.lifeId, schedule.scheduleId, { enabled: false, localTime: "09:30" }))
        .resolves.toMatchObject({ enabled: false, localTime: "09:30" });
      const updated = await service.updateRhythm(life.lifeId, {
        autonomousWakesDefault: 12,
        idleExplorationsDefault: 2,
        invocationsDefault: 40,
        quietEnd: "06:30",
        quietStart: "22:30",
      });
      expect(updated).toMatchObject({
        autonomousWakesDefault: 12,
        idleExplorationsDefault: 2,
        invocationsDefault: 40,
        quietEnd: "06:30",
        quietStart: "22:30",
      });
      expect((await service.snapshot(life.lifeId)).budget).toMatchObject({
        autonomousWakesLimit: 12, idleExplorationsLimit: 2, invocationsLimit: 40,
      });

      await expect(service.updateSchedule(life.lifeId, schedule.scheduleId, { enabled: true, localTime: "25:00" }))
        .rejects.toMatchObject({ code: "schedule_time_invalid" });
      await expect(service.updateRhythm(life.lifeId, {
        autonomousWakesDefault: -1, idleExplorationsDefault: 2, invocationsDefault: 40, quietEnd: "06:30", quietStart: "22:30",
      })).rejects.toMatchObject({ code: "budget_defaults_invalid" });
    } finally {
      await fixture.close();
    }
  });
});
