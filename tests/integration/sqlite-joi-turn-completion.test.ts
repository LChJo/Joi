import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { HISTORICAL_MEMORY_KIND } from "../../src/main/application/ports/historical-memory.js";
import { createModelSource } from "../../src/main/domain/model-sources/model-source.js";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store.js";
import { SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteModelSourceRepository } from "../../src/main/infrastructure/persistence/sqlite-model-source-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("persisted joi Turn completions", () => {
  it.each(["first assignment", "recovery"])("publishes a greeting on the original goal after %s", async (mode) => {
    const fixture = await createRuntimeFixture();
    const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
    const inputs = new JoiInboxService({ repository: inbox, clock: fixture.clock, ids: fixture.ids });
    const harness = new SqliteJoiHarnessRepository(fixture.database);
    const feed = new SqliteJoiHomeFeedRepository(fixture.database);
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "日常交流工坊", personaSummary: "fixture", projectLabel: "日常", scopeSummary: "交流" });
      const goal = await inputs.accept({ text: "hi", idempotencyKey: "fixture-greeting" });
      const fresh = mode === "first assignment";
      if (!fresh) fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET workbench_id=? WHERE input_id=?").run(workbench.workbenchId, goal.inputId));
      await inbox.requireClarification(goal.inputId, "workbench_selection_invalid");
      const choice = (await inputs.list())[0];
      if (choice?.questionId === undefined || choice.questionVersion === undefined) throw new Error("Missing workbench choice");
      const selected = await inputs.clarify({ inputId: goal.inputId, questionId: choice.questionId, questionVersion: choice.questionVersion, workbenchId: workbench.workbenchId });
      expect(selected.status).toBe(fresh ? "PENDING" : "ROUTED");
      const resumeId = `joi_goal_resume:goal:${goal.inputId}:v${String(choice.questionVersion)}`;
      const now = fixture.clock.now().toISOString();
      const source = createModelSource({ createdAt: now, credentialRef: "fixture-ref", credentialVersion: 1,
        displayName: "Fixture", kind: "deepseek", modelCapability: "release-tested", modelId: "fixture-model",
        modelRevisionId: "fixture-model-revision", sourceId: "fixture-source", sourceRevisionId: "fixture-source-revision" });
      fixture.database.transaction(db => db.prepare(`INSERT INTO model_source_credentials
        (provider_id, credential_type, encrypted_blob, credential_version, updated_at) VALUES ('fixture-ref','api_key',?,1,?)`)
        .run(new Uint8Array([1, 2, 3]), now));
      await new SqliteModelSourceRepository(fixture.database).create({ local: false, order: 0, primary: true, source });
      const reply = "你好！";
      let modelTurns = 0;
      const coordinator = new JoiCoordinator({
        clock: fixture.clock, ids: fixture.ids, store: inbox, workbenches: fixture.workbenches,
        ...(fresh ? { requirements: new SqliteGoalRequirementsRepository(fixture.database) } : {}),
        router: { decide: () => Promise.reject(new Error("The workbench was already selected")) },
        sources: { selectInitial: (turnId) => Promise.resolve({ turnId, sourceId: "fixture-source", sourceRevisionId: "fixture-source-revision", modelId: "fixture-model", modelRevisionId: "fixture-model-revision" }) },
        runtime: {
          abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: () => Promise.resolve(false),
          rollbackTurn: () => Promise.resolve(false), steer: () => undefined, waitForIdle: () => Promise.resolve(),
          startTurn: async (turn) => {
            modelTurns++;
            expect.soft(await harness.listGoalsWithoutMap()).toEqual([]);
            if (fresh) {
              expect(turn.inputId).toBe(goal.inputId);
              expect(turn.prompt).toBe("hi");
              turn.onEvent?.({ type: "text_delta", delta: reply, turnId: turn.turnId });
              turn.onEvent?.({ type: "turn_finished", turnId: turn.turnId });
              return;
            }
            await harness.createMap({ goalInputId: goal.inputId, workbenchId: workbench.workbenchId, now });
            turn.onEvent?.({ type: "tool_started", toolCallId: "resume", toolName: "goal_resume", turnId: turn.turnId });
            await inbox.resumeGoal({ inputId: resumeId, turnId: turn.turnId });
            turn.onEvent?.({ type: "tool_finished", isError: false, toolCallId: "resume", toolName: "goal_resume", turnId: turn.turnId });
            expect.soft(await harness.listTrivialMapCandidates()).toEqual([]);
            expect.soft(await harness.clearTrivialMap({ goalInputId: goal.inputId, now })).toBe(false);
            turn.onEvent?.({ type: "tool_started", toolCallId: "answer", toolName: "turn_complete", turnId: turn.turnId });
            turn.onEvent?.({ type: "tool_finished", isError: false, outcome: "DIRECT_ANSWER", toolCallId: "answer", toolName: "turn_complete", turnId: turn.turnId });
            turn.onEvent?.({ type: "text_delta", delta: reply, turnId: turn.turnId });
            turn.onEvent?.({ type: "turn_finished", turnId: turn.turnId });
          },
        },
      });
      await coordinator.handle(fresh ? goal.inputId : resumeId);
      const card = (await feed.load(fixture.clock.now())).goals[0];
      expect.soft(card).toMatchObject({ goalId: goal.inputId, completionSummary: reply, status: "COMPLETED", work: { total: 0 } });
      expect.soft((await feed.listGoalResults(goal.inputId))?.items).toEqual([expect.objectContaining({ resultId: card?.resultId, status: "COMPLETED" })]);
      if (fresh) {
        expect(modelTurns).toBe(1);
        expect(await inbox.loadInput(resumeId)).toBeNull();
        expect(card?.harness).toBeUndefined();
        return;
      }
      const unrelated = await inputs.accept({ text: "Another goal", idempotencyKey: "fixture-other-goal", workbenchId: workbench.workbenchId });
      fixture.database.transaction(db => {
        db.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(unrelated.inputId);
        db.prepare(`INSERT INTO joi_goal_execution_gates
          (goal_input_id, question_id, question_version, status, reason_code, resume_input_id, created_at, updated_at)
          VALUES (?, 'fixture-other-question', 1, 'OPEN', 'fixture', ?, ?, ?)`).run(unrelated.inputId, resumeId, now, now);
      });
      const otherCard = (await feed.load(fixture.clock.now())).goals.find((item) => item.goalId === unrelated.inputId);
      expect(otherCard?.completionSummary).toBeUndefined();
      expect(await harness.listTrivialMapCandidates()).toEqual([{ goalInputId: goal.inputId }]);
      expect(await harness.clearTrivialMap({ goalInputId: goal.inputId, now })).toBe(true);
      await inbox.retry(goal.inputId, {});
      await inbox.createTurn({ createdAt: now, inputId: goal.inputId, sessionId: "fixture-continued", turnId: "fixture-continued", workbenchId: workbench.workbenchId });
      await inbox.completeInput(goal.inputId, "fixture-continued");
      const retried = (await feed.load(fixture.clock.now())).goals.find((item) => item.goalId === goal.inputId);
      expect(retried).toMatchObject({ goalId: goal.inputId, status: "FAILED" });
      expect(retried?.completionSummary).toBeUndefined();
      expect((await feed.listGoalResults(goal.inputId))?.items).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

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
        connection.prepare("UPDATE joi_turns SET requirements_revision = 0 WHERE turn_id = 'turn-direct'").run();
      });
      const inbox = new SqliteJoiInboxRepository(fixture.database);
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      const evolution = new SqliteEvolutionStore(fixture.database);
      evolution.bindGoal(workbench.workbenchId, "input-direct", null);
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      expect(await requirements.ensure({ goalInputId: "input-direct", workbenchId: workbench.workbenchId })).toMatchObject({ status: "DIRTY", sourceRevision: 1 });
      expect.soft(await harness.listGoalsWithoutMap()).toEqual([]);
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
      expect.soft(feed.goals[0]?.harness).toBeUndefined();
      expect.soft(await harness.listGoalsWithoutMap()).toEqual([]);
      expect.soft(await harness.listReviewDigests()).toEqual([]);
      expect.soft(await harness.listFeedbackTargets()).toEqual([]);
      expect.soft(await requirements.load("input-direct")).toMatchObject({ processedSourceRevision: 0 });
      expect.soft(evolution.evidenceSeeds()).toEqual([]);
      expect.soft(fixture.database.transaction((connection) => connection.prepare(
        "SELECT 1 FROM outbox WHERE kind = ?",
      ).all(HISTORICAL_MEMORY_KIND))).toEqual([]);

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
