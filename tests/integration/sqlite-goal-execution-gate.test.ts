import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("goal execution gate", () => {
  it("versions answers, enters review, and opens only from the matching recovery turn", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "发布", personaSummary: "persona", projectLabel: "joi", scopeSummary: "发布" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "gate-goal", text: "准备发布", workbenchId: workbench.workbenchId });

      await repository.requireClarification(goal.inputId, "question_required", "要覆盖哪些平台？");
      const waiting = (await inbox.list()).find((item) => item.inputId === goal.inputId);
      expect(waiting).toMatchObject({
        questionVersion: 1,
        status: "CLARIFICATION_REQUIRED",
      });
      expect(typeof waiting?.questionId).toBe("string");
      if (waiting?.questionId === undefined || waiting.questionVersion === undefined) throw new Error("question metadata missing");

      await repository.requireClarification(goal.inputId, "question_required", "需要发布到哪些操作系统？");
      const revised = (await inbox.list()).find((item) => item.inputId === goal.inputId);
      expect(revised).toMatchObject({ questionVersion: 2 });
      if (revised?.questionId === undefined || revised.questionVersion === undefined) throw new Error("revised question metadata missing");
      await expect(inbox.clarify({
        inputId: goal.inputId,
        questionId: waiting.questionId,
        questionVersion: waiting.questionVersion,
        text: "Windows 和 macOS",
      })).rejects.toMatchObject({ code: "joi_clarification_unavailable" });
      await expect(inbox.clarify({
        inputId: goal.inputId,
        questionId: revised.questionId,
        questionVersion: revised.questionVersion,
        text: "Windows 和 macOS",
      })).resolves.toMatchObject({ status: "ROUTED" });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, question_id, question_version FROM joi_goal_execution_gates WHERE goal_input_id = ?",
      ).get(goal.inputId))).toEqual({
        question_id: revised.questionId,
        question_version: 2,
        status: "REVIEWING",
      });

      const resume = fixture.database.transaction((connection) => connection.prepare(
        "SELECT input_id FROM joi_inbox_messages WHERE goal_input_id = ? AND input_id LIKE 'joi_goal_resume:goal:%'",
      ).get(goal.inputId)) as { input_id: string };
      await repository.createTurn({
        workbenchId: workbench.workbenchId,
        createdAt: fixture.clock.now().toISOString(),
        inputId: resume.input_id,
        sessionId: "resume-session",
        turnId: "resume-turn",
      });
      await expect(repository.resumeGoal({
        inputId: resume.input_id,
        turnId: "resume-turn",
      })).resolves.toEqual({ status: "OPEN" });
      await expect(repository.resumeGoal({
        inputId: resume.input_id,
        turnId: "resume-turn",
      })).resolves.toEqual({ status: "OPEN" });
    } finally {
      await fixture.close();
    }
  });

  it("closes the dispatch/commit race inside the work-plan transaction", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "竞态", personaSummary: "persona", projectLabel: "joi", scopeSummary: "竞态" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "执行搭档", kind: "local-pi", skills: [], tools: [] });
      const inboxRepository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository: inboxRepository });
      const goal = await inbox.accept({ idempotencyKey: "gate-race", text: "执行", workbenchId: workbench.workbenchId });
      await inboxRepository.createTurn({
        workbenchId: workbench.workbenchId,
        createdAt: fixture.clock.now().toISOString(),
        inputId: goal.inputId,
        sessionId: "race-session",
        turnId: "race-turn",
      });
      const workRepository = new SqliteWorkPlanRepository(fixture.database);
      const service = new WorkOrchestrationService({
        clock: fixture.clock,
        goalGate: workRepository,
        ids: fixture.ids,
        partners: fixture.partners,
        policy: { evaluate: async () => {
          await inboxRepository.requireClarification(goal.inputId, "question_required", "先确认范围？");
          return { allowed: true };
        } },
        repository: workRepository,
      });

      await expect(service.plan({
        dependencies: [],
        inputId: goal.inputId,
        turnId: "race-turn",
        work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" }], accessMode: "READ", key: "run", partnerId: partner.partnerId, title: "执行" }],
        workbenchId: workbench.workbenchId,
      })).rejects.toMatchObject({ code: "goal_execution_paused" });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT COUNT(*) AS count FROM work_items WHERE input_id = ?",
      ).get(goal.inputId))).toEqual({ count: 0 });
    } finally {
      await fixture.close();
    }
  });

  it("retires an older recovery input when review asks a newer question", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "复核", personaSummary: "persona", projectLabel: "joi", scopeSummary: "复核" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "gate-requestion", text: "准备上线", workbenchId: workbench.workbenchId });

      await repository.requireClarification(goal.inputId, "question_required", "上线哪个环境？");
      const firstQuestion = (await inbox.list()).find((item) => item.inputId === goal.inputId);
      if (firstQuestion?.questionId === undefined || firstQuestion.questionVersion === undefined) throw new Error("question metadata missing");
      await inbox.clarify({
        inputId: goal.inputId,
        questionId: firstQuestion.questionId,
        questionVersion: firstQuestion.questionVersion,
        text: "生产环境",
      });
      const firstResumeId = `joi_goal_resume:goal:${goal.inputId}:v1`;
      await repository.createTurn({
        workbenchId: workbench.workbenchId,
        createdAt: fixture.clock.now().toISOString(),
        inputId: firstResumeId,
        sessionId: "resume-session-v1",
        turnId: "resume-turn-v1",
      });

      await repository.requireClarification(firstResumeId, "question_required", "是否需要灰度？");
      await repository.completeInput(firstResumeId, "resume-turn-v1");
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status FROM joi_inbox_messages WHERE input_id = ?",
      ).get(firstResumeId))).toEqual({ status: "CONSUMED" });

      const secondQuestion = (await inbox.list()).find((item) => item.inputId === goal.inputId);
      expect(secondQuestion).toMatchObject({ questionVersion: 2, status: "CLARIFICATION_REQUIRED" });
      if (secondQuestion?.questionId === undefined || secondQuestion.questionVersion === undefined) throw new Error("question metadata missing");
      await inbox.clarify({
        inputId: goal.inputId,
        questionId: secondQuestion.questionId,
        questionVersion: secondQuestion.questionVersion,
        text: "先灰度",
      });
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT input_id, status
        FROM joi_inbox_messages WHERE goal_input_id = ? AND input_id LIKE 'joi_goal_resume:goal:%'
        ORDER BY input_id`).all(goal.inputId))).toEqual([
        { input_id: firstResumeId, status: "CONSUMED" },
        { input_id: `joi_goal_resume:goal:${goal.inputId}:v2`, status: "PENDING" },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("assigns a derived-turn question to the original goal", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "研究", personaSummary: "persona", projectLabel: "joi", scopeSummary: "研究" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "gate-derived-goal", text: "研究", workbenchId: workbench.workbenchId });
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
        VALUES ('derived-review', 'derived-review-key', 'review', 'ROUTED', ?, ?, ?, ?)`)
        .run(workbench.workbenchId, goal.inputId, now, now));

      await repository.requireClarification("derived-review", "question_required", "还需要哪个市场？");
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)).toMatchObject({
        clarificationPrompt: "还需要哪个市场？",
        questionVersion: 1,
        status: "CLARIFICATION_REQUIRED",
      });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT goal_input_id FROM joi_goal_execution_gates",
      ).get())).toEqual({ goal_input_id: goal.inputId });
    } finally {
      await fixture.close();
    }
  });
});
