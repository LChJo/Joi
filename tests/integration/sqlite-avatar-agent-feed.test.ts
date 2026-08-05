import { SqliteAvatarAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-avatar-agent-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("Avatar Agent and joi home projections", () => {
  it("creates cards only for new local instances and keeps resident cards non-deletable", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const avatar = await fixture.avatarRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "重构" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
      const resident = await fixture.instances.ensure({ avatarId: avatar.avatarId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
      const ephemeral = await fixture.instances.ensure({ avatarId: avatar.avatarId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const repository = new SqliteAvatarAgentRepository(fixture.database);

      const initial = await repository.listAgents({ avatarId: avatar.avatarId, limit: 50 });
      expect(initial.items.find((item) => item.agentId === ephemeral.instanceId))
        .toMatchObject({ canDelete: false, sessionPolicy: "EPHEMERAL" });
      expect(initial.items.find((item) => item.agentId === resident.instanceId))
        .toMatchObject({ canDelete: false, sessionPolicy: "RESIDENT" });

      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE partner_instances SET status = 'DISPOSED', disposed_at = ?, disposal_reason = 'ephemeral_completed' WHERE instance_id = ?",
      ).run(fixture.clock.now().toISOString(), ephemeral.instanceId));
      expect((await repository.listAgents({ avatarId: avatar.avatarId, limit: 50 })).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ agentId: ephemeral.instanceId, canDelete: true, status: "COMPLETED" }),
      ]));
      await expect(repository.dismiss({ agentId: resident.instanceId, avatarId: avatar.avatarId, dismissedAt: fixture.clock.now().toISOString() }))
        .rejects.toMatchObject({ code: "avatar_agent_resident_delete_forbidden" });
      await repository.dismiss({ agentId: ephemeral.instanceId, avatarId: avatar.avatarId, dismissedAt: fixture.clock.now().toISOString() });
      expect((await repository.listAgents({ avatarId: avatar.avatarId, limit: 50 })).items).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("filters agent cards by goal through their backing dispatch", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const avatar = await fixture.avatarRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "重构" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
      const first = await fixture.instances.ensure({ avatarId: avatar.avatarId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const second = await fixture.instances.ensure({ avatarId: avatar.avatarId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        const insertInput = connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
          VALUES (?, ?, ?, 'CONSUMED', ?, ?, ?)`);
        insertInput.run("goal-a", "key-a", "目标 A", avatar.avatarId, now, now);
        insertInput.run("goal-b", "key-b", "目标 B", avatar.avatarId, now, now);
        const insertTurn = connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`);
        insertTurn.run("turn-a", "goal-a", avatar.avatarId, "session-a", now, now);
        insertTurn.run("turn-b", "goal-b", avatar.avatarId, "session-b", now, now);
        const insertPlan = connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES (?, ?, '{}', '{}', ?)`);
        insertPlan.run("plan-a", "turn-a", now);
        insertPlan.run("plan-b", "turn-b", now);
        const insertWork = connection.prepare(`INSERT INTO work_items
          (work_id, avatar_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', 'COMPLETED', ?, ?)`);
        insertWork.run("work-a", avatar.avatarId, "goal-a", "目标 A", now, now);
        insertWork.run("work-b", avatar.avatarId, "goal-b", "目标 B", now, now);
        const insertAttempt = connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, instance_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, 'COMPLETED', ?, ?)`);
        insertAttempt.run("attempt-a", "plan-a", "work-a", first.partnerRevisionId, "action-a", first.instanceId, now, now);
        insertAttempt.run("attempt-b", "plan-b", "work-b", second.partnerRevisionId, "action-b", second.instanceId, now, now);
      });
      const repository = new SqliteAvatarAgentRepository(fixture.database);
      expect((await repository.listAgents({ avatarId: avatar.avatarId, limit: 50 })).items).toHaveLength(2);
      const filtered = await repository.listAgents({ avatarId: avatar.avatarId, goalId: "goal-a", limit: 50 });
      expect(filtered.items.map((item) => item.agentId)).toEqual([first.instanceId]);
    } finally {
      await fixture.close();
    }
  });

  it("groups one card per original target, excludes result inputs and exposes short-lived thinking", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const avatar = await fixture.avatarRegistry.create({ name: "前端 Avatar", personaSummary: "persona", projectLabel: "joi", scopeSummary: "首页" });
      fixture.database.transaction((connection) => {
        const now = "2026-08-03T12:00:00.000Z";
        const insertInput = connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`);
        insertInput.run("goal-running", "key-running", "重构首页", "CONSUMED", avatar.avatarId, now, now);
        insertInput.run("goal-done", "key-done", "整理 Agent 详情", "CONSUMED", avatar.avatarId, now, now);
        insertInput.run("joi_result_input:event-1", "result-key", "synthetic", "CONSUMED", avatar.avatarId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run("turn-running", "goal-running", avatar.avatarId, "session-a", "RUNNING", now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            "turn-done", "goal-done", avatar.avatarId, "session-b", "COMPLETED",
            "2026-08-03T11:00:00.000Z", "2026-08-03T11:00:00.000Z",
          );
        connection.prepare(`INSERT INTO work_items
          (work_id, avatar_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', ?, ?, ?)`).run("work-running", avatar.avatarId, "goal-running", "重构首页", "RUNNING", now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, avatar_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', ?, ?, ?)`).run("work-done", avatar.avatarId, "goal-done", "整理 Agent 详情", "COMPLETED", now, now);
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
