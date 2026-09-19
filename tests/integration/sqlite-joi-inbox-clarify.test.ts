import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

async function questionVersion(repository: SqliteJoiInboxRepository, inputId: string) {
  const question = (await repository.list()).find((item) => item.inputId === inputId);
  if (question?.questionId === undefined || question.questionVersion === undefined) throw new Error("question metadata missing");
  return { expectedQuestionId: question.questionId, expectedQuestionVersion: question.questionVersion };
}

describe("sqlite joi inbox clarify", () => {
  it("resolves a persisted partner question to the exact waiting Work", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "恢复", personaSummary: "persona", projectLabel: "joi", scopeSummary: "恢复等待工作" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-action-question", text: "继续实现", workbenchId: workbench.workbenchId });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-action-question', ?, ?, 'session-action-question', 'COMPLETED', ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan-action-question', 'turn-action-question', '{}', '[]', ?)`).run(now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-action-question', ?, ?, '继续实现', '{}', 'READ', 'WAITING', ?, ?)`).run(workbench.workbenchId, accepted.inputId, now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
          VALUES ('attempt-action-question', 'plan-action-question', 'work-action-question', ?, 1, 'dispatch-action-question', 'WAITING_INPUT', ?, ?)`)
          .run(partner.partnerRevisionId, now, now);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES ('run-action-question', 'attempt-action-question', 'dispatch-action-question', ?, 'work-action-question', ?, 'LOCAL_PI', 'local:action-question', 'WAITING_INPUT', ?, ?)`)
          .run(workbench.workbenchId, partner.partnerRevisionId, now, now);
      });
      await repository.requireClarification(accepted.inputId, "question_required", "使用哪个配置？", {
        actionId: "attention-action-question",
        kind: "PARTNER_QUESTION",
        runId: "run-action-question",
        workId: "work-action-question",
      });

      const question = await questionVersion(repository, accepted.inputId);
      await inbox.clarify({
        inputId: accepted.inputId,
        questionId: question.expectedQuestionId,
        questionVersion: question.expectedQuestionVersion,
        text: "使用现有配置",
      });

      expect(await repository.loadInput(accepted.inputId)).toMatchObject({
        resolvedAction: { actionId: "attention-action-question", decision: "RESUME", workId: "work-action-question" },
        status: "ROUTED",
      });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, decision FROM joi_user_action_requests WHERE action_id = 'attention-action-question'",
      ).get())).toEqual({ decision: "RESUME", status: "RESOLVED" });

      const resumeInput = fixture.database.transaction((connection) => connection.prepare(
        "SELECT input_id, body FROM joi_inbox_messages WHERE goal_input_id = ? AND input_id LIKE 'joi_goal_resume:goal:%'",
      ).get(accepted.inputId)) as { body: string; input_id: string };
      expect(resumeInput.body).toContain("resolvedActionId=attention-action-question");
      await repository.createTurn({
        workbenchId: workbench.workbenchId,
        createdAt: now,
        inputId: resumeInput.input_id,
        sessionId: "resume-session",
        turnId: "turn-goal-resume",
      });
      await repository.resumeGoal({ inputId: resumeInput.input_id, turnId: "turn-goal-resume" });
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES ('turn-action-retry-1', ?, ?, 'session-action-retry', 'RUNNING', ?, ?),
               ('turn-action-retry-2', ?, ?, 'session-action-retry', 'RUNNING', ?, ?)`)
        .run(accepted.inputId, workbench.workbenchId, now, now, accepted.inputId, workbench.workbenchId, now, now));
      const workRepository = new SqliteWorkPlanRepository(fixture.database);
      const work = new WorkOrchestrationService({
        clock: fixture.clock,
        ids: fixture.ids,
        partners: fixture.partners,
        policy: { evaluate: () => Promise.resolve({ allowed: true }) },
        reassignment: workRepository,
        repository: workRepository,
      });
      const firstResume = await work.resume({
        actionId: "attention-action-question",
        turnId: "turn-action-retry-1",
        workId: "work-action-question",
        workbenchId: workbench.workbenchId,
      });
      const retriedResume = await work.resume({
        actionId: "attention-action-question",
        turnId: "turn-action-retry-2",
        workId: "work-action-question",
        workbenchId: workbench.workbenchId,
      });
      expect(retriedResume).toEqual(firstResume);
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, decision FROM joi_user_action_requests WHERE action_id = 'attention-action-question'",
      ).get())).toEqual({ decision: "RESUME", status: "APPLIED" });
      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT w.access_mode, p.access_mode AS policy_access FROM work_items w
        JOIN work_access_policies p ON p.work_id = w.work_id WHERE w.work_id = 'work-action-question'`).get()))
        .toEqual({ access_mode: "WRITE", policy_access: "WRITE" });
      expect(fixture.database.transaction((connection) => ({
        activeAttempts: connection.prepare(`SELECT COUNT(*) AS count FROM dispatch_attempts
          WHERE work_id = 'work-action-question' AND status = 'PENDING'`).get(),
        oldAttempt: connection.prepare(`SELECT status FROM dispatch_attempts
          WHERE dispatch_attempt_id = 'attempt-action-question'`).get(),
        oldRun: connection.prepare(`SELECT status FROM partner_runs
          WHERE run_id = 'run-action-question'`).get(),
      }))).toEqual({
        activeAttempts: { count: 1 },
        oldAttempt: { status: "FAILED" },
        oldRun: { status: "FAILED" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("re-queues a clarified input with the chosen Workbench and refuses non-clarification rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-clarify-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const repository = new SqliteJoiInboxRepository(database, clock);
      const inbox = new JoiInboxService({ clock, ids: new TestIds(), repository });
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "workbench-1", "前端搭档", "pr-1", "persona", "scope", "proj", "ns-1", "ACTIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      ));
      const accepted = await inbox.accept({ idempotencyKey: "key-1", text: "研究登录改造" });

      expect(await repository.clarify("does-not-exist", { workbenchId: "workbench-1" })).toBeNull();
      expect(await repository.clarify(accepted.inputId, { workbenchId: "workbench-1" })).toBeNull();

      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid");
      const clarified = await repository.clarify(accepted.inputId, {
        ...await questionVersion(repository, accepted.inputId), workbenchId: "workbench-1",
      });
      expect(clarified).toMatchObject({ workbenchId: "workbench-1", body: "研究登录改造", inputId: accepted.inputId, status: "ROUTED" });
      expect(clarified?.clarificationReasonCode).toBeUndefined();
      expect(await repository.clarify(accepted.inputId, { text: "too late" })).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("appends supplementary text to the stored body before re-queuing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-clarify-text-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const repository = new SqliteJoiInboxRepository(database, clock);
      const inbox = new JoiInboxService({ clock, ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-2", text: "归属？" });
      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid");
      const clarified = await repository.clarify(accepted.inputId, {
        ...await questionVersion(repository, accepted.inputId), text: "是登录模块",
      });
      expect(clarified?.body).toBe("归属？\n\n[用户补充] 是登录模块");
      expect(clarified?.status).toBe("ROUTED");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("atomically applies a partner choice only to the matching clarification reason", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partner-choice-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const repository = new SqliteJoiInboxRepository(database, clock);
      const inbox = new JoiInboxService({ clock, ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-partner", text: "分析任务" });
      await repository.requireClarification(accepted.inputId, "question_required", "选择搭档？");
      expect(await repository.clarify(accepted.inputId, {
        expectedReasonCode: "partner_selection_required", text: "partnerId=partner-1",
      })).toBeNull();
      expect((await repository.list()).find((item) => item.inputId === accepted.inputId)?.status).toBe("CLARIFICATION_REQUIRED");

      await repository.requireClarification(accepted.inputId, "partner_selection_required", "选择搭档继续。");
      const clarified = await repository.clarify(accepted.inputId, {
        ...await questionVersion(repository, accepted.inputId),
        expectedReasonCode: "partner_selection_required", text: "partnerId=partner-1",
      });
      expect(clarified).toMatchObject({ status: "ROUTED" });
      expect(clarified?.body).toContain("partnerId=partner-1");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists the question and does not consume an input that is waiting for an answer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-question-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const repository = new SqliteJoiInboxRepository(database, clock);
      const inbox = new JoiInboxService({ clock, ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-question", text: "请规划发布" });
      await repository.requireClarification(accepted.inputId, "question_required", "生产发布时间是什么时候？");
      await repository.completeInput(accepted.inputId, "turn-question");

      expect((await inbox.list()).find((item) => item.inputId === accepted.inputId)).toMatchObject({
        clarificationPrompt: "生产发布时间是什么时候？",
        clarificationReasonCode: "question_required",
        status: "CLARIFICATION_REQUIRED",
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("applies a goal continuation decision without rerouting the original input", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "研究", personaSummary: "persona", projectLabel: "joi", scopeSummary: "研究" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-goal-continuation", text: "研究 AI 资讯", workbenchId: workbench.workbenchId });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-goal-continuation', ?, ?, 'session-goal-continuation', 'COMPLETED', ?, ?)`)
          .run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = 'goal_continuation_required', clarification_prompt = '证据仍有缺口。' WHERE input_id = ?").run(accepted.inputId);
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, continuation_allowance, created_at, updated_at)
          VALUES (?, ?, '完成资讯横评', 'ACTIVE', 2, ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 3, 3, ?)`).run(accepted.inputId, now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at, disposition)
          VALUES (?, 3, '已有横评，近七天来源仍不足。', ?, ?, 'CONTINUE')`).run(accepted.inputId, now, now);
        connection.prepare(`INSERT INTO joi_user_action_requests
          (action_id, input_id, result_revision, kind, status, reason_code, prompt, created_at, updated_at)
          VALUES ('continue-action', ?, 3, 'GOAL_CONTINUATION', 'OPEN', 'goal_continuation_required', '证据仍有缺口。', ?, ?)`)
          .run(accepted.inputId, now, now);
      });

      await expect(inbox.clarify({ actionChoice: "CONTINUE", inputId: accepted.inputId })).resolves.toMatchObject({ status: "CONSUMED" });
      expect(fixture.database.transaction((connection) => ({
        action: connection.prepare("SELECT decision, status FROM joi_user_action_requests WHERE action_id = 'continue-action'").get(),
        goal: connection.prepare("SELECT status, clarification_reason_code FROM joi_inbox_messages WHERE input_id = ?").get(accepted.inputId),
        map: connection.prepare("SELECT continuation_allowance, status FROM joi_harness_maps WHERE goal_input_id = ?").get(accepted.inputId),
      }))).toEqual({
        action: { decision: "CONTINUE", status: "APPLIED" },
        goal: { clarification_reason_code: null, status: "CONSUMED" },
        map: { continuation_allowance: 4, status: "ACTIVE" },
      });
      // Granting two more layers must make the same CONTINUE revision reviewable again.
      expect(await new SqliteJoiHarnessRepository(fixture.database).listReviewDigests())
        .toEqual([expect.objectContaining({ goalInputId: accepted.inputId, resultRevision: 3 })]);

      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = 'goal_continuation_required' WHERE input_id = ?").run(accepted.inputId);
        connection.prepare(`INSERT INTO joi_user_action_requests
          (action_id, input_id, result_revision, kind, status, reason_code, prompt, created_at, updated_at)
          VALUES ('accept-action', ?, 3, 'GOAL_CONTINUATION', 'OPEN', 'goal_continuation_required', '证据仍有缺口。', ?, ?)`)
          .run(accepted.inputId, now, now);
      });
      await expect(inbox.clarify({ actionChoice: "ACCEPT_CURRENT", inputId: accepted.inputId })).resolves.toMatchObject({ status: "CONSUMED" });
      const facts = fixture.database.transaction((connection) => ({
        action: connection.prepare("SELECT decision, status FROM joi_user_action_requests WHERE action_id = 'accept-action'").get(),
        map: connection.prepare("SELECT status FROM joi_harness_maps WHERE goal_input_id = ?").get(accepted.inputId),
        outcome: connection.prepare("SELECT disposition, completed_at FROM joi_goal_outcomes WHERE input_id = ?").get(accepted.inputId),
      })) as {
        action: { decision: string; status: string };
        map: { status: string };
        outcome: { completed_at: string; disposition: string };
      };
      expect(facts).toEqual({
        action: { decision: "ACCEPT_CURRENT", status: "APPLIED" },
        map: { status: "CLEARED" },
        outcome: { completed_at: facts.outcome.completed_at, disposition: "ACCEPTED_WITH_GAPS" },
      });
      expect(Number.isNaN(Date.parse(facts.outcome.completed_at))).toBe(false);
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals[0]).toMatchObject({
        completionSummary: "已有横评，近七天来源仍不足。",
        goalId: accepted.inputId,
        status: "COMPLETED_WITH_GAPS",
      });
      expect(feed.thinking).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
