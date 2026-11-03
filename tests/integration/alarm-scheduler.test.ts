import { AlarmScheduler } from "../../src/main/application/rhythm/alarm-scheduler";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("Alarm Scheduler", () => {
  it("atomically creates one occurrence event and only then advances recurring alarms", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.40/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "作息", timezone: "UTC" });
      fixture.database.transaction((database) => database.prepare(`
        INSERT INTO alarms
          (alarm_id, life_id, reason, next_at, repeat_every_minutes, status, created_at, updated_at)
        VALUES ('alarm_repeat', ?, '每小时复查', '2026-07-15T12:00:00.000Z', 60, 'SCHEDULED', ?, ?)`)
        .run(life.lifeId, fixture.clock.now().toISOString(), fixture.clock.now().toISOString()));
      const scheduler = new AlarmScheduler({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store });

      const [first, concurrent] = await Promise.all([scheduler.tick(), scheduler.tick()]);
      expect([...first, ...concurrent]).toHaveLength(1);
      expect((await fixture.database.store.listLifeEvents(life.lifeId)).filter((event) => event.type === "alarm.fired")).toHaveLength(1);
      expect(await fixture.database.store.listAlarms(life.lifeId)).toEqual([
        expect.objectContaining({ nextAt: "2026-07-15T13:00:00.000Z", status: "SCHEDULED" }),
      ]);

      expect(await scheduler.tick()).toEqual([]);
      fixture.clock.advance(60 * 60_000);
      expect(await scheduler.tick()).toHaveLength(1);
      expect((await fixture.database.store.listLifeEvents(life.lifeId)).filter((event) => event.type === "alarm.fired")).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });

  it("defers ordinary alarms to the end of per-Life quiet hours and honors explicit override", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.41/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "安静生命", personaSummary: "作息", timezone: "UTC" });
      await fixture.database.store.updateLifeRhythm({
        autonomousWakesDefault: 24, idleExplorationsDefault: 3, invocationsDefault: 100, lifeId: life.lifeId,
        now: fixture.clock.now().toISOString(), quietEnd: "13:00", quietStart: "11:00",
      });
      fixture.database.transaction((database) => database.prepare(`
        INSERT INTO alarms
          (alarm_id, life_id, reason, next_at, repeat_every_minutes, creator, allow_quiet_hours, status, created_at, updated_at)
        VALUES
          ('alarm_quiet', ?, '稍后提醒', '2026-07-15T12:00:00.000Z', NULL, 'HUMAN', 0, 'SCHEDULED', ?, ?),
          ('alarm_override', ?, '立即提醒', '2026-07-15T12:00:00.000Z', NULL, 'HUMAN', 1, 'SCHEDULED', ?, ?)`)
        .run(life.lifeId, fixture.clock.now().toISOString(), fixture.clock.now().toISOString(),
          life.lifeId, fixture.clock.now().toISOString(), fixture.clock.now().toISOString()));
      const scheduler = new AlarmScheduler({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store });

      expect(await scheduler.tick()).toHaveLength(1);
      expect(await fixture.database.store.listAlarms(life.lifeId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ alarmId: "alarm_quiet", allowQuietHours: false, creator: "HUMAN", nextAt: "2026-07-15T13:00:00.000Z" }),
        expect.objectContaining({ alarmId: "alarm_override", allowQuietHours: true, status: "FIRED" }),
      ]));
      fixture.clock.advance(60 * 60_000);
      expect(await scheduler.tick()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("advances calendar recurrence in the Life timezone and skips weekends", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.42/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "工作日生命", personaSummary: "作息", timezone: "UTC" });
      fixture.clock.advance(2 * 24 * 60 * 60_000);
      fixture.database.transaction((database) => database.prepare(`
        INSERT INTO alarms
          (alarm_id, life_id, reason, next_at, recurrence_rule, creator, allow_quiet_hours, status, created_at, updated_at)
        VALUES ('alarm_weekdays', ?, '工作日提醒', '2026-07-17T12:00:00.000Z', 'WEEKDAYS', 'HUMAN', 1, 'SCHEDULED', ?, ?)`)
        .run(life.lifeId, fixture.clock.now().toISOString(), fixture.clock.now().toISOString()));
      const scheduler = new AlarmScheduler({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store });
      expect(await scheduler.tick()).toHaveLength(1);
      expect(await fixture.database.store.listAlarms(life.lifeId)).toEqual([
        expect.objectContaining({ nextAt: "2026-07-20T12:00:00.000Z", recurrenceRule: "WEEKDAYS", status: "SCHEDULED" }),
      ]);
    } finally {
      await fixture.close();
    }
  });
});
