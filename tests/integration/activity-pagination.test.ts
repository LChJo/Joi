import { EventService } from "../../src/main/application/events/event-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("bounded activity projections", () => {
  it("pages newest events by opaque-ready facts and exposes safe Wake/Turn/Flow summaries", async () => {
    const fixture = await createRuntimeFixture();
    const events = new EventService({
      clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store,
    });
    const lifeRuntime = new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store });
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.50/card.json", name: "活动 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId, name: "活动生命", personaSummary: "验证有界投影", timezone: "UTC",
      });
      await lifeRuntime.start(life.lifeId);
      for (const text of ["第一条", "第二条", "第三条"]) {
        await events.ingest({ lifeId: life.lifeId, payload: { text }, source: "human", type: "human.message" });
      }

      const first = await events.list(life.lifeId, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.next).toBeDefined();
      if (first.next === undefined) throw new Error("missing event cursor");
      const second = await events.list(life.lifeId, { before: first.next, limit: 2 });
      expect(second.items).toHaveLength(2);
      expect(new Set([...first.items, ...second.items].map((event) => event.eventId)).size).toBe(4);

      const now = fixture.clock.now().toISOString();
      const claimed = await fixture.database.store.claimWake({
        allowedEventTypes: ["system.birth", "human.message"], autonomousExemptEventTypes: ["human.message"],
        budgetLocalDate: "2026-07-15", expiresAt: "2026-07-15T12:05:00.000Z", leaseOwner: "activity-test",
        lifeId: life.lifeId, maxBytes: 64 * 1024, maxEvents: 50, now, wakeId: "wake_activity",
      });
      expect(claimed).not.toBeNull();
      await fixture.database.store.createWakeTurn({ messageId: "message_activity", now, turnId: "turn_activity", wakeId: "wake_activity" });
      const activity = await events.activity(life.lifeId);
      expect(activity).toEqual(expect.arrayContaining([
        expect.objectContaining({ activityId: "wake_activity", kind: "WAKE", status: "RUNNING", title: "主 Agent Wake" }),
        expect.objectContaining({ activityId: "turn_activity", kind: "TURN", status: "RUNNING", title: "主 Agent Turn 1" }),
        expect.objectContaining({ kind: "FLOW", status: "TurnStarted", title: "主 Agent Turn 开始" }),
      ]));
      expect(JSON.stringify(activity)).not.toContain("第一条");
      expect(JSON.stringify(activity)).not.toContain("192.168");
    } finally {
      await fixture.close();
    }
  });

  it("loads the first timeline page in under one second with 100,000 persisted activities", async () => {
    const fixture = await createRuntimeFixture();
    const events = new EventService({
      clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store,
    });
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.51/card.json", name: "性能 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId, name: "十万活动生命", personaSummary: "验证时间线首屏", timezone: "UTC",
      });
      fixture.database.transaction((database) => database.prepare(`
        WITH digits(d) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
        generated(n) AS (
          SELECT a.d + b.d * 10 + c.d * 100 + d.d * 1000 + e.d * 10000
            FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
        )
        INSERT INTO life_events
          (event_id, life_id, event_type, source, priority, occurred_at, available_at, payload_json, status, created_at)
        SELECT printf('event_perf_%06d', n), ?, 'human.message', 'human', 1,
               '2026-07-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z', '{"text":"bounded"}', 'CONSUMED',
               '2026-07-15T12:00:00.000Z'
          FROM generated`).run(life.lifeId));

      const started = performance.now();
      const page = await events.list(life.lifeId, { limit: 100 });
      const elapsed = performance.now() - started;
      expect(page.items).toHaveLength(100);
      expect(page.next).toBeDefined();
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      await fixture.close();
    }
  }, 15_000);
});
