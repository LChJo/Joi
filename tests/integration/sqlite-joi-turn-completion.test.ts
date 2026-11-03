import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("persisted joi Turn completions", () => {
  it("atomically persists a safe direct answer and projects it after repository reconstruction", async () => {
    const fixture = await createRuntimeFixture();
    try {
      expect(fixture.database.inspect().schemaVersion).toBeGreaterThanOrEqual(42);
      const workbench = await fixture.workbenchRegistry.create({ name: "问答", personaSummary: "private", projectLabel: "joi", scopeSummary: "直接回答" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('input-direct', 'key-direct', '你是谁', 'ROUTED', ?, ?, ?)`)
          .run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-direct', 'input-direct', ?, 'session-direct', 'RUNNING', ?, ?)`)
          .run(workbench.workbenchId, now, now);
      });
      const inbox = new SqliteJoiInboxRepository(fixture.database);
      await (inbox.completeInput as unknown as (
        inputId: string,
        turnId: string,
        completion: { completionSummary: string; outcome: "DIRECT_ANSWER" },
      ) => Promise<unknown>)("input-direct", "turn-direct", {
        completionSummary: "## 身份\n\n我是 Joi。 token=abcdefghijklmnop C:\\private\\nested\\deep\\answer.md",
        outcome: "DIRECT_ANSWER",
      });

      const persisted = fixture.database.transaction((connection) => connection.prepare(`SELECT input_id, turn_id,
        outcome_kind, completion_summary FROM joi_turn_completions WHERE input_id = 'input-direct'`).get());
      expect(persisted).toEqual({
        completion_summary: "## 身份\n\n我是 Joi。 token=[redacted] C:\\…\\nested\\deep\\answer.md",
        input_id: "input-direct",
        outcome_kind: "DIRECT_ANSWER",
        turn_id: "turn-direct",
      });
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals).toEqual([expect.objectContaining({
        completionSummary: "## 身份\n\n我是 Joi。 token=[redacted] C:\\…\\nested\\deep\\answer.md",
        goalId: "input-direct",
        status: "COMPLETED",
        work: { active: 0, completed: 0, failed: 0, failedResolved: 0, total: 0, executing: 0, resourceWaiting: 0 },
      })]);

      await inbox.retry("input-direct", {});
      const retrying = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(retrying.goals[0]).toMatchObject({ goalId: "input-direct", status: "ARRANGING" });
      expect(retrying.goals[0]?.completionSummary).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("erases the legacy path placeholder a pre-abbreviation row persisted", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "问答", personaSummary: "private", projectLabel: "joi", scopeSummary: "直接回答" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('input-legacy', 'key-legacy', '旧目标', 'CONSUMED', ?, ?, ?)`)
          .run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-legacy', 'input-legacy', ?, 'session-legacy', 'COMPLETED', ?, ?)`)
          .run(workbench.workbenchId, now, now);
        // Written before paths were abbreviated, so the summary holds the placeholder rather
        // than a path. Abbreviation can no longer recover the original, but the card must not
        // keep showing the marker either.
        connection.prepare(`INSERT INTO joi_turn_completions
          (input_id, turn_id, outcome_kind, completion_summary, completed_at, updated_at)
          VALUES ('input-legacy', 'turn-legacy', 'DIRECT_ANSWER', ?, ?, ?)`)
          .run("## 结论\n\n[redacted-path] 已隐藏。", now, now);
      });
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals.find((item) => item.goalId === "input-legacy")?.completionSummary).toBe("## 结论\n\n已隐藏。");
    } finally {
      await fixture.close();
    }
  });

  it("keeps goal card order on projected activity so background inbox touches cannot reorder cards", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "排序", personaSummary: "private", projectLabel: "joi", scopeSummary: "卡片排序" });
      fixture.database.transaction((connection) => {
        // An older goal completed early; background maintenance touched its inbox row later.
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('input-old-goal', 'key-old-goal', '旧目标', 'CONSUMED', ?, '2026-08-01T10:00:00.000Z', '2026-08-06T10:00:00.000Z')`)
          .run(workbench.workbenchId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-old-goal', 'input-old-goal', ?, 'session-old-goal', 'COMPLETED', '2026-08-01T10:00:00.000Z', '2026-08-01T10:05:00.000Z')`)
          .run(workbench.workbenchId);
        connection.prepare(`INSERT INTO joi_turn_completions
          (input_id, turn_id, outcome_kind, completion_summary, completed_at, updated_at)
          VALUES ('input-old-goal', 'turn-old-goal', 'DIRECT_ANSWER', '完成', '2026-08-01T10:05:00.000Z', '2026-08-01T10:05:00.000Z')`).run();
        // A newer goal failed after the old goal completed: its card must stay first even
        // though the old inbox row carries the newest raw updated_at.
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at, failed_at, failure_reason_code, failure_count)
          VALUES ('input-new-goal', 'key-new-goal', 'hi', 'CONSUMED', ?, '2026-08-02T10:00:00.000Z', '2026-08-02T10:01:00.000Z', '2026-08-02T10:01:00.000Z', 'custom_model_tool_capability_unverified', 8)`)
          .run(workbench.workbenchId);
      });
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals.map((goal) => goal.goalId)).toEqual(["input-new-goal", "input-old-goal"]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the current Goal outcome authoritative over an older direct completion", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "综合", personaSummary: "private", projectLabel: "joi", scopeSummary: "结果综合" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-priority', 'key-priority', '完成目标', 'CONSUMED', ?, ?, ?)`)
          .run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-priority', 'goal-priority', ?, 'session-priority', 'COMPLETED', ?, ?)`)
          .run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turn_completions
          (input_id, turn_id, outcome_kind, completion_summary, completed_at, updated_at)
          VALUES ('goal-priority', 'turn-priority', 'DIRECT_ANSWER', '旧直接回答', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at)
          VALUES ('goal-priority', 1, 1, ?)`).run(now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at)
          VALUES ('goal-priority', 1, '当前综合结果', ?, ?)`).run(now, now);
      });

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals[0]).toMatchObject({ completionSummary: "当前综合结果", goalId: "goal-priority" });
    } finally {
      await fixture.close();
    }
  });

  it("atomically closes a completed harness review when its mechanical gates pass", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "评审收官", personaSummary: "private", projectLabel: "joi", scopeSummary: "评审收官" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
          VALUES ('goal-review-close', 'key-goal-review-close', '完成目标', 'CONSUMED', ?, NULL, ?, ?),
                 ('joi_harness_review:goal:goal-review-close:r1', 'key-review-close', 'review', 'ROUTED', ?, 'goal-review-close', ?, ?)`)
          .run(workbench.workbenchId, now, now, workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-review-close', 'joi_harness_review:goal:goal-review-close:r1', ?, 'session-review-close', 'RUNNING', ?, ?)`)
          .run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, status, revision, reviewed_revision, created_at, updated_at)
          VALUES ('goal-review-close', ?, 'ACTIVE', 1, 1, ?, ?)`)
          .run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at)
          VALUES ('goal-review-close', 1, 1, ?)`)
          .run(now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at)
          VALUES ('goal-review-close', 1, '任务已完成', ?, ?)`)
          .run(now, now);
      });

      await new SqliteJoiInboxRepository(fixture.database).completeInput(
        "joi_harness_review:goal:goal-review-close:r1",
        "turn-review-close",
      );

      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT status FROM joi_harness_maps WHERE goal_input_id = 'goal-review-close'`).get())).toEqual({ status: "CLEARED" });
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now())).goals[0]).toMatchObject({
        goalId: "goal-review-close", status: "COMPLETED",
      });
    } finally {
      await fixture.close();
    }
  });

  it("counts unique files without directory metadata and projects their workspace directories", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "交付", personaSummary: "private", projectLabel: "joi", scopeSummary: "产物目录" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "交付搭档", kind: "local-pi", skills: [], tools: [] });
      const instance = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES ('goal-dirs', 'key-dirs', '实现插件', 'CONSUMED', ?, ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-dirs', 'goal-dirs', ?, 'session-dirs', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan-dirs', 'turn-dirs', '{}', '{}', ?)`).run(now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-dirs', ?, 'goal-dirs', '实现插件', '{}', 'WRITE', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, instance_id, status, created_at, updated_at)
          VALUES ('attempt-dirs', 'plan-dirs', 'work-dirs', ?, 1, 'action-dirs', ?, 'COMPLETED', ?, ?)`)
          .run(partner.partnerRevisionId, instance.instanceId, now, now);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES ('run-dirs', 'attempt-dirs', 'action-dirs', ?, 'work-dirs', ?, 'LOCAL_PI', 'local:dirs', 'COMPLETED', ?, ?)`)
          .run(workbench.workbenchId, partner.partnerRevisionId, now, now);
        connection.prepare(`INSERT INTO work_result_bodies (body_ref, body, created_at)
          VALUES ('body-dirs', '完成', ?)`).run(now);
        connection.prepare(`INSERT INTO work_results
          (result_id, run_id, action_id, workbench_id, work_id, partner_revision_id, instance_id, status, summary, body_ref,
           artifacts_json, is_late, is_authoritative, created_at)
          VALUES ('result-dirs', 'run-dirs', 'action-dirs', ?, 'work-dirs', ?, ?, 'COMPLETED', '完成', 'body-dirs', ?, 0, 1, ?)`)
          .run(workbench.workbenchId, partner.partnerRevisionId, instance.instanceId, JSON.stringify([
            { artifactRef: "workspace:out/report.csv", mimeType: "text/csv", name: "report.csv", size: 8 },
            { artifactRef: "workspace:out/build.zip", mimeType: "application/octet-stream", name: "build.zip", size: 64 },
            { artifactRef: "workspace:out/build.zip", mimeType: "application/octet-stream", name: "build.zip", size: 64 },
            { artifactRef: "workspace:out", mimeType: "inode/directory", name: "out", size: 0 },
          ]), now);
        connection.prepare(`INSERT INTO work_result_verifications (result_id, status, created_at)
          VALUES ('result-dirs', 'NOT_REQUIRED', ?)`).run(now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES ('goal-dirs', 1, 1, ?)`).run(now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
          VALUES ('goal-dirs', 1, 'COMPLETED', '已完成。', ?, ?)`).run(now, now);
      });
      const goal = (await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now())).goals.find((candidate) => candidate.goalId === "goal-dirs");
      expect(goal?.artifacts).toEqual([
        { artifactId: "work_result_artifact:result-dirs:2", directory: "out", kind: "FILE", mimeType: "application/octet-stream", name: "build.zip", size: 64 },
        { artifactId: "work_result_artifact:result-dirs:0", directory: "out", kind: "FILE", mimeType: "text/csv", name: "report.csv", size: 8 },
      ]);
      expect(goal?.artifactCount).toBe(2);
      expect(fixture.database.transaction(db => db.prepare("SELECT json_array_length(artifacts_json) AS count FROM work_results WHERE result_id='result-dirs'").get()?.count)).toBe(4);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a completion whose Turn belongs to another input", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "隔离", personaSummary: "private", projectLabel: "joi", scopeSummary: "Turn 归属" });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        const insertInput = connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
          VALUES (?, ?, ?, 'ROUTED', ?, ?, ?)`);
        insertInput.run("input-owner", "key-owner", "归属输入", workbench.workbenchId, now, now);
        insertInput.run("input-other", "key-other", "其他输入", workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-other', 'input-other', ?, 'session-other', 'RUNNING', ?, ?)`)
          .run(workbench.workbenchId, now, now);
      });
      const inbox = new SqliteJoiInboxRepository(fixture.database);

      await expect((inbox.completeInput as unknown as (
        inputId: string,
        turnId: string,
        completion: { completionSummary: string; outcome: "DIRECT_ANSWER" },
      ) => Promise<unknown>)("input-owner", "turn-other", {
        completionSummary: "不应落库",
        outcome: "DIRECT_ANSWER",
      })).rejects.toThrow("joi_turn_input_mismatch");
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT COUNT(*) AS count FROM joi_turn_completions",
      ).get())).toEqual({ count: 0 });
    } finally {
      await fixture.close();
    }
  });
});
