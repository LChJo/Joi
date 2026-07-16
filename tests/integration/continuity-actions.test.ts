import { EventService } from "../../src/main/application/events/event-service";
import { DelegationService } from "../../src/main/application/agents/delegation-service";
import type { A2aGatewayService } from "../../src/main/application/a2a/a2a-gateway-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { ActionProcessor } from "../../src/main/application/wakes/action-processor";
import { WakeArbiter } from "../../src/main/application/wakes/wake-arbiter";
import { WakeAuditService } from "../../src/main/application/wakes/wake-audit-service";
import { WakeContextAssembler } from "../../src/main/application/wakes/wake-context-assembler";
import { LIFE_ACTION_KINDS } from "../../src/main/domain/a2a/digital-life-envelope";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture } from "../support/runtime-fixture";

async function setup(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>) {
  const primary = await fixture.agents.createShell({ cardUrl: "http://192.168.1.30/card.json", name: "主 Agent" });
  await fixture.agents.activateForReadiness(primary.agentConnectionId);
  const collaborator = await fixture.agents.createShell({ cardUrl: "http://192.168.1.31/card.json", name: "研究 Agent" });
  await fixture.agents.activateForReadiness(collaborator.agentConnectionId);
  const life = await fixture.lives.create({
    mainAgentConnectionId: primary.agentConnectionId,
    name: "栖遥",
    personaSummary: "跨 Wake 连续",
    timezone: "Asia/Shanghai",
  });
  await fixture.database.store.bindCollaborator(life.lifeId, collaborator.agentConnectionId, fixture.clock.now().toISOString());
  const events = new EventService({
    clock: fixture.clock,
    ids: fixture.ids,
    publisher: fixture.sse,
    signal: new InMemoryEventSignal(),
    store: fixture.database.store,
  });
  await new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }).start(life.lifeId);
  const arbiter = new WakeArbiter({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store });
  const wake = await arbiter.claim(life.lifeId, "runtime-continuity");
  if (wake === null) throw new Error("missing Wake");
  return { arbiter, collaborator, events, life, wake };
}

describe("continuity Life actions", () => {
  it("atomically persists work, memory, alarm and delegation projections", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const runtime = await setup(fixture);
      const processor = new ActionProcessor({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store });
      const sourceEventId = runtime.wake.events[0]?.eventId ?? "";
      await processor.commit({
        actionSetId: "aset_continuity",
        actions: [
          { actionId: "affair_add", affairId: "affair_plan", kind: "affair.upsert", status: "WAITING", title: "完成长期计划", waitingReason: "AGENT_RESULT" },
          { actionId: "todo_add", affairId: "affair_plan", dueAt: "2026-07-16T09:00:00+08:00", kind: "todo.upsert", status: "OPEN", title: "整合研究结果" },
          { actionId: "memory_add", affairId: "affair_plan", confidence: 0.9, content: "用户希望先保存事实，再采取行动。", entities: [{ name: "AI Mana", relation: "依赖能力", type: "SYSTEM" }], kind: "memory.append", memoryKind: "SEMANTIC", sourceEventId },
          { actionId: "alarm_add", affairId: "affair_plan", allowQuietHours: true, at: "2026-07-16T01:00:00Z", creator: "HUMAN", kind: "alarm.schedule", reason: "复查计划", repeatEveryMinutes: 1440 },
          { actionId: "delegate_add", affairId: "affair_plan", agentConnectionId: runtime.collaborator.agentConnectionId, kind: "delegate", task: "调研三种方案", title: "方案调研" },
          { actionId: "express_add", kind: "express", text: "我会继续跟进。" },
          { actionId: "sleep_add", kind: "sleep", reason: "等待协作者" },
        ],
        consciousnessResidue: "计划在等待协作者，明天复查。",
        continueWake: false,
        kind: "actions",
        turnId: "turn_continuity",
        version: 1,
        wakeId: runtime.wake.wake.wakeId,
      }, { allowedActions: [...LIFE_ACTION_KINDS], turnId: "turn_continuity", wakeId: runtime.wake.wake.wakeId });

      expect(await fixture.database.store.listAffairs(runtime.life.lifeId)).toEqual([
        expect.objectContaining({ affairId: "affair_plan", status: "WAITING", waitingReason: "AGENT_RESULT" }),
      ]);
      expect(await fixture.database.store.listTodos(runtime.life.lifeId)).toEqual([
        expect.objectContaining({ affairId: "affair_plan", todoId: "todo_todo_add" }),
      ]);
      expect(await fixture.database.store.listMemories(runtime.life.lifeId)).toEqual([
        expect.objectContaining({ entities: [{ name: "AI Mana", relation: "依赖能力", type: "SYSTEM" }], kind: "SEMANTIC", memoryId: "memory_memory_add", revision: 1 }),
      ]);
      expect(await fixture.database.store.listAlarms(runtime.life.lifeId)).toEqual([
        expect.objectContaining({ alarmId: "alarm_alarm_add", status: "SCHEDULED" }),
      ]);
      expect(await fixture.database.store.listDelegations(runtime.life.lifeId)).toEqual([
        expect.objectContaining({ delegationId: "delegation_delegate_add", status: "PENDING" }),
      ]);
      expect(await fixture.database.store.listSchedules(runtime.life.lifeId)).toHaveLength(3);
      expect((await fixture.database.store.getRuntimeStats()).pendingOutbox).toBe(1);
      expect(await fixture.database.store.recallMemories({
        affairId: "affair_plan",
        lifeId: runtime.life.lifeId,
        limit: 16,
        now: fixture.clock.now().toISOString(),
        query: "保存事实 行动",
      })).toEqual([expect.objectContaining({ memoryId: "memory_memory_add" })]);
      expect(await fixture.database.store.recallMemories({
        lifeId: runtime.life.lifeId,
        limit: 16,
        now: fixture.clock.now().toISOString(),
        query: "ai mana",
      })).toEqual([expect.objectContaining({ memoryId: "memory_memory_add" })]);

      await fixture.database.store.createInvocation({
        agentConnectionId: runtime.collaborator.agentConnectionId,
        createdAt: fixture.clock.now().toISOString(),
        invocationId: "invocation_delegation_result",
        messageId: "message_delegation_result",
        outboxId: "outbox_delegation_result_a2a",
        request: { parts: [{ kind: "text", text: "调研" }] },
      });
      const invocation = await fixture.database.store.updateInvocation("invocation_delegation_result", {
        status: "COMPLETED",
        updatedAt: fixture.clock.now().toISOString(),
      });
      await fixture.database.store.createArtifact({
        affairId: "affair_plan",
        artifactId: "artifact_delegation_report",
        createdAt: fixture.clock.now().toISOString(),
        filename: "report.md",
        invocationId: invocation.invocationId,
        lifeId: runtime.life.lifeId,
        mimeType: "text/markdown",
        remoteArtifactId: "remote_report",
        sha256: "a".repeat(64),
        size: 1024,
      });
      const gateway = {
        startWithResult: vi.fn(() => Promise.resolve({
          invocation,
          output: { artifacts: [], parts: [{ data: "三种方案均已完成比较。", kind: "text" }] },
        })),
      } as unknown as A2aGatewayService;
      const notify = vi.fn();
      const delegationService = new DelegationService({ clock: fixture.clock, events: runtime.events, gateway, notify, store: fixture.database.store });
      expect(await delegationService.dispatch("delegation_delegate_add")).toMatchObject({ status: "COMPLETED" });
      expect(notify).toHaveBeenCalledWith(runtime.life.lifeId);
      const delegationEvents = await fixture.database.store.listLifeEvents(runtime.life.lifeId);
      expect(delegationEvents).toContainEqual(expect.objectContaining({
        payload: expect.objectContaining({ artifactId: "artifact_delegation_report", filename: "report.md" }) as unknown,
        type: "agent.artifact_created",
      }));
      expect(delegationEvents.some((event) => event.type === "agent.completed")).toBe(true);

      await runtime.events.ingest({ affairId: "affair_plan", lifeId: runtime.life.lifeId, payload: { text: "请按保存事实的原则修正记忆" }, source: "human", type: "human.message" });
      const secondWake = await runtime.arbiter.claim(runtime.life.lifeId, "runtime-continuity");
      if (secondWake === null) throw new Error("missing second Wake");
      const audit = new WakeAuditService({ clock: fixture.clock, ids: fixture.ids, store: fixture.database.store });
      const turn = await audit.beginTurn({ messageId: "message_context", wakeId: secondWake.wake.wakeId });
      const context = await new WakeContextAssembler({ clock: fixture.clock, store: fixture.database.store }).assemble({
        allowedActions: [...LIFE_ACTION_KINDS],
        events: secondWake.events,
        turn,
        wake: secondWake.wake,
      });
      expect(context).toMatchObject({
        affair: { affairId: "affair_plan" },
        collaborators: [expect.objectContaining({ agentId: runtime.collaborator.agentConnectionId })],
        memories: [expect.objectContaining({ memoryId: "memory_memory_add", sourceBoundary: "context-data" })],
        rhythm: { budget: { localDate: "2026-07-15" }, nextSchedules: expect.any(Array) as unknown },
        todos: [expect.objectContaining({ todoId: "todo_todo_add" })],
      });
      await processor.commit({
        actionSetId: "aset_revision",
        actions: [
          { actionId: "memory_revise", confidence: 0.95, content: "用户明确要求所有行动先持久化事实。", kind: "memory.revise", memoryId: "memory_memory_add" },
          { actionId: "alarm_cancel", alarmId: "alarm_alarm_add", kind: "alarm.cancel" },
          { actionId: "sleep_revision", kind: "sleep", reason: "完成修订" },
        ],
        consciousnessResidue: "记忆已修正。",
        continueWake: false,
        kind: "actions",
        turnId: "turn_revision",
        version: 1,
        wakeId: secondWake.wake.wakeId,
      }, { allowedActions: [...LIFE_ACTION_KINDS], turnId: "turn_revision", wakeId: secondWake.wake.wakeId });
      expect(await fixture.database.store.listMemories(runtime.life.lifeId)).toEqual([
        expect.objectContaining({ confidence: 0.95, revision: 2 }),
      ]);
      expect(await fixture.database.store.listAlarms(runtime.life.lifeId)).toEqual([
        expect.objectContaining({ status: "CANCELED" }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects cross-Life references without partial expression or event consumption", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const first = await setup(fixture);
      const processor = new ActionProcessor({ clock: fixture.clock, publisher: fixture.sse, store: fixture.database.store });
      await processor.commit({
        actionSetId: "aset_owner",
        actions: [{ actionId: "owner_affair", affairId: "affair_owned", kind: "affair.upsert", title: "私有事务" }],
        consciousnessResidue: "",
        continueWake: false,
        kind: "actions",
        turnId: "turn_owner",
        version: 1,
        wakeId: first.wake.wake.wakeId,
      }, { allowedActions: [...LIFE_ACTION_KINDS], turnId: "turn_owner", wakeId: first.wake.wake.wakeId });

      const second = await setup(fixture);
      await expect(processor.commit({
        actionSetId: "aset_cross",
        actions: [
          { actionId: "cross_expression", kind: "express", text: "不能出现" },
          { actionId: "cross_affair", affairId: "affair_owned", kind: "affair.upsert", title: "越权覆盖" },
        ],
        consciousnessResidue: "",
        continueWake: false,
        kind: "actions",
        turnId: "turn_cross",
        version: 1,
        wakeId: second.wake.wake.wakeId,
      }, { allowedActions: [...LIFE_ACTION_KINDS], turnId: "turn_cross", wakeId: second.wake.wake.wakeId })).rejects.toMatchObject({ code: "action_reference_invalid" });
      expect(await fixture.database.store.listExpressions(second.life.lifeId)).toEqual([]);
      expect((await fixture.database.store.getLifeEvent(second.wake.events[0]?.eventId ?? ""))?.status).toBe("CLAIMED");
    } finally {
      await fixture.close();
    }
  });
});
