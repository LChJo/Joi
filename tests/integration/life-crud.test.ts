import { DomainError } from "../../src/main/domain/errors";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("Life and Agent application services", () => {
  it("supports persisted Life CRUD, versioned persona and cursor pagination", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.20/card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const first = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId,
        name: "栖遥",
        personaSummary: "保持连续性",
        timezone: "Asia/Shanghai",
      });
      fixture.clock.advance(1);
      const second = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId,
        name: "知还",
        personaSummary: "整理长期计划",
        timezone: "UTC",
      });

      const page = await fixture.lives.list({ limit: 1 });
      expect(page.items).toEqual([expect.objectContaining({ lifeId: second.lifeId })]);
      expect(page.next).toBeDefined();
      if (page.next === undefined) throw new Error("missing cursor");
      expect(await fixture.lives.list({ after: page.next, limit: 1 })).toMatchObject({
        items: [expect.objectContaining({ lifeId: first.lifeId })],
      });

      const updated = await fixture.lives.update(first.lifeId, {
        avatarUrl: "https://example.test/avatar.png",
        name: "栖遥·新",
        personaSummary: "保持长期连续性",
        principles: ["先保存事实"],
        role: "同行者",
        timezone: "Asia/Tokyo",
      });
      expect(updated).toMatchObject({
        avatarUrl: "https://example.test/avatar.png",
        name: "栖遥·新",
        personaSummary: "保持长期连续性",
        principles: ["先保存事实"],
        role: "同行者",
        timezone: "Asia/Tokyo",
      });
      expect(updated.currentPersonaVersionId).not.toBe(first.currentPersonaVersionId);
      expect(await fixture.lives.get(first.lifeId)).toEqual(updated);

      await fixture.lives.delete(first.lifeId);
      await expect(fixture.lives.get(first.lifeId)).rejects.toMatchObject({ code: "life_not_found" });
      await expect(fixture.lives.update(first.lifeId, { name: "missing" })).rejects.toBeInstanceOf(DomainError);
      await expect(fixture.lives.delete(first.lifeId)).rejects.toMatchObject({ code: "life_not_found" });
    } finally {
      await fixture.close();
    }
  });

  it("requires an active primary Agent and reports missing Agent activation", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const draft = await fixture.agents.createShell({ cardUrl: "http://192.168.1.21/card.json", name: "草稿 Agent" });
      await expect(fixture.lives.create({
        mainAgentConnectionId: draft.agentConnectionId,
        name: "未就绪",
        personaSummary: "不应创建",
        timezone: "UTC",
      })).rejects.toMatchObject({ code: "life_primary_agent_not_ready" });
      await expect(fixture.agents.activateForReadiness("agent_missing")).rejects.toMatchObject({ code: "agent_not_found" });
      expect(await fixture.agents.list()).toEqual([expect.objectContaining({ name: "草稿 Agent", status: "DRAFT" })]);
    } finally {
      await fixture.close();
    }
  });
});
