import { EventService } from "../../src/main/application/events/event-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";
import { claimTestWake } from "../support/wake-fixture";

async function createLife(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>) {
  const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.20/card.json", name: "主 Agent" });
  await fixture.agents.activateForReadiness(agent.agentConnectionId);
  return fixture.lives.create({
    mainAgentConnectionId: agent.agentConnectionId,
    name: "栖遥",
    personaSummary: "保持长期连续性",
    timezone: "Asia/Shanghai",
  });
}

function services(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>) {
  const signal = new InMemoryEventSignal();
  const events = new EventService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal, store: fixture.database.store });
  return {
    events,
    lifeRuntime: new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }),
    signal,
  };
}

describe("persistent Life events and Wake arbitration", () => {
  it("starts with birth, deduplicates ingress, orders eligible events and keeps future/unknown events out", async () => {
    const fixture = await createRuntimeFixture();
    const life = await createLife(fixture);
    const runtime = services(fixture);
    try {
      expect(await runtime.lifeRuntime.start(life.lifeId)).toMatchObject({ state: "SLEEPING" });
      const message = await runtime.events.ingest({
        dedupeKey: "client-message-1",
        lifeId: life.lifeId,
        payload: { text: "今天先整理计划" },
        source: "human",
        type: "human.message",
      });
      const duplicate = await runtime.events.ingest({
        dedupeKey: "client-message-1",
        lifeId: life.lifeId,
        payload: { text: "这份重复正文不能覆盖第一次" },
        source: "human",
        type: "human.message",
      });
      expect(duplicate.eventId).toBe(message.eventId);
      expect(duplicate.payload).toEqual({ text: "今天先整理计划" });
      const future = await runtime.events.ingest({
        availableAt: "2026-07-16T12:00:00.000Z",
        lifeId: life.lifeId,
        payload: { alarmId: "alarm_future", occurrenceAt: "2026-07-16T12:00:00.000Z" },
        source: "schedule",
        type: "alarm.fired",
      });
      const unknown = await runtime.events.ingest({ lifeId: life.lifeId, payload: { data: true }, source: "system", type: "extension.unknown" });
      expect(unknown.status).toBe("DEFERRED");

      const bundle = await claimTestWake({ clock: fixture.clock, ids: fixture.ids, leaseOwner: "runtime-a", lifeId: life.lifeId, store: fixture.database.store });
      expect(bundle).not.toBeNull();
      expect(bundle?.events.map((event) => event.type)).toEqual(["system.birth", "human.message"]);
      expect(bundle?.events.every((event) => event.status === "CLAIMED")).toBe(true);
      expect(await claimTestWake({ clock: fixture.clock, ids: fixture.ids, leaseOwner: "runtime-b", lifeId: life.lifeId, store: fixture.database.store })).toBeNull();
      expect((await fixture.database.store.getLifeEvent(future.eventId))?.status).toBe("PENDING");
      expect((await fixture.lives.get(life.lifeId)).state).toBe("RUNNING");
    } finally {
      await fixture.close();
    }
  });

  it("persists running-time ingress once and only signals the eventId for a later Turn", async () => {
    const fixture = await createRuntimeFixture();
    const life = await createLife(fixture);
    const runtime = services(fixture);
    try {
      await runtime.lifeRuntime.start(life.lifeId);
      const wake = await claimTestWake({ clock: fixture.clock, ids: fixture.ids, leaseOwner: "runtime-a", lifeId: life.lifeId, store: fixture.database.store });
      if (wake === null) throw new Error("missing Wake");
      const received: string[] = [];
      const unsubscribe = runtime.signal.subscribe(wake.wake.wakeId, (eventId) => received.push(eventId));
      const message = await runtime.events.ingest({
        lifeId: life.lifeId, payload: { text: "运行中插话" }, source: "human", type: "human.message",
      });
      unsubscribe();
      expect(received).toEqual([message.eventId]);
      expect((await fixture.database.store.getLifeEvent(message.eventId))?.status).toBe("PENDING");
      expect(wake.events.map((event) => event.eventId)).not.toContain(message.eventId);
    } finally {
      await fixture.close();
    }
  });

  it("quarantines invalid registered payloads without waking the Life", async () => {
    const fixture = await createRuntimeFixture();
    const life = await createLife(fixture);
    const runtime = services(fixture);
    try {
      await runtime.lifeRuntime.start(life.lifeId);
      const invalid = await runtime.events.ingest({ lifeId: life.lifeId, payload: { text: "" }, source: "human", type: "human.message" });
      expect(invalid.status).toBe("DEAD_LETTER");
      expect(await fixture.database.store.getActiveWake(life.lifeId)).toBeNull();
      await expect(runtime.lifeRuntime.pause("life_missing")).rejects.toMatchObject({ code: "life_not_found" });
      await expect(runtime.lifeRuntime.resume("life_missing")).rejects.toMatchObject({ code: "life_not_found" });
    } finally {
      await fixture.close();
    }
  });

  it("emergency-stops an active Wake and returns its uncommitted events to the queue", async () => {
    const fixture = await createRuntimeFixture();
    const life = await createLife(fixture);
    const runtime = services(fixture);
    try {
      await runtime.lifeRuntime.start(life.lifeId);
      const bundle = await claimTestWake({ clock: fixture.clock, ids: fixture.ids, leaseOwner: "runtime-a", lifeId: life.lifeId, store: fixture.database.store });
      if (bundle === null) throw new Error("missing Wake");
      expect(await runtime.lifeRuntime.emergencyStop(life.lifeId)).toMatchObject({ state: "PAUSED" });
      expect(await fixture.database.store.getWake(bundle.wake.wakeId)).toMatchObject({ status: "CANCELED" });
      expect((await fixture.database.store.getLifeEvent(bundle.events[0]?.eventId ?? ""))?.status).toBe("PENDING");
      expect(await fixture.database.store.getActiveWake(life.lifeId)).toBeNull();
    } finally {
      await fixture.close();
    }
  });
});
