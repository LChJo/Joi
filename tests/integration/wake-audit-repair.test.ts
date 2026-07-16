import { EventService } from "../../src/main/application/events/event-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { WakeAuditService } from "../../src/main/application/wakes/wake-audit-service";
import { WakeArbiter } from "../../src/main/application/wakes/wake-arbiter";
import { WakeRepairService } from "../../src/main/application/wakes/wake-repair-service";
import { WakeRecoveryService } from "../../src/main/application/wakes/wake-recovery-service";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";

async function setupWake(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>) {
  const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.20/card.json", name: "主 Agent" });
  await fixture.agents.activateForReadiness(agent.agentConnectionId);
  const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "连续", timezone: "UTC" });
  const events = new EventService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store });
  await new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }).start(life.lifeId);
  const bundle = await new WakeArbiter({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store }).claim(life.lifeId, "runtime-a");
  if (bundle === null) throw new Error("missing Wake");
  return { bundle, life };
}

describe("Wake Turn and Injection audit", () => {
  it("records stable Turn order, source-only injections and heartbeat", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { bundle } = await setupWake(fixture);
      const audit = new WakeAuditService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store });
      const turn = await audit.beginTurn({ messageId: "message_stable_1", wakeId: bundle.wake.wakeId });
      expect(turn).toMatchObject({ messageId: "message_stable_1", status: "RUNNING", turnNumber: 1 });
      const injections = await audit.recordInjections({
        sources: bundle.events.map((event) => ({ sourceId: event.eventId, sourceType: "event" as const })),
        turnId: turn.turnId,
        wakeId: bundle.wake.wakeId,
      });
      expect(injections.map((item) => item.sourceId)).toEqual(bundle.events.map((event) => event.eventId));
      expect(JSON.stringify(injections)).not.toContain("system.birth");
      fixture.clock.advance(5_000);
      await audit.heartbeat(turn.turnId);
      expect((await fixture.database.store.listWakeTurns(bundle.wake.wakeId))[0]?.lastActivityAt).toBe("2026-07-15T12:00:05.000Z");

      for (let index = 2; index <= 4; index += 1) {
        await audit.beginTurn({ messageId: `message_stable_${String(index)}`, wakeId: bundle.wake.wakeId });
      }
      await expect(audit.beginTurn({ messageId: "message_stable_5", wakeId: bundle.wake.wakeId })).rejects.toMatchObject({ code: "wake_turn_limit" });
    } finally {
      await fixture.close();
    }
  });
});

describe("Wake protocol repair", () => {
  it("allows one bounded repair then releases original events with retry and a recovery event", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { bundle, life } = await setupWake(fixture);
      const repair = new WakeRepairService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store });
      const first = await repair.handleInvalid({ errors: ["actions[0].kind is unknown"], output: "private invalid output", turnId: "turn_1", wakeId: bundle.wake.wakeId });
      expect(first).toMatchObject({ repair: true, payload: { turnId: "turn_1", wakeId: bundle.wake.wakeId } });
      expect(JSON.stringify(first)).not.toContain("private invalid output");
      if (!("payload" in first)) throw new Error("first invalid envelope should request repair");
      expect(first.payload.outputHash).toMatch(/^[a-f0-9]{64}$/);

      const second = await repair.handleInvalid({ errors: ["still invalid"], output: "still private", turnId: "turn_2", wakeId: bundle.wake.wakeId });
      expect(second).toMatchObject({ repair: false, status: "FAILED_PROTOCOL" });
      expect((await fixture.database.store.getWake(bundle.wake.wakeId))?.status).toBe("FAILED_PROTOCOL");
      for (const event of bundle.events) {
        expect(await fixture.database.store.getLifeEvent(event.eventId)).toMatchObject({ attemptCount: 1, status: "PENDING" });
      }
      expect((await fixture.database.store.listLifeEvents(life.lifeId)).some((event) => event.type === "system.recovery")).toBe(true);
      expect((await fixture.lives.get(life.lifeId)).state).toBe("SLEEPING");
    } finally {
      await fixture.close();
    }
  });
});

describe("stale Wake recovery", () => {
  it("uses startup grace before releasing claimed events and the lease", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { bundle, life } = await setupWake(fixture);
      const recovery = new WakeRecoveryService({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store });
      expect(await recovery.recover()).toEqual([]);
      fixture.clock.advance(60_001);
      expect(await recovery.recover()).toEqual([bundle.wake.wakeId]);
      expect(await fixture.database.store.getWake(bundle.wake.wakeId)).toMatchObject({ status: "CANCELED" });
      expect((await fixture.database.store.getLifeEvent(bundle.events[0]?.eventId ?? ""))?.status).toBe("PENDING");
      expect((await fixture.lives.get(life.lifeId)).state).toBe("QUEUED");
    } finally {
      await fixture.close();
    }
  });
});
