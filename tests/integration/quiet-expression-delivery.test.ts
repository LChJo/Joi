import { EventService } from "../../src/main/application/events/event-service";
import { ContinuityService } from "../../src/main/application/continuity/continuity-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { ExpressionDeliveryScheduler } from "../../src/main/application/rhythm/expression-delivery-scheduler";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";
import { claimTestWake, commitTestWakeActions } from "../support/wake-fixture";

describe("quiet-hour expression delivery", () => {
  it("holds ordinary expressions until the Life quiet period ends", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.clock.advance(11 * 60 * 60_000);
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.61/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "安静作息", timezone: "UTC",
      });
      await new ContinuityService({ clock: fixture.clock, store: fixture.database.store }).updateRhythm(life.lifeId, {
        autonomousWakesDefault: 24,
        idleExplorationsDefault: 3,
        invocationsDefault: 100,
        quietEnd: "06:00",
        quietStart: "22:00",
      });
      const events = new EventService({
        clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store,
      });
      await new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }).start(life.lifeId);
      const bundle = await claimTestWake({ clock: fixture.clock, ids: fixture.ids, leaseOwner: "quiet-test", lifeId: life.lifeId, store: fixture.database.store });
      if (bundle === null) throw new Error("missing Wake");
      const result = await commitTestWakeActions({ clock: fixture.clock, envelope: {
        actionSetId: "aset_quiet",
        actions: [
          { actionId: "quiet_expression", kind: "express", text: "明早见。" },
          { actionId: "quiet_sleep", kind: "sleep", reason: "进入安静时段" },
        ],
        consciousnessResidue: "等待早晨表达。",
        continueWake: false,
        kind: "actions",
        turnId: "turn_quiet",
        version: 1,
        wakeId: bundle.wake.wakeId,
      }, expected: { allowedActions: ["express", "sleep"], turnId: "turn_quiet", wakeId: bundle.wake.wakeId }, publisher: fixture.sse, store: fixture.database.store });
      expect(result.expressions).toEqual([expect.objectContaining({ deliverAfter: "2026-07-16T06:00:00.000Z" })]);
      expect(result.sse.some((event) => event.type === "expression.created")).toBe(false);
      expect(await fixture.database.store.listExpressions(life.lifeId)).toEqual([]);

      const scheduler = new ExpressionDeliveryScheduler({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store });
      expect(await scheduler.tick()).toEqual([]);
      fixture.clock.advance(7 * 60 * 60_000);
      expect(await scheduler.tick()).toEqual(["expression_quiet_expression"]);
      expect(await fixture.database.store.listExpressions(life.lifeId)).toEqual([
        expect.objectContaining({ deliveredAt: "2026-07-16T06:00:00.000Z", text: "明早见。" }),
      ]);
      expect(await scheduler.tick()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
