import { EventService } from "../../src/main/application/events/event-service";
import { LifeRuntimeService } from "../../src/main/application/lives/life-runtime-service";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";
import { claimTestWake } from "../support/wake-fixture";

async function createActiveAgent(fixture: RuntimeFixture, suffix: string) {
  const agent = await fixture.agents.createShell({
    cardUrl: `http://192.168.1.${suffix}/card.json`,
    name: `Agent ${suffix}`,
  });
  return fixture.agents.activateForReadiness(agent.agentConnectionId);
}

function runtimeServices(fixture: RuntimeFixture) {
  const events = new EventService({
    clock: fixture.clock,
    ids: fixture.ids,
    publisher: fixture.sse,
    signal: new InMemoryEventSignal(),
    store: fixture.database.store,
  });
  return {
    runtime: new LifeRuntimeService({ clock: fixture.clock, events, store: fixture.database.store }),
  };
}

describe("complete Life management", () => {
  it("persists the initial goal, sends it in birth, and returns home-card overview data", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await createActiveAgent(fixture, "31");
      const life = await fixture.lives.create({
        initialGoal: "建立一套可持续的个人知识系统",
        mainAgentConnectionId: agent.agentConnectionId,
        name: "栖遥",
        personaSummary: "保持连续性",
        timezone: "Asia/Shanghai",
      });
      expect(life.initialGoal).toBe("建立一套可持续的个人知识系统");

      const { runtime } = runtimeServices(fixture);
      await runtime.start(life.lifeId);
      expect(await fixture.database.store.listLifeEvents(life.lifeId)).toEqual([
        expect.objectContaining({ payload: { initialGoal: "建立一套可持续的个人知识系统" }, type: "system.birth" }),
      ]);

      const page = await fixture.lives.list({ limit: 20 });
      expect(page.items).toEqual([
        expect.objectContaining({
          autonomousBudgetDailyLimit: 24,
          autonomousBudgetUsed: 0,
          nextWakeAt: "2026-07-15T13:00:00.000Z",
          pendingEventCount: 1,
          totalBudgetDailyLimit: 100,
          totalBudgetUsed: 0,
        }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("pauses a running Life by canceling its active Wake and re-queues claimed events", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await createActiveAgent(fixture, "32");
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId,
        name: "运行中",
        personaSummary: "测试暂停",
        timezone: "UTC",
      });
      const { runtime } = runtimeServices(fixture);
      await runtime.start(life.lifeId);
      const claimed = await claimTestWake({ clock: fixture.clock, ids: fixture.ids, leaseOwner: "runtime-test", lifeId: life.lifeId, store: fixture.database.store });
      expect(claimed?.wake.status).toBe("RUNNING");
      if (claimed === null) throw new Error("Expected birth event to create an active Wake.");

      expect(await runtime.pause(life.lifeId)).toMatchObject({ state: "PAUSED" });
      expect(await fixture.database.store.getWake(claimed.wake.wakeId)).toMatchObject({ status: "CANCELED" });
      const events = await fixture.database.store.listLifeEvents(life.lifeId);
      expect(events).toEqual([expect.objectContaining({ status: "PENDING", type: "system.birth" })]);
      expect(events[0]).not.toHaveProperty("claimedByWakeId");
    } finally {
      await fixture.close();
    }
  });

  it("can cancel only the current run while keeping the Life schedulable", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await createActiveAgent(fixture, "36");
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId, name: "单次停止", personaSummary: "保持后续调度", timezone: "UTC",
      });
      const { runtime } = runtimeServices(fixture);
      await runtime.start(life.lifeId);
      const claimed = await claimTestWake({ clock: fixture.clock, ids: fixture.ids, leaseOwner: "runtime-test", lifeId: life.lifeId, store: fixture.database.store });
      if (claimed === null) throw new Error("Expected an active Wake.");
      expect(await runtime.stopRun(life.lifeId)).toMatchObject({ state: "SLEEPING" });
      expect(await fixture.database.store.getWake(claimed.wake.wakeId)).toMatchObject({ status: "CANCELED" });
      expect(await fixture.database.store.listLifeEvents(life.lifeId)).toEqual([
        expect.objectContaining({ status: "PENDING", type: "system.birth" }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("changes the primary Agent only while paused and persists a bounded, token-free handoff", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const oldAgent = await createActiveAgent(fixture, "33");
      const newAgent = await createActiveAgent(fixture, "34");
      const life = await fixture.lives.create({
        initialGoal: "长期整理研究资料",
        mainAgentConnectionId: oldAgent.agentConnectionId,
        name: "交接测试",
        personaSummary: "只记录可核验事实",
        principles: ["不迁移凭据", "保持可追溯"],
        timezone: "UTC",
      });
      fixture.database.transaction((database) => {
        const now = fixture.clock.now().toISOString();
        database.prepare("INSERT INTO affairs (affair_id, life_id, title, status, summary, created_at, updated_at) VALUES (?, ?, ?, 'RUNNING', NULL, ?, ?)")
          .run("affair_long_handoff", life.lifeId, `超长事务${"界".repeat(5000)}`, now, now);
        database.prepare("INSERT INTO affairs (affair_id, life_id, title, status, summary, created_at, updated_at) VALUES (?, ?, ?, 'WAITING', ?, ?, ?)")
          .run("affair_summary_handoff", life.lifeId, "有摘要事务", "摘要", now, now);
        database.prepare("INSERT INTO todos (todo_id, life_id, affair_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'OPEN', ?, ?)")
          .run("todo_handoff", life.lifeId, "affair_summary_handoff", "继续处理", now, now);
        database.prepare("INSERT INTO memory_fragments (memory_id, life_id, kind, content, confidence, revision, status, created_at, updated_at) VALUES (?, ?, 'CARD', ?, 1, 1, 'ACTIVE', ?, ?)")
          .run("memory_handoff", life.lifeId, "关键记忆卡", now, now);
      });
      await expect(fixture.lives.changePrimaryAgent(life.lifeId, newAgent.agentConnectionId)).rejects.toMatchObject({
        code: "life_primary_agent_change_requires_pause",
      });

      const { runtime } = runtimeServices(fixture);
      await runtime.start(life.lifeId);
      await runtime.pause(life.lifeId);
      const changed = await fixture.lives.changePrimaryAgent(life.lifeId, newAgent.agentConnectionId);
      expect(changed.life.mainAgentConnectionId).toBe(newAgent.agentConnectionId);
      expect(Buffer.byteLength(changed.handoff.summary, "utf8")).toBeLessThanOrEqual(4096);
      expect(changed.handoff.summary).toContain("长期整理研究资料");
      expect(changed.handoff.summary).toContain("[handoff truncated]");
      expect(JSON.stringify(changed.handoff)).not.toMatch(/token|contextId/i);
      expect(await fixture.lives.getPrimaryAgentHandoffs(life.lifeId)).toEqual([changed.handoff]);
    } finally {
      await fixture.close();
    }
  });

  it("previews destructive impact and supports archive without deleting runtime history", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await createActiveAgent(fixture, "35");
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId,
        name: "可归档",
        personaSummary: "保留历史",
        timezone: "UTC",
      });
      expect(await fixture.lives.getDeletionImpact(life.lifeId)).toMatchObject({ schedules: 3 });

      const archived = await fixture.lives.archive(life.lifeId);
      expect(archived).toMatchObject({ archivedAt: "2026-07-15T12:00:00.000Z", state: "STOPPED" });
      expect(await fixture.lives.getDeletionImpact(life.lifeId)).toMatchObject({ schedules: 3 });
    } finally {
      await fixture.close();
    }
  });

  it("keeps missing and unchanged management operations explicit", async () => {
    const fixture = await createRuntimeFixture();
    try {
      await expect(fixture.lives.get("missing")).rejects.toMatchObject({ code: "life_not_found" });
      await expect(fixture.lives.update("missing", { name: "无" })).rejects.toMatchObject({ code: "life_not_found" });
      await expect(fixture.lives.archive("missing")).rejects.toMatchObject({ code: "life_not_found" });
      await expect(fixture.lives.delete("missing")).rejects.toMatchObject({ code: "life_not_found" });
      await expect(fixture.lives.getDeletionImpact("missing")).rejects.toMatchObject({ code: "life_not_found" });

      const agent = await createActiveAgent(fixture, "37");
      const life = await fixture.lives.create({ mainAgentConnectionId: agent.agentConnectionId, name: "不变", personaSummary: "不重复换绑", timezone: "UTC" });
      const { runtime } = runtimeServices(fixture);
      await runtime.start(life.lifeId);
      await runtime.pause(life.lifeId);
      await expect(fixture.lives.changePrimaryAgent(life.lifeId, agent.agentConnectionId)).rejects.toMatchObject({ code: "life_primary_agent_unchanged" });
    } finally {
      await fixture.close();
    }
  });
});
