import { normalizeAgentConversationEntries } from "../../src/main/application/partners/agent-conversation-presentation.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";
import { probeSqlReads } from "../support/sql-read-probe.js";

describe("AC-60 live conversation paging", () => {
  it("CHAT-PERF-06 seeks the message page by sequence without aggregating agent cards", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "测试", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "测试搭档", kind: "local-pi", skills: [], tools: [] });
      const workbenchId = workbench.workbenchId;
      const instance = await fixture.instances.ensure({ workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
      const goalId = "goal-synthetic";
      const date = fixture.clock.now().toISOString();
      fixture.database.transaction(db => {
        db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
          VALUES (?,?,'Synthetic','CONSUMED',?,?,?)`).run(goalId, goalId, workbenchId, date, date);
        db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
          VALUES ('turn',?,?,'session','COMPLETED',?,?)`).run(goalId, workbenchId, date, date);
        db.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at)
          VALUES ('plan','turn','{}','{}',?)`).run(date);
        db.prepare(`WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < 5000)
          INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
          SELECT printf('work-%05d',n),?,?,'Synthetic','{}','READ','COMPLETED',?,? FROM series`).run(workbenchId, goalId, date, date);
        db.prepare(`INSERT INTO dispatch_attempts (dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,instance_id,status,created_at,updated_at)
          SELECT 'attempt-' || work_id,'plan',work_id,?,1,'action-' || work_id,?,'COMPLETED',?,? FROM work_items WHERE input_id=?`)
          .run(instance.partnerRevisionId, instance.instanceId, date, date, goalId);
        db.prepare(`INSERT INTO partner_runs (run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at)
          SELECT 'run-' || a.work_id,a.dispatch_attempt_id,a.action_id,?,a.work_id,a.partner_revision_id,'LOCAL_PI','external-' || a.work_id,'COMPLETED',?,?
          FROM dispatch_attempts a WHERE a.instance_id=?`).run(workbenchId, date, date, instance.instanceId);
      });
      const probe = probeSqlReads(fixture.database);
      const repository = new SqliteWorkbenchAgentRepository(probe.database);
      const agentId = instance.instanceId;
      await repository.append(agentId, normalizeAgentConversationEntries({ agentId, runId: "run-work-05000", startedAt: date },
        Array.from({ length: 51 }, () => ({ kind: "MARKDOWN", role: "AGENT", text: "Synthetic entry" }))));
      probe.statements.length = 0;
      const query = { agentId, workbenchId, goalId, limit: 50, latest: true };
      const messages = await repository.conversationMessages(query);
      expect(messages.items).toHaveLength(50);
      expect(messages.nextCursor).toBeDefined();
      expect(probe.statements).toHaveLength(2);
      const [membership, page] = probe.statements;
      if (membership === undefined || page === undefined) throw new Error("Missing transcript SQL.");
      expect(membership).not.toMatch(/execution_phase|incomplete_result|execution_updated_at/u);
      const plan = fixture.database.transaction(db => db.prepare(`EXPLAIN QUERY PLAN ${page}`).all(agentId, goalId, workbenchId, 51, 0));
      const planText = plan.map(row => row.detail).join("\n");
      expect(planText).toMatch(/SEARCH e USING INDEX \S+ \(agent_id=\?\)/u);
      expect(planText).toMatch(/SEARCH pr USING INDEX \S+ \(run_id=\?\)/u);
      expect(planText).not.toMatch(/LIST SUBQUERY|USE TEMP B-TREE/u);
      const full = await repository.conversation(query);
      expect(messages).toEqual({ items: full.items, nextCursor: full.nextCursor });
    } finally { await fixture.close(); }
  }, 15_000);

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
