import { ActionProcessor } from "../../src/main/application/wakes/action-processor";
import { createRuntimeFixture } from "../support/runtime-fixture";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { EventService } from "../../src/main/application/events/event-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { WakeArbiter } from "../../src/main/application/wakes/wake-arbiter";

async function activeWake(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>) {
  const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.20/card.json", name: "主 Agent" });
  await fixture.agents.activateForReadiness(agent.agentConnectionId);
  const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "连续", timezone: "UTC" });
  const events = new EventService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store });
  await new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }).start(life.lifeId);
  const bundle = await new WakeArbiter({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store }).claim(life.lifeId, "runtime-a");
  if (bundle === null) throw new Error("missing Wake");
  return { bundle, life };
}

describe("atomic Life Action processing", () => {
  it("commits expressions, residue, action ids and event consumption in one transaction", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { bundle, life } = await activeWake(fixture);
      const processor = new ActionProcessor({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store });
      const envelope = {
        actionSetId: "aset_1",
        actions: [
          { actionId: "action_express", kind: "express", text: "我醒来了。" },
          { actionId: "action_sleep", kind: "sleep", reason: "等待下一事件" },
        ],
        consciousnessResidue: "已经完成出生回应，等待后续消息。",
        continueWake: false,
        kind: "actions",
        turnId: "turn_1",
        version: 1,
        wakeId: bundle.wake.wakeId,
      };
      const result = await processor.commit(envelope, { allowedActions: ["express", "sleep"], turnId: "turn_1", wakeId: bundle.wake.wakeId });
      expect(result).toMatchObject({ expressions: [expect.objectContaining({ text: "我醒来了。" })], state: "SLEEPING" });
      expect(await fixture.database.store.listWakeActions(bundle.wake.wakeId)).toHaveLength(2);
      expect(await fixture.database.store.listExpressions(life.lifeId)).toHaveLength(1);
      expect(await fixture.database.store.getConsciousnessResidue(life.lifeId)).toMatchObject({ text: envelope.consciousnessResidue });
      for (const event of bundle.events) expect((await fixture.database.store.getLifeEvent(event.eventId))?.status).toBe("CONSUMED");

      const replay = await processor.commit(envelope, { allowedActions: ["express", "sleep"], turnId: "turn_1", wakeId: bundle.wake.wakeId });
      expect(replay.expressions).toHaveLength(1);
      expect(await fixture.database.store.listExpressions(life.lifeId)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("rejects an invalid action set without partially consuming claimed events", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { bundle, life } = await activeWake(fixture);
      const processor = new ActionProcessor({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store });
      await expect(processor.commit({
        actionSetId: "aset_invalid",
        actions: [
          { actionId: "action_ok", kind: "express", text: "不能部分提交" },
          { actionId: "action_bad", kind: "shell.exec", command: "whoami" },
        ],
        consciousnessResidue: "",
        continueWake: false,
        kind: "actions",
        turnId: "turn_1",
        version: 1,
        wakeId: bundle.wake.wakeId,
      }, { allowedActions: ["express"], turnId: "turn_1", wakeId: bundle.wake.wakeId })).rejects.toMatchObject({ code: "action_schema_invalid" });
      expect(await fixture.database.store.listExpressions(life.lifeId)).toEqual([]);
      expect((await fixture.database.store.getLifeEvent(bundle.events[0]?.eventId ?? ""))?.status).toBe("CLAIMED");
    } finally {
      await fixture.close();
    }
  });
});
