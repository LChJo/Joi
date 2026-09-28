import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqliteJoiTaskReader } from "../../src/main/infrastructure/persistence/sqlite-joi-task-reader.js";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture.js";

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
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)?.status).toBe("CONSUMED");
      await expect(repository.resumeGoal({
        inputId: resume.input_id,
        turnId: "resume-turn",
      })).resolves.toEqual({ status: "OPEN" });
      await repository.completeInput(resume.input_id, "resume-turn");
      // An older build left the original input ROUTED even after a successful recovery.
      fixture.database.transaction((db) => db.prepare("UPDATE joi_inbox_messages SET status = 'ROUTED' WHERE input_id = ?").run(goal.inputId));
      await repository.recoverInterruptedGoalReviews();
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)?.status).toBe("CONSUMED");
      // Crash window: goal_resume committed (gate OPEN) but the recovery turn was later
      // failed by the orphan sweep. The OPEN gate is authoritative; the goal must still
      // settle instead of stranding as ROUTED forever.
      fixture.database.transaction((db) => {
        db.prepare("UPDATE joi_inbox_messages SET status = 'ROUTED' WHERE input_id = ?").run(goal.inputId);
        db.prepare("UPDATE joi_turns SET status = 'FAILED' WHERE input_id = ?").run(resume.input_id);
      });
      await repository.recoverInterruptedGoalReviews();
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)?.status).toBe("CONSUMED");
    } finally {
      await fixture.close();
    }
  });

  it.each(["side-effect", "parked", "historical"])("exposes an interrupted %s recovery and preserves saved answers for retry", async (failure) => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "复核", personaSummary: "persona", projectLabel: "joi", scopeSummary: "复核" });
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "interrupted-review", text: "准备发布", workbenchId: workbench.workbenchId });
      await repository.requireClarification(goal.inputId, "question_required", "哪些平台？");
      const questionId = `goal_question:${goal.inputId}:v1`;
      await inbox.clarify({ inputId: goal.inputId, questionId, questionVersion: 1, text: "Windows 和 macOS" });
      const resumeId = `joi_goal_resume:goal:${goal.inputId}:v1`;
      await repository.createTurn({ workbenchId: workbench.workbenchId, createdAt: fixture.clock.now().toISOString(), inputId: resumeId, sessionId: "session", turnId: "resume-turn" });
      if (failure === "historical") {
        fixture.database.transaction((db) => {
          db.prepare("UPDATE joi_turns SET status = 'FAILED' WHERE turn_id = 'resume-turn'").run();
          db.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(resumeId);
        });
      } else {
        if (failure === "side-effect") await repository.recordTurnProgress("resume-turn", { formalOutputStarted: false, sideEffectStarted: true });
        await repository.failTurn(resumeId, "resume-turn");
        if (failure === "parked") await repository.park(resumeId, { failureCount: 8, reasonCode: "goal_resume_required" });
      }
      const reader = new SqliteJoiTaskReader({ database: fixture.database,
        failTurn: (inputId, turnId) => repository.failTurn(inputId, turnId),
        park: async (inputId, reason) => { await repository.park(inputId, reason); },
        recoverInterruptedGoalReviews: () => repository.recoverInterruptedGoalReviews(),
      });
      await reader.recoverInterruptedGoalReviews();
      await reader.recoverInterruptedGoalReviews();
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)).toMatchObject({
        status: "CLARIFICATION_REQUIRED", clarificationReasonCode: "goal_review_interrupted", questionVersion: 2,
      });
      await expect(inbox.clarify({ inputId: goal.inputId, questionId, questionVersion: 1, text: "旧回答" })).rejects.toMatchObject({ code: "joi_clarification_unavailable" });
      await inbox.clarify({ inputId: goal.inputId, questionId: `goal_question:${goal.inputId}:v2`, questionVersion: 2, text: "沿用已保存的回答，重试评审。" });
      const retryId = `joi_goal_resume:goal:${goal.inputId}:v2`;
      expect((await repository.loadInput(retryId))?.body).toContain("Windows 和 macOS");
      expect((await reader.listPendingInputs()).map((item) => item.inputId)).toEqual([retryId]);
      await expect(repository.resumeGoal({ inputId: resumeId, turnId: "resume-turn" })).rejects.toMatchObject({ code: "goal_resume_not_allowed" });
    } finally { await fixture.close(); }
  });

  it.each(["pending", "running", "canceled", "dismissed", "failed", "open", "new-question", "consumed-goal", "live-work"])("leaves %s goals alone during interrupted-review recovery", async (state) => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const goal = await inbox.accept({ idempotencyKey: "guard-review", text: "研究" });
      const workbench = await fixture.workbenchRegistry.create({ name: "核对", personaSummary: "persona", projectLabel: "joi", scopeSummary: "核对" });
      await repository.requireClarification(goal.inputId, "question_required", "范围？");
      await inbox.clarify({ inputId: goal.inputId, questionId: `goal_question:${goal.inputId}:v1`, questionVersion: 1, text: "全球" });
      const resumeId = `joi_goal_resume:goal:${goal.inputId}:v1`;
      fixture.database.transaction((db) => {
        if (state !== "pending") db.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(resumeId);
        if (state === "running") db.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('live-review', ?, ?, 'session', 'RUNNING', ?, ?)`).run(resumeId, workbench.workbenchId, fixture.clock.now().toISOString(), fixture.clock.now().toISOString());
        if (state === "canceled") db.prepare("UPDATE joi_inbox_messages SET canceled_at = ? WHERE input_id = ?").run(fixture.clock.now().toISOString(), goal.inputId);
        if (state === "dismissed") db.prepare("UPDATE joi_inbox_messages SET dismissed_at = ? WHERE input_id = ?").run(fixture.clock.now().toISOString(), goal.inputId);
        if (state === "failed") db.prepare("UPDATE joi_inbox_messages SET failed_at = ? WHERE input_id = ?").run(fixture.clock.now().toISOString(), goal.inputId);
        if (state === "open") db.prepare("UPDATE joi_goal_execution_gates SET status = 'OPEN' WHERE goal_input_id = ?").run(goal.inputId);
        // A terminal goal must never be resurrected into a question card by the unattended scan.
        if (state === "consumed-goal") db.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(goal.inputId);
        // Live goal-bound Work defers the retry card: the recovery turn would otherwise
        // orchestrate concurrently with it. The goal turn satisfies the work_items
        // goal-binding trigger (migration 034).
        if (state === "live-work") {
          db.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
            VALUES ('goal-turn', ?, ?, 'session', 'COMPLETED', ?, ?)`)
            .run(goal.inputId, workbench.workbenchId, fixture.clock.now().toISOString(), fixture.clock.now().toISOString());
          db.prepare(`INSERT INTO work_items
            (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
            VALUES ('live-work-guard', ?, ?, '进行中', '{}', 'READ', 'RUNNING', ?, ?)`)
            .run(workbench.workbenchId, goal.inputId, fixture.clock.now().toISOString(), fixture.clock.now().toISOString());
        }
      });
      if (state === "new-question") await repository.requireClarification(resumeId, "question_required", "时间范围？");
      const before = await inbox.list();
      await repository.recoverInterruptedGoalReviews();
      expect(await inbox.list()).toEqual(before);
    } finally { await fixture.close(); }
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

  /**
   * An interrupted recovery with one Work still under the goal. Whether that Work holds the retry
   * card back depends on its run's heartbeat: a live partner beats, a dead one does not, and the
   * status alone cannot tell them apart.
   */
  async function seedInterruptedRecovery(
    fixture: RuntimeFixture,
    options: { heartbeatAt?: string | null; workStatus?: string },
  ) {
    const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
    const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
    const workbench = await fixture.workbenchRegistry.create({ name: "兜底", personaSummary: "persona", projectLabel: "joi", scopeSummary: "兜底" });
    const partner = await fixture.partners.add({ capabilities: [], displayName: "执行搭档", kind: "local-pi", skills: [], tools: [] });
    const goal = await inbox.accept({ idempotencyKey: "heartbeat-goal", text: "继续收尾", workbenchId: workbench.workbenchId });
    await repository.requireClarification(goal.inputId, "question_required", "范围？");
    await inbox.clarify({ inputId: goal.inputId, questionId: `goal_question:${goal.inputId}:v1`, questionVersion: 1, text: "全部" });
    const resumeId = `joi_goal_resume:goal:${goal.inputId}:v1`;
    const now = fixture.clock.now().toISOString();
    fixture.database.transaction((connection) => {
      // The recovery Turn is over and left the gate REVIEWING; only the Work is still open.
      connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(resumeId);
      connection.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES ('goal-turn', ?, ?, 'session', 'COMPLETED', ?, ?)`).run(goal.inputId, workbench.workbenchId, now, now);
      connection.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('live-work', ?, ?, '进行中', '{}', 'READ', ?, ?, ?)`)
        .run(workbench.workbenchId, goal.inputId, options.workStatus ?? "RUNNING", now, now);
      connection.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
        VALUES ('plan-live', 'goal-turn', '{}', '[]', ?)`).run(now);
      connection.prepare(`INSERT INTO dispatch_attempts
        (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
        VALUES ('attempt-live', 'plan-live', 'live-work', ?, 1, 'action-live', 'RUNNING', ?, ?)`)
        .run(partner.partnerRevisionId, now, now);
      connection.prepare(`INSERT INTO partner_runs
        (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at, heartbeat_at)
        VALUES ('run-live', 'attempt-live', 'action-live', ?, 'live-work', ?, 'LOCAL_PI', 'local_pi:live', 'RUNNING', ?, ?, ?)`)
        .run(workbench.workbenchId, partner.partnerRevisionId, now, now, options.heartbeatAt ?? null);
    });
    return { goal, inbox, repository };
  }

  it("holds the retry card while the Work under the goal is still beating", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, inbox, repository } = await seedInterruptedRecovery(fixture, {
        heartbeatAt: fixture.clock.now().toISOString(),
      });
      await repository.recoverInterruptedGoalReviews();
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)).toMatchObject({ status: "ROUTED" });
    } finally {
      await fixture.close();
    }
  });

  it("does not treat an old attempt's stale heartbeat as the current run dying", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, inbox, repository } = await seedInterruptedRecovery(fixture, {
        heartbeatAt: fixture.clock.now().toISOString(),
      });
      const old = new Date(fixture.clock.now().getTime() - 30 * 60_000).toISOString();
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
          SELECT 'attempt-old', dispatch_plan_id, work_id, partner_revision_id, registry_revision,
                 'action-old', 'FAILED', ?, ? FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt-live'`)
          .run(old, old);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id,
           kind, external_run_id, status, created_at, updated_at, heartbeat_at)
          SELECT 'run-old', 'attempt-old', 'action-old', workbench_id, work_id, partner_revision_id,
                 kind, 'local_pi:old', 'FAILED', ?, ?, ? FROM partner_runs WHERE run_id = 'run-live'`)
          .run(old, old, old);
      });
      await repository.recoverInterruptedGoalReviews();
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId))
        .toMatchObject({ status: "ROUTED" });
    } finally {
      await fixture.close();
    }
  });

  it("offers the retry card once that Work's heartbeat goes quiet", async () => {
    const fixture = await createRuntimeFixture();
    try {
      // A half hour without a beat is far past the window; the owner that would have written one
      // is gone, and waiting on a status only that owner can change is waiting forever.
      const { goal, inbox, repository } = await seedInterruptedRecovery(fixture, {
        heartbeatAt: new Date(fixture.clock.now().getTime() - 30 * 60_000).toISOString(),
      });
      await repository.recoverInterruptedGoalReviews();
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)).toMatchObject({
        clarificationReasonCode: "goal_review_interrupted",
        status: "CLARIFICATION_REQUIRED",
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps the old conservative rule for runs written before heartbeats existed", async () => {
    const fixture = await createRuntimeFixture();
    try {
      // No heartbeat at all is not the same as an expired one: treating NULL as expired would
      // declare every historical run dead the first time this scan runs after an upgrade.
      const { goal, inbox, repository } = await seedInterruptedRecovery(fixture, { heartbeatAt: null });
      await repository.recoverInterruptedGoalReviews();
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)).toMatchObject({ status: "ROUTED" });
    } finally {
      await fixture.close();
    }
  });

  it("does not let a Work parked on the user hold the retry card back", async () => {
    const fixture = await createRuntimeFixture();
    try {
      // A WAITING Work is parked by design and its own question card is what surfaces it. Waiting
      // on it here would mean waiting on an answer that no amount of liveness can produce, which
      // is the same dead end as waiting on a dead process.
      const { goal, inbox, repository } = await seedInterruptedRecovery(fixture, {
        heartbeatAt: null,
        workStatus: "WAITING",
      });
      await repository.recoverInterruptedGoalReviews();
      expect((await inbox.list()).find((item) => item.inputId === goal.inputId)).toMatchObject({
        clarificationReasonCode: "goal_review_interrupted",
        status: "CLARIFICATION_REQUIRED",
      });
    } finally {
      await fixture.close();
    }
  });

  async function seedRecoveryDispatch(fixture: RuntimeFixture) {
    const workbench = await fixture.workbenchRegistry.create({ name: "恢复派发", personaSummary: "persona", projectLabel: "joi", scopeSummary: "恢复派发" });
    const partner = await fixture.partners.add({ capabilities: [], displayName: "执行搭档", kind: "local-pi", skills: [], tools: [] });
    const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
    const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
    const goal = await inbox.accept({ idempotencyKey: "recovery-dispatch", text: "继续收尾", workbenchId: workbench.workbenchId });
    const now = fixture.clock.now().toISOString();
    fixture.database.transaction((connection) => {
      // The goal Turn satisfies the work_items goal-binding trigger (migration 034).
      connection.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES ('goal-turn', ?, ?, 'session', 'COMPLETED', ?, ?)`).run(goal.inputId, workbench.workbenchId, now, now);
      connection.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('already-running', ?, ?, '写接口', '{}', 'READ', 'RUNNING', ?, ?)`).run(workbench.workbenchId, goal.inputId, now, now);
    });
    const workRepository = new SqliteWorkPlanRepository(fixture.database);
    const service = new WorkOrchestrationService({
      clock: fixture.clock,
      goalGate: workRepository,
      ids: fixture.ids,
      partners: fixture.partners,
      policy: { evaluate: () => Promise.resolve({ allowed: true }) },
      repository: workRepository,
    });
    // A plan is bound to the Turn that dispatched it, and a Turn's input has to exist, so each
    // request gets its own derived input row and Turn row.
    const planFor = (inputId: string) => {
      const turnId = `turn:${inputId}`;
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
          VALUES (?, ?, '继续', 'ROUTED', ?, ?, ?, ?)`)
          .run(inputId, `key:${inputId}`, workbench.workbenchId, inputId === goal.inputId ? null : goal.inputId, now, now);
        connection.prepare(`INSERT OR IGNORE INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'session', 'RUNNING', ?, ?)`).run(turnId, inputId, workbench.workbenchId, now, now);
      });
      return {
        dependencies: [],
        inputId,
        turnId,
        work: [{ acceptanceChecks: [{ kind: "BODY_PRESENT" as const }], accessMode: "READ" as const, key: "run", partnerId: partner.partnerId, title: "执行" }],
        workbenchId: workbench.workbenchId,
      };
    };
    return { goal, planFor, service };
  }

  it("requires goal_resume before recovery dispatch, then permits new Work beside live Work", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, planFor, service } = await seedRecoveryDispatch(fixture);
      const recoveryInput = `joi_goal_resume:goal:${goal.inputId}:v1`;
      const request = { ...planFor(recoveryInput), inputId: goal.inputId };
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_goal_execution_gates
        (goal_input_id, question_id, question_version, status, reason_code, created_at, updated_at)
        VALUES (?, ?, 1, 'REVIEWING', 'question_required', ?, ?)`).run(
        goal.inputId, `goal_question:${goal.inputId}:v1`, now, now,
      ));
      await expect(service.plan(request)).rejects.toMatchObject({ code: "goal_execution_paused" });
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_execution_gates SET status = 'OPEN' WHERE goal_input_id = ?").run(goal.inputId));
      await expect(service.plan(request))
        .resolves.toMatchObject({ dispatchPlanId: expect.any(String) as unknown as string });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status FROM work_items WHERE work_id = 'already-running'").get())).toEqual({ status: "RUNNING" });
    } finally {
      await fixture.close();
    }
  });

  it("does not block an ordinary Turn from adding Work beside a running one", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, planFor, service } = await seedRecoveryDispatch(fixture);
      // Adding work to a goal that already has some is ordinary; only re-entering a goal through
      // its recovery gate risks duplicating what the question was asked about.
      await expect(service.plan(planFor(goal.inputId))).resolves.toMatchObject({
        dispatchPlanId: expect.any(String) as unknown as string,
      });
    } finally {
      await fixture.close();
    }
  });
});
