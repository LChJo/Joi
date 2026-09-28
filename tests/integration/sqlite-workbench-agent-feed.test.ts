import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("Workbench Agent and joi home projections", () => {
  it("orders goals by opening time and keeps that order through progress and completion updates", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.database.transaction((connection) => {
        const insert = connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, created_at, updated_at)
          VALUES (?, ?, '排序测试', 'PENDING', ?, ?)`);
        insert.run('older', 'older', '2026-09-10T01:00:00.000Z', '2026-09-10T04:00:00.000Z');
        insert.run('newer-a', 'newer-a', '2026-09-10T02:00:00.000Z', '2026-09-10T02:00:00.000Z');
        insert.run('newer-b', 'newer-b', '2026-09-10T02:00:00.000Z', '2026-09-10T03:00:00.000Z');
      });
      const repository = new SqliteJoiHomeFeedRepository(fixture.database);
      const order = async () => (await repository.load(fixture.clock.now())).goals.map((goal) => goal.goalId);
      expect(await order()).toEqual(['newer-b', 'newer-a', 'older']);
      fixture.database.transaction((connection) => {
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', updated_at = '2026-09-10T05:00:00.000Z' WHERE input_id = 'older'`).run();
      });
      expect(await order()).toEqual(['newer-b', 'newer-a', 'older']);
      const inbox = new SqliteJoiInboxRepository(fixture.database, { now: () => new Date('2026-09-10T06:00:00.000Z') });
      expect(await inbox.retry('older', {})).not.toBeNull();
      expect(await order()).toEqual(['older', 'newer-b', 'newer-a']);
      fixture.database.transaction((connection) => {
        connection.prepare(`UPDATE joi_inbox_messages SET updated_at = '2026-09-10T07:00:00.000Z' WHERE input_id = 'newer-a'`).run();
      });
      expect(await order()).toEqual(['older', 'newer-b', 'newer-a']);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a current completed goal outcome authoritative when one terminal Work failed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "分析", personaSummary: "persona", projectLabel: "joi", scopeSummary: "综合" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-partial', 'key-partial', '综合多个搭档的结论', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-partial', 'goal-partial', ?, 'session-partial', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        const insertWork = connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, 'goal-partial', ?, '{}', 'READ', ?, ?, ?)`);
        insertWork.run("work-success", workbench.workbenchId, "成功分析", "COMPLETED", now, now);
        insertWork.run("work-failed", workbench.workbenchId, "异常分析", "FAILED", now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES ('goal-partial', 2, 2, ?)`).run(now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES ('goal-partial', 2, 'COMPLETED', '现有证据已经足够形成结论。', ?, ?)`).run(now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals[0]).toMatchObject({
        completionSummary: "现有证据已经足够形成结论。",
        status: "COMPLETED",
        work: { active: 0, completed: 1, failed: 1, failedResolved: 0, total: 2 },
      });
      expect((await fixture.workbenchManagement.get(workbench.workbenchId)).recentOutcomes[0])
        .toMatchObject({ goalId: "goal-partial", status: "COMPLETED" });
    } finally {
      await fixture.close();
    }
  });

  it("counts a failure as resolved only when its recovery chain finished a replacement", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "分析", personaSummary: "persona", projectLabel: "joi", scopeSummary: "综合" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-chain', 'key-chain', '把失败的活重派一次', 'PENDING', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-chain', 'goal-chain', ?, 'session-chain', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        const insertWork = connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, 'goal-chain', ?, '{}', 'READ', ?, ?, ?)`);
        insertWork.run("work-open", workbench.workbenchId, "没人接手的失败", "FAILED", now, now);
        insertWork.run("work-fixed", workbench.workbenchId, "被直接替代的失败", "FAILED", now, now);
        insertWork.run("work-relay", workbench.workbenchId, "替代者自己也失败了", "FAILED", now, now);
        insertWork.run("work-replacement", workbench.workbenchId, "最后完成了", "COMPLETED", now, now);
        const insertRecovery = connection.prepare(`INSERT INTO work_recovery_attempts
          (recovery_id, source_work_id, replacement_work_id, attempt_no, strategy, status, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'SUPPLEMENT', 'FAILED', ?, ?)`);
        insertRecovery.run("recovery-fixed", "work-fixed", "work-replacement", now, now);
        // A chain has to be followed past a replacement that failed on, or this failure reads as open.
        insertRecovery.run("recovery-relay", "work-relay", "work-fixed", now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals[0]?.work).toMatchObject({ failed: 3, failedResolved: 2 });
    } finally {
      await fixture.close();
    }
  });

  it("projects a blocked current outcome as failed even when some Work completed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "分析", personaSummary: "persona", projectLabel: "joi", scopeSummary: "综合" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-blocked', 'key-blocked', '必须覆盖关键证据', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-blocked', 'goal-blocked', ?, 'session-blocked', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-partial', ?, 'goal-blocked', '已有分析', '{}', 'READ', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES ('goal-blocked', 1, 1, ?)`).run(now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES ('goal-blocked', 1, 'BLOCKED', '关键证据仍然缺失。', ?, ?)`).run(now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals[0]).toMatchObject({ completionSummary: "关键证据仍然缺失。", status: "FAILED" });
      expect((await fixture.workbenchManagement.get(workbench.workbenchId)).recentOutcomes[0])
        .toMatchObject({ goalId: "goal-blocked", status: "FAILED" });
    } finally {
      await fixture.close();
    }
  });

  it("never presents an accepted-with-gaps outcome as full completion", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "分析", personaSummary: "persona", projectLabel: "joi", scopeSummary: "综合" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-accepted', 'key-accepted', '接受有缺口的结论', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-accepted', 'goal-accepted', ?, 'session-accepted', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-accepted', ?, 'goal-accepted', '已有分析', '{}', 'READ', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES ('goal-accepted', 1, 1, ?)`).run(now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES ('goal-accepted', 1, 'ACCEPTED_WITH_GAPS', '横评已形成，但近七天来源不足。', ?, ?)`).run(now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals[0]).toMatchObject({ completionSummary: "横评已形成，但近七天来源不足。", status: "COMPLETED_WITH_GAPS" });
      expect((await fixture.workbenchManagement.get(workbench.workbenchId)).recentOutcomes[0])
        .toMatchObject({ goalId: "goal-accepted", status: "COMPLETED_WITH_GAPS" });
    } finally {
      await fixture.close();
    }
  });

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
      fixture.database.transaction((connection) => {
        for (const suffix of ["a", "b"]) connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'LOCAL_PI', ?, 'COMPLETED', ?, ?)`)
          .run(`run-${suffix}`, `attempt-${suffix}`, `action-${suffix}`, workbench.workbenchId, `work-${suffix}`, first.partnerRevisionId, `external-${suffix}`, now, now);
        // One resident-style stream containing entries from more than one goal.
        connection.prepare("UPDATE dispatch_attempts SET instance_id = ? WHERE dispatch_attempt_id = 'attempt-b'").run(first.instanceId);
      });
      await repository.append(first.instanceId, [
        { entryId: "entry-a", runId: "run-a", createdAt: now, order: 0, kind: "MARKDOWN", role: "AGENT", text: "Goal A evidence" },
        { entryId: "entry-b", runId: "run-b", createdAt: now, order: 0, kind: "MARKDOWN", role: "AGENT", text: "Goal B evidence" },
      ]);
      expect((await repository.conversation({ agentId: first.instanceId, workbenchId: workbench.workbenchId, goalId: "goal-a", limit: 20 })).items.map((item) => item.text))
        .toEqual(["Goal A evidence"]);
      await expect(repository.conversation({ agentId: second.instanceId, workbenchId: workbench.workbenchId, goalId: "goal-a", limit: 20 }))
        .rejects.toMatchObject({ code: "workbench_agent_not_found" });
    } finally {
      await fixture.close();
    }
  });

  it("projects a resident Agent from its goal-scoped run while the global card keeps instance availability", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "等待回答" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
      const resident = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-waiting-agent', 'key-waiting-agent', '继续实现', 'CLARIFICATION_REQUIRED', ?, ?, ?)`)
          .run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-waiting-agent', 'goal-waiting-agent', ?, 'session-waiting-agent', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan-waiting-agent', 'turn-waiting-agent', '{}', '[]', ?)`).run(now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-waiting-agent', ?, 'goal-waiting-agent', '继续实现', '{}', 'READ', 'WAITING', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, instance_id, status, created_at, updated_at)
          VALUES ('attempt-waiting-agent', 'plan-waiting-agent', 'work-waiting-agent', ?, 1, 'action-waiting-agent', ?, 'WAITING_INPUT', ?, ?)`)
          .run(partner.partnerRevisionId, resident.instanceId, now, now);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES ('run-waiting-agent', 'attempt-waiting-agent', 'action-waiting-agent', ?, 'work-waiting-agent', ?, 'LOCAL_PI', ?, 'WAITING_INPUT', ?, ?)`)
          .run(workbench.workbenchId, partner.partnerRevisionId, `local:${resident.instanceId}`, now, now);
      });

      const repository = new SqliteWorkbenchAgentRepository(fixture.database);
      const agents = await repository.listAgents({ workbenchId: workbench.workbenchId, goalId: "goal-waiting-agent", limit: 50 });
      expect(agents.items).toEqual([expect.objectContaining({ agentId: resident.instanceId, status: "WAITING" })]);

      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE work_items SET status = 'COMPLETED', updated_at = ? WHERE work_id = 'work-waiting-agent'").run(now);
        connection.prepare("UPDATE dispatch_attempts SET status = 'COMPLETED', updated_at = ? WHERE dispatch_attempt_id = 'attempt-waiting-agent'").run(now);
        connection.prepare("UPDATE partner_runs SET status = 'COMPLETED', updated_at = ? WHERE run_id = 'run-waiting-agent'").run(now);
      });
      expect((await repository.listAgents({ workbenchId: workbench.workbenchId, limit: 50 })).items)
        .toEqual([expect.objectContaining({ agentId: resident.instanceId, status: "IDLE" })]);
      expect((await repository.listAgents({ workbenchId: workbench.workbenchId, goalId: "goal-waiting-agent", limit: 50 })).items)
        .toEqual([expect.objectContaining({ agentId: resident.instanceId, status: "COMPLETED" })]);
    } finally {
      await fixture.close();
    }
  });

  it("hides path redaction markers from home-feed card titles and previews", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "重构" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES (?, ?, ?, 'CONSUMED', ?, ?, ?)`).run("goal-path", "key-path", "C:\\work\\prd.md 审查一下这个prd方案", workbench.workbenchId, now, now);
      });
      const feed = await fixture.joiHomeFeed.load();
      const goal = feed.goals.find((item) => item.goalId === "goal-path");
      expect(goal?.title).toBe("C:\\work\\prd.md 审查一下这个prd方案");
      expect(JSON.stringify(feed)).not.toContain("redacted-path");
    } finally {
      await fixture.close();
    }
  });

  it("shows a pending unassigned input as an arranging goal until clarification is required", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
        VALUES ('goal-pending-unassigned', 'key-pending-unassigned', '第一次提问', 'PENDING', NULL, ?, ?)`)
        .run(now, now));

      const repository = new SqliteJoiHomeFeedRepository(fixture.database);
      expect(await repository.load(fixture.clock.now())).toEqual(expect.objectContaining({
        goals: [expect.objectContaining({
          goalId: "goal-pending-unassigned",
          status: "ARRANGING",
          title: "第一次提问",
          workbench: { name: "等待归属", workbenchId: "" },
        })],
        unassignedActions: [],
      }));

      fixture.database.transaction((connection) => connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = 'workbench_selection_invalid', updated_at = ?
        WHERE input_id = 'goal-pending-unassigned'`).run(fixture.clock.now().toISOString()));
      const clarified = await repository.load(fixture.clock.now());
      expect(clarified.goals).toEqual([]);
      expect(clarified.unassignedActions).toEqual([expect.objectContaining({ inputId: "goal-pending-unassigned" })]);
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
      expect(feed.thinking).toEqual([]);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_turns SET status = 'COMPLETED', updated_at = '2026-08-06T13:39:59.000Z' WHERE turn_id = 'turn-stuck'",
      ).run());
      const settled = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-06T13:40:05.000Z"));
      expect(settled.thinking).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps an active turn visible when its goal card is hidden", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "孤立工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "孤立" });
      const now = "2026-08-06T13:20:21.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-hidden', 'key-hidden', '隐藏目标', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET dismissed_at = ? WHERE input_id = 'goal-hidden'").run(now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-hidden', 'goal-hidden', ?, 'session-hidden', 'RUNNING', ?, ?)`).run(workbench.workbenchId, now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-06T13:20:25.000Z"));
      expect(feed.thinking).toEqual([expect.objectContaining({ goalId: "goal-hidden", phase: "progressing", stage: "PLANNING" })]);
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
      expect(feed.thinking).toEqual([expect.objectContaining({
        agentCount: 0,
        goalId: "goal-running",
        phase: "progressing",
        stage: "RUNNING",
        work: { active: 1, completed: 0, failed: 0, failedResolved: 0, total: 1 },
      })]);
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

  it("projects only one continuous thinking row when the same goal has multiple active turns", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "去重 Workbench", personaSummary: "persona", projectLabel: "joi", scopeSummary: "首页" });
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-repeated-thinking', 'key-repeated-thinking', '验证重复进度', 'CONSUMED', ?, ?, ?)`
        ).run(workbench.workbenchId, "2026-08-03T12:00:00.000Z", "2026-08-03T12:00:04.000Z");
        const insertTurn = connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, 'goal-repeated-thinking', ?, ?, 'RUNNING', ?, ?)`);
        insertTurn.run("turn-repeated-1", workbench.workbenchId, "session-repeated-1", "2026-08-03T12:00:00.000Z", "2026-08-03T12:00:00.000Z");
        insertTurn.run("turn-repeated-2", workbench.workbenchId, "session-repeated-2", "2026-08-03T12:00:02.000Z", "2026-08-03T12:00:02.000Z");
        insertTurn.run("turn-repeated-3", workbench.workbenchId, "session-repeated-3", "2026-08-03T12:00:04.000Z", "2026-08-03T12:00:04.000Z");
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-repeated-thinking', ?, 'goal-repeated-thinking', '验证重复进度', '{}', 'READ', 'RUNNING', ?, ?)`
        ).run(workbench.workbenchId, "2026-08-03T12:00:00.000Z", "2026-08-03T12:00:04.000Z");
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-03T12:00:10.000Z"));
      expect(feed.thinking).toEqual([expect.objectContaining({
        goalId: "goal-repeated-thinking",
        phase: "progressing",
        stage: "RUNNING",
        startedAt: "2026-08-03T12:00:00.000Z",
        turnId: "turn-repeated-1",
      })]);
    } finally {
      await fixture.close();
    }
  });

  it("projects safe thinking stages and work counts from the goal facts", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "阶段工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "阶段" });
      const now = "2026-08-03T12:00:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-stage', 'key-stage', '阶段目标', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-stage', 'goal-stage', ?, 'session-stage', 'RUNNING', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-stage', ?, 'goal-stage', '阶段工作', '{}', 'READ', 'PLANNED', ?, ?)`).run(workbench.workbenchId, now, now);
      });
      const repository = new SqliteJoiHomeFeedRepository(fixture.database);
      expect((await repository.load(new Date("2026-08-03T12:00:05.000Z"))).thinking).toEqual([expect.objectContaining({
        stage: "DISPATCHING",
        work: { active: 1, completed: 0, failed: 0, failedResolved: 0, total: 1 },
      })]);

      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET status = 'WAITING', updated_at = ? WHERE work_id = 'work-stage'",
      ).run("2026-08-03T12:00:06.000Z"));
      expect((await repository.load(new Date("2026-08-03T12:00:07.000Z"))).thinking).toEqual([expect.objectContaining({ stage: "RUNNING" })]);

      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET status = 'COMPLETED', updated_at = ? WHERE work_id = 'work-stage'",
      ).run("2026-08-03T12:00:08.000Z"));
      expect((await repository.load(new Date("2026-08-03T12:00:09.000Z"))).thinking).toEqual([expect.objectContaining({
        stage: "FINALIZING",
        work: { active: 0, completed: 1, failed: 0, failedResolved: 0, total: 1 },
      })]);
    } finally {
      await fixture.close();
    }
  });

  it("projects derived pending inputs as queued instead of progressing", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "队列工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "队列" });
      const now = "2026-08-03T12:00:00.000Z";
      fixture.database.transaction((connection) => {
        const insertInput = connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        insertInput.run("goal-queued", "key-goal-queued", "目标", "CONSUMED", workbench.workbenchId, null, now, now);
        insertInput.run("derived-queued", "key-derived-queued", "派生工作", "PENDING", workbench.workbenchId, "goal-queued", now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-03T12:00:05.000Z"));
      expect(feed.thinking).toEqual([expect.objectContaining({
        agentCount: 0,
        goalId: "goal-queued",
        phase: "queued",
        stage: "ROUTING",
        turnId: "pending:derived-queued",
        work: { active: 0, completed: 0, failed: 0, failedResolved: 0, total: 0 },
      })]);
    } finally {
      await fixture.close();
    }
  });

  it("projects a retried original goal as arranging and queued immediately", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "重试工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "原始目标重试" });
      const now = "2026-08-21T12:00:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-retried', 'key-goal-retried', '继续处理', 'PENDING', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-retried-old', 'goal-retried', ?, 'joi_session:retried', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-retried-plan', ?, 'goal-retried', '上一轮计划', '{}', 'READ', 'PLANNED', ?, ?)`).run(workbench.workbenchId, now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-21T12:00:01.000Z"));
      expect(feed.goals).toEqual([expect.objectContaining({ goalId: "goal-retried", status: "ARRANGING" })]);
      expect(feed.thinking).toEqual([expect.objectContaining({
        goalId: "goal-retried",
        phase: "queued",
        stage: "ROUTING",
        turnId: "pending:goal-retried",
      })]);
    } finally {
      await fixture.close();
    }
  });

  it("does not expose a stale completion summary while result synthesis is behind", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "综合工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "综合" });
      const now = "2026-08-03T12:00:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES (?, ?, ?, 'CONSUMED', ?, ?, ?)`).run("goal-stale-summary", "key-stale-summary", "综合目标", workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`).run("turn-stale-summary", "goal-stale-summary", workbench.workbenchId, "session-stale-summary", now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', 'COMPLETED', ?, ?)`).run("work-stale-summary", workbench.workbenchId, "goal-stale-summary", "工作", now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets (original_input_id, revision, synthesized_revision, updated_at)
          VALUES (?, 2, 1, ?)`).run("goal-stale-summary", now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at)
          VALUES (?, 1, ?, ?, ?)`).run("goal-stale-summary", "上一轮摘要", now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-03T12:00:05.000Z"));
      expect(feed.goals).toEqual([expect.objectContaining({ goalId: "goal-stale-summary", status: "FINALIZING" })]);
      expect(feed.goals[0]?.completionSummary).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("projects only current synthesized goal outcomes into Workbench recent outcomes", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "结果工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "结果" });
      const now = "2026-08-06T13:20:21.000Z";
      fixture.database.transaction((connection) => {
        const insertGoal = connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES (?, ?, ?, 'CONSUMED', ?, ?, ?)`);
        insertGoal.run("goal-current", "key-current", "当前目标", workbench.workbenchId, now, now);
        insertGoal.run("goal-continue", "key-continue", "仍需补齐的目标", workbench.workbenchId, now, now);
        insertGoal.run("goal-old", "key-old", "旧目标", workbench.workbenchId, now, now);
        insertGoal.run("goal-pending", "key-pending", "未合成目标", workbench.workbenchId, now, now);
        const insertSet = connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, ?, ?, ?)`);
        insertSet.run("goal-current", 2, 2, now);
        insertSet.run("goal-continue", 1, 1, now);
        insertSet.run("goal-old", 2, 1, now);
        insertSet.run("goal-pending", 1, 0, now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at, disposition)
          VALUES ('goal-current', 2, '这是当前目标的最终综合结论。', ?, ?, 'COMPLETED'),
                 ('goal-continue', 1, '这是等待下一层证据的中间结论。', ?, ?, 'CONTINUE'),
                 ('goal-old', 1, '这是旧 revision 的结论。', ?, ?, 'COMPLETED')`).run(now, now, now, now, now, now);
      });

      const detail = await fixture.workbenchManagement.get(workbench.workbenchId) as unknown as { recentOutcomes: unknown };
      expect(detail.recentOutcomes).toEqual([{
        completedAt: now,
        goalId: "goal-current",
        resultRevision: 2,
        status: "COMPLETED",
        summary: "这是当前目标的最终综合结论。",
        title: "当前目标",
      }]);
    } finally {
      await fixture.close();
    }
  });
});
