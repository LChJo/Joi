import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("Workbench Agent and joi home projections", () => {
  it("creates cards only for new local instances and keeps resident cards non-deletable", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "重构" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
      const resident = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
      const ephemeral = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const repository = new SqliteWorkbenchAgentRepository(fixture.database);

      const initial = await repository.listAgents({ workbenchId: workbench.workbenchId, limit: 50 });
      expect(initial.items.find((item) => item.agentId === ephemeral.instanceId))
        .toMatchObject({ canDelete: false, sessionPolicy: "EPHEMERAL" });
      expect(initial.items.find((item) => item.agentId === resident.instanceId))
        .toMatchObject({ canDelete: false, sessionPolicy: "RESIDENT" });

      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE partner_instances SET status = 'DISPOSED', disposed_at = ?, disposal_reason = 'ephemeral_completed' WHERE instance_id = ?",
      ).run(fixture.clock.now().toISOString(), ephemeral.instanceId));
      expect((await repository.listAgents({ workbenchId: workbench.workbenchId, limit: 50 })).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: ephemeral.instanceId, canDelete: true, status: "COMPLETED" }),
      ]));
      await expect(repository.dismiss({ agentId: resident.instanceId, workbenchId: workbench.workbenchId, dismissedAt: fixture.clock.now().toISOString() }))
        .rejects.toMatchObject({ code: "workbench_agent_resident_delete_forbidden" });
      await repository.dismiss({ agentId: ephemeral.instanceId, workbenchId: workbench.workbenchId, dismissedAt: fixture.clock.now().toISOString() });
      expect((await repository.listAgents({ workbenchId: workbench.workbenchId, limit: 50 })).items).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("filters agent cards by goal through their backing dispatch", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "重构" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
      const first = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const second = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        const insertInput = connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES (?, ?, ?, 'CONSUMED', ?, ?, ?)`);
        insertInput.run("goal-a", "key-a", "目标 A", workbench.workbenchId, now, now);
        insertInput.run("goal-b", "key-b", "目标 B", workbench.workbenchId, now, now);
        const insertTurn = connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`);
        insertTurn.run("turn-a", "goal-a", workbench.workbenchId, "session-a", now, now);
        insertTurn.run("turn-b", "goal-b", workbench.workbenchId, "session-b", now, now);
        const insertPlan = connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES (?, ?, '{}', '{}', ?)`);
        insertPlan.run("plan-a", "turn-a", now);
        insertPlan.run("plan-b", "turn-b", now);
        const insertWork = connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', 'COMPLETED', ?, ?)`);
        insertWork.run("work-a", workbench.workbenchId, "goal-a", "目标 A", now, now);
        insertWork.run("work-b", workbench.workbenchId, "goal-b", "目标 B", now, now);
        const insertAttempt = connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, instance_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, 'COMPLETED', ?, ?)`);
        insertAttempt.run("attempt-a", "plan-a", "work-a", first.partnerRevisionId, "action-a", first.instanceId, now, now);
        insertAttempt.run("attempt-b", "plan-b", "work-b", second.partnerRevisionId, "action-b", second.instanceId, now, now);
      });
      const repository = new SqliteWorkbenchAgentRepository(fixture.database);
      expect((await repository.listAgents({ workbenchId: workbench.workbenchId, limit: 50 })).items).toHaveLength(2);
      const filtered = await repository.listAgents({ workbenchId: workbench.workbenchId, goalId: "goal-a", limit: 50 });
      expect(filtered.items.map((item) => item.agentId)).toEqual([first.instanceId]);
    } finally {
      await fixture.close();
    }
  });

  it("treats a current synthesized outcome as completed even when the orchestration turn is still open", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "重构" });
      const now = "2026-08-06T13:20:21.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES (?, ?, ?, 'ROUTED', ?, ?, ?)`).run("goal-stuck", "key-stuck", "分析 A 股收盘", workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'RUNNING', ?, ?)`).run("turn-stuck", "goal-stuck", workbench.workbenchId, "session-stuck", now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', 'COMPLETED', ?, ?)`).run("work-stuck", workbench.workbenchId, "goal-stuck", "分析 A 股收盘", now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at)
          VALUES (?, 1, 1, ?)`).run("goal-stuck", now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at)
          VALUES (?, 1, '已完成分析', ?, ?)`).run("goal-stuck", now, now);
      });
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-06T13:40:00.000Z"));
      expect(feed.goals).toEqual([expect.objectContaining({
        canDelete: true,
        goalId: "goal-stuck",
        status: "COMPLETED",
      })]);
    } finally {
      await fixture.close();
    }
  });

  it("groups one card per original target, excludes result inputs and exposes short-lived thinking", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "前端 Workbench", personaSummary: "persona", projectLabel: "joi", scopeSummary: "首页" });
      fixture.database.transaction((connection) => {
        const now = "2026-08-03T12:00:00.000Z";
        const insertInput = connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`);
        insertInput.run("goal-running", "key-running", "重构首页", "CONSUMED", workbench.workbenchId, now, now);
        insertInput.run("goal-done", "key-done", "整理 Agent 详情", "CONSUMED", workbench.workbenchId, now, now);
        insertInput.run("joi_result_input:event-1", "result-key", "synthetic", "CONSUMED", workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run("turn-running", "goal-running", workbench.workbenchId, "session-a", "RUNNING", now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            "turn-done", "goal-done", workbench.workbenchId, "session-b", "COMPLETED",
            "2026-08-03T11:00:00.000Z", "2026-08-03T11:00:00.000Z",
          );
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', ?, ?, ?)`).run("work-running", workbench.workbenchId, "goal-running", "重构首页", "RUNNING", now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', ?, ?, ?)`).run("work-done", workbench.workbenchId, "goal-done", "整理 Agent 详情", "COMPLETED", now, now);
      });
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-03T12:00:05.000Z"));
      expect(feed.goals).toHaveLength(2);
      expect(feed.goals.map((goal) => goal.goalId)).toEqual(["goal-running", "goal-done"]);
      expect(feed.goals).toEqual(expect.arrayContaining([
        expect.objectContaining({ canDelete: false, goalId: "goal-running", status: "RUNNING" }),
        expect.objectContaining({ canDelete: false, goalId: "goal-done", status: "FINALIZING" }),
      ]));
      expect(feed.thinking).toEqual([expect.objectContaining({ goalId: "goal-running", phase: "progressing" })]);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_turns SET status = 'COMPLETED', updated_at = '2026-08-03T12:00:10.000Z' WHERE turn_id = 'turn-running'",
      ).run());
      const settling = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-03T12:00:20.000Z"));
      expect(settling.thinking).toEqual([expect.objectContaining({ expiresAt: "2026-08-03T12:00:25.000Z", phase: "settled" })]);
      const expired = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-03T12:00:26.000Z"));
      expect(expired.thinking).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
