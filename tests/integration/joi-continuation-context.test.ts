/* Test doubles resolve synchronously through Promise contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import type { StartReasoningTurnInput } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import path from "node:path";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture.js";

const ROOT_CAUSE = `${"排查证据。".repeat(150)}根因：本地 Claude 不支持 session-mirror；推荐只向 mana 注入 sessionStore。`;
const OUTCOME = `${"已核验的事实。".repeat(100)}结论：按最小方案 A 修复，并验证原生 session 恢复。`;

async function seed(fixture: RuntimeFixture) {
  const workbench = await fixture.workbenchRegistry.create({ name: "调试", personaSummary: "persona", projectLabel: "repo", scopeSummary: "修复" });
  const partner = await fixture.partners.add({ capabilities: [], displayName: "根因搭档", kind: "local-pi", skills: [], tools: [] });
  const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
  const goal = await inbox.accept({ idempotencyKey: "original", text: "读取飞书并分析 bug，只给方案", workbenchId: workbench.workbenchId });
  const now = fixture.clock.now().toISOString();
  fixture.database.transaction((db) => {
    db.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(goal.inputId);
    db.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
      VALUES ('turn-original', ?, ?, 'session-original', 'COMPLETED', ?, ?)`).run(goal.inputId, workbench.workbenchId, now, now);
    db.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
      VALUES ('plan-original', 'turn-original', '{}', '[]', ?)`).run(now);
    db.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
      VALUES ('root-cause', ?, ?, '根因诊断', '{}', 'READ', 'COMPLETED', ?, ?)`).run(workbench.workbenchId, goal.inputId, now, now);
    db.prepare(`INSERT INTO dispatch_attempts (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
      VALUES ('attempt-original', 'plan-original', 'root-cause', ?, 1, 'action-original', 'COMPLETED', ?, ?)`).run(partner.partnerRevisionId, now, now);
    db.prepare(`INSERT INTO partner_runs (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
      VALUES ('run-original', 'attempt-original', 'action-original', ?, 'root-cause', ?, 'LOCAL_PI', 'local:original', 'COMPLETED', ?, ?)`)
      .run(workbench.workbenchId, partner.partnerRevisionId, now, now);
    db.prepare("INSERT INTO work_result_bodies (body_ref, body, created_at) VALUES ('body-original', ?, ?)").run(ROOT_CAUSE, now);
    db.prepare(`INSERT INTO work_results (result_id, run_id, action_id, workbench_id, work_id, partner_revision_id, status, summary, body_ref, artifacts_json, is_late, is_authoritative, created_at)
      VALUES ('result-original', 'run-original', 'action-original', ?, 'root-cause', ?, 'COMPLETED', '诊断已完成', 'body-original', '[]', 0, 1, ?)`)
      .run(workbench.workbenchId, partner.partnerRevisionId, now);
    db.prepare("INSERT INTO work_result_verifications (result_id, status, created_at) VALUES ('result-original', 'PASSED', ?)").run(now);
    db.prepare("INSERT INTO joi_goal_result_sets (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 1, 1, ?)").run(goal.inputId, now);
    db.prepare(`INSERT INTO joi_goal_outcomes (input_id, result_revision, disposition, completion_summary, completed_at, updated_at)
      VALUES (?, 1, 'COMPLETED', ?, ?, ?)`).run(goal.inputId, OUTCOME, now, now);
    db.prepare(`INSERT INTO joi_harness_maps (goal_input_id, workbench_id, destination, status, created_at, updated_at)
      VALUES (?, ?, '修复启动退出问题', 'CLEARED', ?, ?)`).run(goal.inputId, workbench.workbenchId, now, now);
    db.prepare(`INSERT INTO joi_harness_decisions (decision_id, goal_input_id, kind, summary, detail, created_at)
      VALUES ('decision-original', ?, 'APPROACH', '最小方案 A', '保留原生 session 恢复', ?)`).run(goal.inputId, now);
  });
  return { goal, inbox, repository, workbench };
}

async function promptFor(fixture: RuntimeFixture, inputId: string, repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock), capturedTurns?: StartReasoningTurnInput[]) {
  const prompts: string[] = [];
  await new JoiCoordinator({
    clock: fixture.clock, ids: fixture.ids, workbenches: fixture.workbenches,
    router: { decide: async () => { throw new Error("pre-bound input"); } },
    sources: { selectInitial: async (turnId) => ({ modelId: "fake", modelRevisionId: "fake-r", sourceId: "fake", sourceRevisionId: "fake-r", turnId }) },
    store: {
      loadInput: (id) => repository.loadInput(id), createTurn: async () => undefined,
      completeInput: async () => undefined, requireClarification: async () => undefined,
    },
    runtime: {
      abort: () => undefined, followUp: () => undefined, steer: () => undefined, isRunning: () => false,
      restore: async () => false, rollbackTurn: async () => false, waitForIdle: async () => undefined,
      startTurn: async (turn) => {
        capturedTurns?.push(turn);
        prompts.push([turn.backgroundContext, turn.prompt].filter(Boolean).join("\n\n"));
        turn.onEvent?.({ type: "text_delta", delta: "已有结论已读取", turnId: turn.turnId });
      },
    },
  }).handle(inputId);
  return prompts[0] ?? "";
}

describe("Joi continuation context", () => {
  it("restores the current continuation and its conclusions from a reopened disposable database", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, inbox } = await seed(fixture);
      await inbox.retry({ inputId: goal.inputId, text: "认可判断，直接完成修复" });
      const database = await openRuntimeDatabase({ databasePath: path.join(fixture.root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
      try {
        const prompt = await promptFor(fixture, goal.inputId, new SqliteJoiInboxRepository(database, fixture.clock));
        expect(prompt).toContain(ROOT_CAUSE);
        expect(prompt).toContain(OUTCOME);
        expect(prompt).toMatch(/Current continuation request:\n认可判断，直接完成修复$/u);
      } finally { database.close(); }
    } finally { await fixture.close(); }
  });

  it("retains a root cause at the end of a long report and uses only the latest follow-up as the prompt", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, inbox, repository } = await seed(fixture);
      fixture.database.transaction((db) => db.prepare("UPDATE work_result_bodies SET body = ?")
        .run(`${"调查证据".repeat(10_000)} LONG_REPORT_ROOT_CAUSE_END`));
      await inbox.retry({ inputId: goal.inputId, text: "第一轮补充" });
      fixture.database.transaction((db) => db.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(goal.inputId));
      await inbox.retry({ inputId: goal.inputId, text: "按结论执行修复" });
      expect((await repository.loadInput(goal.inputId))?.continuationPrompt).toBe("按结论执行修复");
      const turns: StartReasoningTurnInput[] = [];
      const prompt = await promptFor(fixture, goal.inputId, undefined, turns);
      expect(prompt).toContain("LONG_REPORT_ROOT_CAUSE_END");
      expect(turns[0]?.backgroundContextVariants).toHaveLength(2);
      expect(turns[0]?.backgroundContextVariants?.at(-1)?.length).toBeGreaterThan(turns[0]?.backgroundContext?.length ?? 0);
      expect(turns[0]?.backgroundContextVariants?.every((variant) => variant.length <= 60_000)).toBe(true);
      expect(prompt).toContain("result-original");
      expect(prompt).toContain("第一轮补充");
      expect(prompt).toMatch(/Current continuation request:\n按结论执行修复$/u);
      expect(prompt.length).toBeLessThan(25_000);
    } finally { await fixture.close(); }
  });

  it("hydrates full evidence for an internal review rather than relying on its short summary", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, workbench } = await seed(fixture);
      const now = fixture.clock.now().toISOString();
      const reviewId = `joi_harness_review:goal:${goal.inputId}:r1`;
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
        VALUES (?, ?, 'Harness review: Latest completion: 诊断已完成', 'PENDING', ?, ?, ?, ?)`)
        .run(reviewId, reviewId, workbench.workbenchId, goal.inputId, now, now));
      const prompt = await promptFor(fixture, reviewId);
      expect(prompt).toContain(ROOT_CAUSE);
      expect(prompt).toContain(OUTCOME);
      expect(prompt).toContain("Harness review");
    } finally { await fixture.close(); }
  });

  it.each(["认可判断，直接完成修复", undefined])("hydrates stored conclusions before planning a continued goal (%s)", async (text) => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, inbox, repository } = await seed(fixture);
      fixture.clock.advance(60_000);
      await inbox.retry({ inputId: goal.inputId, ...(text === undefined ? {} : { text }) });
      const prompt = await promptFor(fixture, goal.inputId);
      expect(prompt).toContain(ROOT_CAUSE);
      expect(prompt).toContain(OUTCOME);
      expect(prompt).toContain("最小方案 A");
      expect(prompt).toContain("Current continuation request:");
      expect(prompt).toContain(text ?? "Continue from the established results");
      expect(prompt).toContain("do not repeat completed investigation");
      expect((await repository.readDisplayText(goal.inputId))).not.toContain(ROOT_CAUSE);
      expect(JSON.stringify(await repository.list())).not.toContain(ROOT_CAUSE);
    } finally { await fixture.close(); }
  });

  it("retains finished evidence when the user answers a blocking question", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, inbox, repository } = await seed(fixture);
      await repository.requireClarification(goal.inputId, "question_required", "是否执行方案 A？");
      const question = (await repository.list()).find((item) => item.inputId === goal.inputId);
      if (question?.questionId === undefined || question.questionVersion === undefined) throw new Error("missing question");
      await inbox.clarify({ inputId: goal.inputId, questionId: question.questionId, questionVersion: question.questionVersion, text: "认可判断，直接完成修复" });
      const row = fixture.database.transaction((db) => db.prepare("SELECT resume_input_id FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(goal.inputId));
      const prompt = await promptFor(fixture, String(row?.resume_input_id));
      expect(prompt).toContain(ROOT_CAUSE);
      expect(prompt).toContain(OUTCOME);
      expect(prompt).toContain("answer=认可判断，直接完成修复");
      expect(prompt).toContain("goal_resume");
      expect(fixture.database.transaction((db) => db.prepare("SELECT status FROM joi_goal_execution_gates WHERE goal_input_id = ?").get(goal.inputId)))
        .toEqual({ status: "REVIEWING" });
    } finally { await fixture.close(); }
  });

  it.each(["FAILED_VERIFICATION", "LATE", "NON_AUTHORITATIVE", "OTHER_GOAL", "OTHER_WORKBENCH", "SUPERSEDED", "CANCELED"])("excludes %s evidence", async (variant) => {
    const fixture = await createRuntimeFixture();
    try {
      const { goal, inbox, workbench } = await seed(fixture);
      const other = await inbox.accept({ idempotencyKey: "other", text: "另一目标", workbenchId: workbench.workbenchId });
      const otherWorkbench = await fixture.workbenchRegistry.create({ name: "另一工作台", personaSummary: "persona", projectLabel: "other", scopeSummary: "other" });
      fixture.database.transaction((db) => {
        db.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          SELECT 'turn-other', ?, workbench_id, 'session-other', status, created_at, updated_at FROM joi_turns WHERE turn_id = 'turn-original'`).run(other.inputId);
        if (variant === "FAILED_VERIFICATION") db.prepare("UPDATE work_result_verifications SET status = 'FAILED'").run();
        if (variant === "LATE") db.prepare("UPDATE work_results SET is_late = 1").run();
        if (variant === "NON_AUTHORITATIVE") db.prepare("UPDATE work_results SET is_authoritative = 0").run();
        if (variant === "OTHER_GOAL") db.prepare("UPDATE work_items SET input_id = ?").run(other.inputId);
        if (variant === "OTHER_WORKBENCH") db.prepare("UPDATE work_results SET workbench_id = ?").run(otherWorkbench.workbenchId);
        if (variant === "CANCELED") db.prepare("UPDATE work_items SET status = 'CANCELED'").run();
        if (variant === "SUPERSEDED") db.prepare(`INSERT INTO dispatch_attempts (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
          SELECT 'attempt-new', dispatch_plan_id, work_id, partner_revision_id, registry_revision, 'action-new', 'COMPLETED', created_at, updated_at FROM dispatch_attempts`).run();
      });
      await inbox.retry({ inputId: goal.inputId, text: "继续修复" });
      expect(await promptFor(fixture, goal.inputId)).not.toContain(ROOT_CAUSE);
      const fresh = await inbox.accept({ idempotencyKey: "fresh", text: "读取飞书并分析 bug，只给方案", workbenchId: workbench.workbenchId });
      const prompt = await promptFor(fixture, fresh.inputId);
      expect(prompt).toBe("读取飞书并分析 bug，只给方案");
      expect(prompt).not.toContain(OUTCOME);
    } finally { await fixture.close(); }
  });
});
