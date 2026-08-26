import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

describe("sqlite joi inbox clarify", () => {
  it("resolves a persisted partner question to the exact waiting Work", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "恢复", personaSummary: "persona", projectLabel: "joi", scopeSummary: "恢复等待工作" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
      const repository = new SqliteJoiInboxRepository(fixture.database);
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

      await inbox.clarify({ inputId: accepted.inputId, text: "使用现有配置" });

      expect(await repository.loadInput(accepted.inputId)).toMatchObject({
        resolvedAction: { actionId: "attention-action-question", decision: "RESUME", workId: "work-action-question" },
        status: "PENDING",
      });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, decision FROM joi_user_action_requests WHERE action_id = 'attention-action-question'",
      ).get())).toEqual({ decision: "RESUME", status: "RESOLVED" });

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
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "workbench-1", "前端搭档", "pr-1", "persona", "scope", "proj", "ns-1", "ACTIVE", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      ));
      const accepted = await inbox.accept({ idempotencyKey: "key-1", text: "研究登录改造" });

      expect(await repository.clarify("does-not-exist", { workbenchId: "workbench-1" })).toBeNull();
      expect(await repository.clarify(accepted.inputId, { workbenchId: "workbench-1" })).toBeNull();

      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid");
      const clarified = await repository.clarify(accepted.inputId, { workbenchId: "workbench-1" });
      expect(clarified).toMatchObject({ workbenchId: "workbench-1", body: "研究登录改造", inputId: accepted.inputId, status: "PENDING" });
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
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-2", text: "归属？" });
      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid");
      const clarified = await repository.clarify(accepted.inputId, { text: "是登录模块" });
      expect(clarified?.body).toBe("归属？\n\n[用户补充] 是登录模块");
      expect(clarified?.status).toBe("PENDING");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("atomically applies a partner choice only to the matching clarification reason", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partner-choice-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-partner", text: "分析任务" });
      await repository.requireClarification(accepted.inputId, "question_required", "选择搭档？");
      expect(await repository.clarify(accepted.inputId, {
        expectedReasonCode: "partner_selection_required", text: "partnerId=partner-1",
      })).toBeNull();
      expect((await repository.list()).find((item) => item.inputId === accepted.inputId)?.status).toBe("CLARIFICATION_REQUIRED");

      await repository.requireClarification(accepted.inputId, "partner_selection_required", "选择搭档继续。");
      const clarified = await repository.clarify(accepted.inputId, {
        expectedReasonCode: "partner_selection_required", text: "partnerId=partner-1",
      });
      expect(clarified).toMatchObject({ status: "PENDING" });
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
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
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
});
