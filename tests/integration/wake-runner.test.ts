import { EventService } from "../../src/main/application/events/event-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { ActionProcessor } from "../../src/main/application/wakes/action-processor";
import { WakeArbiter } from "../../src/main/application/wakes/wake-arbiter";
import { WakeAuditService } from "../../src/main/application/wakes/wake-audit-service";
import { WakeContextAssembler } from "../../src/main/application/wakes/wake-context-assembler";
import { WakeRepairService } from "../../src/main/application/wakes/wake-repair-service";
import { WakeRunner, type WakeAgentExecutor } from "../../src/main/application/wakes/wake-runner";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("Wake Runner", () => {
  it("assembles bounded context and picks up committed ingress on a continued Turn", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.20/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId,
        name: "栖遥",
        personaSummary: "保持连续、自主但克制。",
        principles: ["先记录，再行动"],
        role: "长期同行者",
        timezone: "Asia/Shanghai",
      });
      const collaborator = await fixture.agents.createShell({ cardUrl: "http://192.168.1.22/card.json", name: "研究协作者" });
      fixture.database.transaction((database) => database.prepare(`
        UPDATE agent_connections
           SET status = 'COLLABORATOR_ONLY', readiness = 1, skills_json = '["research"]'
         WHERE agent_connection_id = ?`).run(collaborator.agentConnectionId));
      await fixture.database.store.bindCollaborator(life.lifeId, collaborator.agentConnectionId, fixture.clock.now().toISOString());
      const signal = new InMemoryEventSignal();
      const events = new EventService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal, store: fixture.database.store });
      await new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }).start(life.lifeId);
      const seen: Record<string, unknown>[] = [];
      const runnerRef: { current?: WakeRunner } = {};
      const executor: WakeAgentExecutor = {
        async execute(input) {
          seen.push(input.payload);
          if (seen.length === 1) {
            const activeRunner = runnerRef.current;
            if (activeRunner === undefined) throw new Error("runner is not initialized");
            expect(activeRunner.cancelLife("life_missing")).toBe(false);
            expect(activeRunner.cancelLife(life.lifeId)).toBe(true);
            await events.ingest({ lifeId: life.lifeId, payload: { text: "运行中到达" }, source: "human", type: "human.message" });
          }
          return {
            output: {
              actionSetId: `aset_${String(seen.length)}`,
              actions: [{ actionId: `express_${String(seen.length)}`, kind: "express", text: `第 ${String(seen.length)} 轮` }],
              consciousnessResidue: `轮次 ${String(seen.length)}`,
              continueWake: seen.length < 4,
              kind: "actions",
              turnId: input.turnId,
              version: 1,
              wakeId: input.wakeId,
            },
          };
        },
      };
      const runner = new WakeRunner({
        actions: new ActionProcessor({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store }),
        arbiter: new WakeArbiter({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store }),
        audit: new WakeAuditService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store }),
        clock: fixture.clock,
        context: new WakeContextAssembler({ clock: fixture.clock, store: fixture.database.store }),
        executor,
        ids: fixture.ids,
        repair: new WakeRepairService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store }),
        store: fixture.database.store,
      });
      runnerRef.current = runner;

      const result = await runner.runLife(life.lifeId, "runtime-a");
      if (result === null) throw new Error("expected the birth event to create a Wake");
      expect(result).toMatchObject({ status: "COMPLETED", turns: 4 });
      expect(seen).toHaveLength(4);
      expect(seen[0]).toMatchObject({
        collaborators: [{ agentId: collaborator.agentConnectionId, healthy: true, skills: ["research"] }],
        life: { lifeId: life.lifeId, principles: ["先记录，再行动"], role: "长期同行者" },
        protocol: { maxTurnsRemaining: 3 },
      });
      expect(seen[1]).toMatchObject({ events: [expect.objectContaining({ payload: { text: "运行中到达" }, type: "human.message" })] });
      const wakeId = result.wakeId;
      expect((await fixture.database.store.getWake(wakeId))?.status).toBe("COMPLETED");
      expect(await fixture.database.store.listWakeTurns(wakeId)).toHaveLength(4);
      expect(await fixture.database.store.listRuntimeInjections(wakeId)).toHaveLength(2);
      expect((await fixture.database.store.listLifeEvents(life.lifeId)).every((event) => event.status === "CONSUMED")).toBe(true);
      expect(await fixture.database.store.listExpressions(life.lifeId)).toHaveLength(4);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["repairs", [{ invalid: true }, "valid"] as const, "COMPLETED", 2],
    ["fails", [{ invalid: true }, { invalid: true }] as const, "FAILED_PROTOCOL", 2],
  ] as const)("%s an invalid Agent envelope with at most one repair Turn", async (_label, outputs, expectedStatus, expectedTurns) => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.21/card.json", name: "修复 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "栖遥", personaSummary: "连续", timezone: "UTC" });
      const events = new EventService({
        clock: fixture.clock,
        ids: fixture.ids,
        publisher: fixture.sse,
        signal: new InMemoryEventSignal(),
        store: fixture.database.store,
      });
      await new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }).start(life.lifeId);
      const calls: { kind: string; payload: Record<string, unknown> }[] = [];
      const executor: WakeAgentExecutor = {
        execute(input) {
          calls.push({ kind: input.kind, payload: input.payload });
          const candidate = outputs[calls.length - 1];
          const output = candidate === "valid" ? {
            actionSetId: "aset_repaired",
            actions: [{ actionId: "sleep_repaired", kind: "sleep", reason: "repaired" }],
            consciousnessResidue: "repaired",
            continueWake: false,
            kind: "actions",
            turnId: input.turnId,
            version: 1,
            wakeId: input.wakeId,
          } : candidate;
          return Promise.resolve({ output });
        },
      };
      const runner = new WakeRunner({
        actions: new ActionProcessor({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store }),
        arbiter: new WakeArbiter({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store }),
        audit: new WakeAuditService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store }),
        clock: fixture.clock,
        context: new WakeContextAssembler({ clock: fixture.clock, store: fixture.database.store }),
        executor,
        ids: fixture.ids,
        repair: new WakeRepairService({ clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store }),
        store: fixture.database.store,
      });

      const result = await runner.runLife(life.lifeId, "runtime-repair");
      expect(result).toMatchObject({ status: expectedStatus, turns: expectedTurns });
      expect(calls.map((call) => call.kind)).toEqual(["wake", "repair"]);
      expect(JSON.stringify(calls[1]?.payload)).not.toContain("invalid");
    } finally {
      await fixture.close();
    }
  });
});
