import { normalizeAgentConversationEntries } from "../../src/main/application/partners/agent-conversation-presentation.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("AC-60 live conversation paging", () => {
  it("opens the latest page and uses a stable history boundary while new entries arrive", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "测试", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "测试搭档", kind: "local-pi", skills: [], tools: [] });
      const instance = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const repository = new SqliteWorkbenchAgentRepository(fixture.database);
      const context = { agentId: instance.instanceId, runId: "live-test", startedAt: fixture.clock.now().toISOString() };
      const entries = (count: number) => normalizeAgentConversationEntries(context, Array.from({ length: count }, (_, i) => ({ kind: "MARKDOWN" as const, role: "AGENT" as const, text: `message-${String(i)}` })));
      await repository.replaceRun(instance.instanceId, context.runId, entries(125));
      const query = { agentId: instance.instanceId, workbenchId: workbench.workbenchId, limit: 50, latest: true };
      const tail = await repository.conversation(query);
      expect(tail.items.map(item => item.text)).toEqual(Array.from({ length: 50 }, (_, i) => `message-${String(i + 75)}`));
      expect(tail.nextCursor).toBeDefined();
      await repository.replaceRun(instance.instanceId, context.runId, entries(130));
      const older = await repository.conversation({ ...query, cursor: tail.nextCursor ?? "" });
      expect(older.items.map(item => item.text)).toEqual(Array.from({ length: 50 }, (_, i) => `message-${String(i + 25)}`));
      const oldest = await repository.conversation({ ...query, cursor: older.nextCursor ?? "" });
      expect(oldest.items).toHaveLength(25);
      expect(oldest.nextCursor).toBeUndefined();
      expect((await repository.conversation(query)).items.at(-1)?.text).toBe("message-129");
      expect((await repository.conversation({ ...query, latest: false })).items[0]?.text).toBe("message-0");
    } finally { await fixture.close(); }
  });

  it("writes only changed entries and preserves sequence and event times across snapshots", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "测试", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "测试搭档", kind: "local-pi", skills: [], tools: [] });
      const instance = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
      const repository = new SqliteWorkbenchAgentRepository(fixture.database);
      const entry = { entryId: "stable", runId: "run-1", order: 0, role: "AGENT" as const, kind: "MARKDOWN" as const, text: "first", createdAt: "2026-09-18T10:03:00.000Z" };
      await repository.replaceRun(instance.instanceId, "run-1", [entry]);
      await repository.append(instance.instanceId, [{ ...entry, entryId: "other", runId: "run-2" }]);
      const changes = () => fixture.database.transaction(c => (c.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
      const before = changes();
      await repository.replaceRun(instance.instanceId, "run-1", [entry]);
      expect(changes() - before).toBe(0);
      await repository.replaceRun(instance.instanceId, "run-1", [{ ...entry, text: "first expanded" }]);
      expect(changes() - before).toBe(1);
      const page = await repository.conversation({ agentId: instance.instanceId, workbenchId: workbench.workbenchId, limit: 50 });
      expect(page.items.map(item => item.entryId)).toEqual(["stable", "other"]);
      expect(page.items[0]).toMatchObject({ sequence: 0, createdAt: entry.createdAt, text: "first expanded" });
    } finally { await fixture.close(); }
  });
});
