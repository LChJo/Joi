import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { JoiAttachmentService } from "../../src/main/infrastructure/artifacts/joi-attachment-service.js";
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
        text: "使用现有配置，以 bot 身份仅回复当前 T25。",
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
      const oldBrief = { acceptanceChecks: [{ kind: "BODY_PRESENT" }], evidenceResultIds: ["result-established"], instructions: "旧任务指令" };
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE work_items SET intent_json = ? WHERE work_id = 'work-action-question'").run(JSON.stringify(oldBrief));
        connection.exec("CREATE TRIGGER reject_resume_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'fixture_resume_abort'); END");
      });
      const newInstructions = "继续原任务：用户已确认以 bot 身份回复，仅处理当前 T25。保留已确认根因，交付 Markdown 裁决。";
      await expect(work.resume({
        actionId: "attention-action-question", instructions: newInstructions,
        turnId: "turn-action-retry-1", workId: "work-action-question", workbenchId: workbench.workbenchId,
      })).rejects.toThrow("fixture_resume_abort");
      expect(fixture.database.transaction((connection) => connection.prepare("SELECT intent_json FROM work_items WHERE work_id = 'work-action-question'").get()))
        .toEqual({ intent_json: JSON.stringify(oldBrief) });
      fixture.database.transaction((connection) => connection.exec("DROP TRIGGER reject_resume_outbox"));
      const firstResume = await work.resume({
        actionId: "attention-action-question",
        instructions: newInstructions,
        turnId: "turn-action-retry-1",
        workId: "work-action-question",
        workbenchId: workbench.workbenchId,
      });
      const retriedResume = await work.resume({
        actionId: "attention-action-question",
        instructions: "This duplicate must not replace the committed answer.",
        turnId: "turn-action-retry-2",
        workId: "work-action-question",
        workbenchId: workbench.workbenchId,
      });
      expect(retriedResume).toEqual(firstResume);
      const storedBrief = fixture.database.transaction((connection) => connection.prepare("SELECT intent_json FROM work_items WHERE work_id = 'work-action-question'").get()) as { intent_json: string };
      expect(JSON.parse(storedBrief.intent_json)).toEqual({ ...oldBrief, briefVersion: 2, instructions: newInstructions });
      const recreated = new WorkOrchestrationService({
        clock: fixture.clock, ids: fixture.ids, partners: fixture.partners,
        policy: { evaluate: () => Promise.resolve({ allowed: true }) },
        reassignment: new SqliteWorkPlanRepository(fixture.database), repository: new SqliteWorkPlanRepository(fixture.database),
      });
      await expect(recreated.resume({
        actionId: "attention-action-question", turnId: "turn-action-retry-2", workId: "work-action-question", workbenchId: workbench.workbenchId,
      })).resolves.toEqual(firstResume);
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, decision FROM joi_user_action_requests WHERE action_id = 'attention-action-question'",
      ).get())).toEqual({ decision: "RESUME", status: "APPLIED" });
      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT w.access_mode, p.access_mode AS policy_access FROM work_items w
        LEFT JOIN work_access_policies p ON p.work_id = w.work_id WHERE w.work_id = 'work-action-question'`).get()))
        .toEqual({ access_mode: "READ", policy_access: null });
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

  it("binds a workbench for a card whose question was re-raised under a newer version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-clarify-workbench-stale-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const repository = new SqliteJoiInboxRepository(database, clock);
      const inbox = new JoiInboxService({ clock, ids: new TestIds(), repository });
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "workbench-1", "前端工坊", "pr-1", "persona", "scope", "proj", "ns-1", "ACTIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      ));
      const accepted = await inbox.accept({ idempotencyKey: "key-stale", text: "研究登录改造" });

      // The card the user is looking at advertises one question; a later re-raise bumps the gate.
      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid");
      const onScreen = await questionVersion(repository, accepted.inputId);
      database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_execution_gates SET question_version = question_version + 1, question_id = ? WHERE goal_input_id = ?",
      ).run(`goal_question:${accepted.inputId}:v2`, accepted.inputId));

      expect(await repository.clarify(accepted.inputId, { ...onScreen, workbenchId: "workbench-1" }))
        .toMatchObject({ status: "ROUTED", workbenchId: "workbench-1" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("still refuses an answer that does not match the question on screen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-clarify-stale-answer-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const repository = new SqliteJoiInboxRepository(database, clock);
      const inbox = new JoiInboxService({ clock, ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-stale-answer", text: "继续实现" });
      await repository.requireClarification(accepted.inputId, "question_required", "使用哪个配置？");
      const onScreen = await questionVersion(repository, accepted.inputId);
      database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_execution_gates SET question_version = question_version + 1, question_id = ? WHERE goal_input_id = ?",
      ).run(`goal_question:${accepted.inputId}:v2`, accepted.inputId));

      expect(await repository.clarify(accepted.inputId, { ...onScreen, text: "用 A 配置" })).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("inherits the goal's attachments and embeds the goal body when building the resume input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-clarify-resume-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const ids = new TestIds();
      const attachments = new JoiAttachmentService({ clock, database, ids, rootDirectory: path.join(root, "artifacts") });
      const repository = new SqliteJoiInboxRepository(database, clock);
      const inbox = new JoiInboxService({ clock, ids, repository });
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "workbench-resume", "前端搭档", "pr-resume", "persona", "scope", "proj", "ns-resume", "ACTIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      ));
      const uploaded = await attachments.upload({ bytes: new TextEncoder().encode("screenshot bytes"), filename: "image.png", mimeType: "image/png" });
      const accepted = await inbox.accept({ attachmentIds: [uploaded.attachmentId], idempotencyKey: "key-resume-attachments", text: "分析报错：如图" });

      // A workbench-selection clarification never reaches a reasoning Turn, so
      // the resumed input is the model's first and only view of the goal.
      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid");
      await repository.clarify(accepted.inputId, {
        ...await questionVersion(repository, accepted.inputId), workbenchId: "workbench-resume",
      });

      const resumeInput = database.transaction((connection) => connection.prepare(
        "SELECT input_id, body FROM joi_inbox_messages WHERE goal_input_id = ? AND input_id LIKE 'joi_goal_resume:goal:%'",
      ).get(accepted.inputId)) as { body: string; input_id: string };
      expect(resumeInput.body).toContain("savedGoalAndAnswers=分析报错：如图");
      expect(await repository.loadInput(resumeInput.input_id)).toMatchObject({
        attachments: [{ attachmentId: uploaded.attachmentId, filename: "image.png", mimeType: "image/png", size: 16 }],
      });
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

  it("opens the goal a user just answered so the home feed puts it back on top", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const older = await inbox.accept({ idempotencyKey: "key-open-older", text: "旧目标：改造登录" });
      fixture.clock.advance(60_000);
      const newer = await inbox.accept({ idempotencyKey: "key-open-newer", text: "新目标：整理文档" });
      const feed = () => new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());

      // Creation order decides until someone acts on a goal.
      expect((await feed()).goals.map((goal) => goal.goalId)).toEqual([newer.inputId, older.inputId]);

      fixture.clock.advance(60_000);
      await repository.requireClarification(older.inputId, "workbench_selection_invalid");
      await repository.clarify(older.inputId, {
        ...await questionVersion(repository, older.inputId), text: "是登录模块",
      });

      // Answering is an explicit user action on that goal, so it outranks the newer one's
      // untouched creation time instead of sinking under it.
      expect((await feed()).goals.map((goal) => goal.goalId)).toEqual([older.inputId, newer.inputId]);
    } finally {
      await fixture.close();
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

  it("grants continuation allowance above recovery-appended layers, not a blind +2", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "研究", personaSummary: "persona", projectLabel: "joi", scopeSummary: "研究" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-goal-continuation-overshoot", text: "研究 AI 资讯", workbenchId: workbench.workbenchId });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-continuation-overshoot', ?, ?, 'session-continuation-overshoot', 'COMPLETED', ?, ?)`)
          .run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = 'goal_continuation_required', clarification_prompt = '证据仍有缺口。' WHERE input_id = ?").run(accepted.inputId);
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, continuation_allowance, created_at, updated_at)
          VALUES (?, ?, '完成资讯横评', 'ACTIVE', 2, ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        // Work recovery appended layers past the allowance: depth 5 against allowance 2.
        const insertPath = connection.prepare(`INSERT INTO joi_harness_paths
          (path_id, goal_input_id, layer, title, status, created_at, updated_at)
          VALUES (?, ?, ?, '补充证据', 'CLOSED', ?, ?)`);
        for (let layer = 1; layer <= 5; layer += 1) insertPath.run(`path-overshoot-${String(layer)}`, accepted.inputId, layer, now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 3, 3, ?)`).run(accepted.inputId, now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at, disposition)
          VALUES (?, 3, '已有横评，近七天来源仍不足。', ?, ?, 'CONTINUE')`).run(accepted.inputId, now, now);
        connection.prepare(`INSERT INTO joi_user_action_requests
          (action_id, input_id, result_revision, kind, status, reason_code, prompt, created_at, updated_at)
          VALUES ('overshoot-action', ?, 3, 'GOAL_CONTINUATION', 'OPEN', 'goal_continuation_required', '证据仍有缺口。', ?, ?)`)
          .run(accepted.inputId, now, now);
      });

      await expect(inbox.clarify({ actionChoice: "CONTINUE", inputId: accepted.inputId })).resolves.toMatchObject({ status: "CONSUMED" });
      // A blind +2 would land on 4 == MAX(layer)-1 and stall; the grant must clear the depth.
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT continuation_allowance FROM joi_harness_maps WHERE goal_input_id = ?").get(accepted.inputId)))
        .toEqual({ continuation_allowance: 6 });
      expect(await new SqliteJoiHarnessRepository(fixture.database).listReviewDigests())
        .toEqual([expect.objectContaining({ goalInputId: accepted.inputId, resultRevision: 3 })]);
    } finally {
      fixture.database.close();
    }
  });

  it("resolves a continuation decision that is raised while the goal gate is still open", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "研究", personaSummary: "persona", projectLabel: "joi", scopeSummary: "研究" });
      const inboxRepository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository: inboxRepository });
      const accepted = await inbox.accept({ idempotencyKey: "key-gate-open-continuation", text: "研究 AI 资讯", workbenchId: workbench.workbenchId });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-gate-open', ?, ?, 'session-gate-open', 'COMPLETED', ?, ?)`)
          .run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(accepted.inputId);
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, continuation_allowance, created_at, updated_at)
          VALUES (?, ?, '完成资讯横评', 'ACTIVE', 2, ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        const insertPath = connection.prepare(`INSERT INTO joi_harness_paths
          (path_id, goal_input_id, layer, title, status, created_at, updated_at)
          VALUES (?, ?, ?, '补充证据', 'CLOSED', ?, ?)`);
        for (let layer = 1; layer <= 4; layer += 1) insertPath.run(`path-gate-open-${String(layer)}`, accepted.inputId, layer, now, now);
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 7, 7, ?)`).run(accepted.inputId, now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at, disposition)
          VALUES (?, 7, '已有横评，近七天来源仍不足。', ?, ?, 'CONTINUE')`).run(accepted.inputId, now, now);
        // An earlier goal question was already answered, which leaves the gate OPEN rather than
        // WAITING_INPUT — the state the decision card has to survive.
        connection.prepare(`INSERT INTO joi_goal_execution_gates
          (goal_input_id, question_id, question_version, status, reason_code, created_at, updated_at)
          VALUES (?, ?, 1, 'OPEN', 'question_required', ?, ?)`)
          .run(accepted.inputId, `goal_question:${accepted.inputId}:v1`, now, now);
      });
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      const [seed] = await harness.listContinuationDecisionSeeds();
      if (seed === undefined) throw new Error("expected continuation decision seed");
      await expect(harness.requestContinuationDecision({ now, seed })).resolves.toBe(true);

      const gate = fixture.database.transaction((connection) => connection.prepare(
        "SELECT question_id, question_version, status FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(accepted.inputId)) as {
          question_id: string; question_version: number; status: string;
        };
      expect(gate.status).toBe("WAITING_INPUT");
      expect(gate.question_version).toBe(2);

      // The card must be resolvable with the question the gate actually advertises.
      await expect(inbox.clarify({
        actionChoice: "CONTINUE", inputId: accepted.inputId,
        questionId: gate.question_id, questionVersion: gate.question_version,
      })).resolves.toMatchObject({ status: "CONSUMED" });
      // Deciding clears the gate back to OPEN, which is what review recovery requires to resume.
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(accepted.inputId)))
        .toEqual({ status: "OPEN" });
    } finally {
      fixture.database.close();
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

  it("names a Work that is already running in the recovery prompt", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "收尾", personaSummary: "persona", projectLabel: "joi", scopeSummary: "收尾" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "resume-live-work", text: "继续收尾", workbenchId: workbench.workbenchId });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('goal-turn', ?, ?, 'session', 'COMPLETED', ?, ?)`).run(goal.inputId, workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-running', ?, ?, '写接口', '{}', 'READ', 'RUNNING', ?, ?)`).run(workbench.workbenchId, goal.inputId, now, now);
      });
      await repository.requireClarification(goal.inputId, "question_required", "范围？");
      await inbox.clarify({ inputId: goal.inputId, questionId: `goal_question:${goal.inputId}:v1`, questionVersion: 1, text: "全部" });

      // The prompt is the resumed Turn's only view of what exists. A Work it cannot see is one it
      // dispatches a second time, and the two then run side by side under the same goal.
      const resumeId = `joi_goal_resume:goal:${goal.inputId}:v1`;
      expect((await repository.loadInput(resumeId))?.body).toContain("existingWorkId=work-running status=RUNNING");
    } finally {
      await fixture.close();
    }
  });
});
