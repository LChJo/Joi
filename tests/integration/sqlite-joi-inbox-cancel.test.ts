import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteWorkbenchAttentionReconciler } from "../../src/main/infrastructure/persistence/sqlite-workbench-attention-reconciler.js";
import { SqliteJoiTaskReader } from "../../src/main/infrastructure/persistence/sqlite-joi-task-reader.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture.js";

describe("sqlite joi inbox cancel", () => {
  it("parks scheduler failures without claiming that the user canceled them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-park-failure-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-failure", text: "执行一次任务" });

      const parked = await repository.park(accepted.inputId, { failureCount: 8, reasonCode: "unsafe_reasoning_tool" });
      if (parked === null) throw new Error("parked input missing");
      expect(parked).toMatchObject({
        failureCount: 8, failureReasonCode: "unsafe_reasoning_tool", status: "CONSUMED",
      });
      expect(typeof parked.failedAt).toBe("string");
      expect(parked.canceledAt).toBeUndefined();
      expect((await new SqliteJoiHomeFeedRepository(database).load(new Date())).goals[0]).toMatchObject({
        failure: {
          attempts: 8,
          executionStarted: false,
          reasonCode: "unsafe_reasoning_tool",
          suggestedAction: "RESTART_OR_UPDATE",
        },
        status: "FAILED",
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cancels a clarification input and refuses rows that already left the queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-cancel-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-1", text: "研究登录改造" });

      expect(await repository.cancel("does-not-exist")).toBeNull();
      const canceledRecord = await repository.cancel(accepted.inputId);
      expect(canceledRecord).toMatchObject({ inputId: accepted.inputId, status: "CONSUMED" });
      expect(typeof canceledRecord?.canceledAt).toBe("string");
      expect(await repository.cancel(accepted.inputId)).toBeNull();

      await repository.requireClarification(accepted.inputId, "workbench_selection_invalid");
      expect((await repository.loadInput(accepted.inputId))?.status).toBe("CONSUMED");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cancels a pending input and the service rejects a non-cancelable one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-cancel-pending-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-2", text: "归属？" });
      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });
      await expect(inbox.cancel({ inputId: accepted.inputId })).rejects.toMatchObject({ code: "joi_cancel_unavailable" });
      expect(await repository.clarify(accepted.inputId, { text: "too late" })).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cancels a stalled consumed goal whose map is active but nothing is in flight", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "验证", personaSummary: "persona", projectLabel: "技能", scopeSummary: "验证" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-stalled", text: "产出定稿报告", workbenchId: workbench.workbenchId });
      const seedStalled = (inputId: string, mapStatus: string) => fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'joi_session:stalled', 'COMPLETED', '2026-09-20T09:00:00.000Z', '2026-09-20T09:00:00.000Z')`)
          .run(`turn_stalled_${mapStatus.toLowerCase()}`, inputId, workbench.workbenchId);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(inputId);
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, continuation_allowance, created_at, updated_at)
          VALUES (?, ?, '产出定稿', ?, 2, '2026-09-20T09:00:00.000Z', '2026-09-20T09:00:00.000Z')`)
          .run(inputId, workbench.workbenchId, mapStatus);
      });
      seedStalled(accepted.inputId, "ACTIVE");

      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });
      const canceledRow = fixture.database.transaction((connection) => connection.prepare(
        "SELECT canceled_at FROM joi_inbox_messages WHERE input_id = ?").get(accepted.inputId)) as { canceled_at: string | null };
      expect(typeof canceledRow.canceled_at).toBe("string");
      // A revoked goal has no future review, so its map must close in the same transaction. Left
      // ACTIVE it would be unreachable by every clearing path (review and AUTO_CLEAR both need a
      // COMPLETED disposition, trivial clear needs zero Work) and the evolution evidence scan would
      // exclude the goal forever. feedback_recorded_at is stamped so it never becomes a
      // completion-feedback candidate.
      const revokedMap = fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, cleared_at, feedback_recorded_at FROM joi_harness_maps WHERE goal_input_id = ?")
        .get(accepted.inputId)) as { status: string; cleared_at: string | null; feedback_recorded_at: string | null };
      expect(revokedMap.status).toBe("CLEARED");
      expect(typeof revokedMap.cleared_at).toBe("string");
      expect(typeof revokedMap.feedback_recorded_at).toBe("string");

      // A cleared map with nothing in flight is already terminal: cancel keeps refusing.
      const settled = await inbox.accept({ idempotencyKey: "key-settled", text: "产出定稿报告二", workbenchId: workbench.workbenchId });
      seedStalled(settled.inputId, "CLEARED");
      await expect(inbox.cancel({ inputId: settled.inputId })).rejects.toMatchObject({ code: "joi_cancel_unavailable" });
      // A refused cancel must not touch the map either.
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, cleared_at FROM joi_harness_maps WHERE goal_input_id = ?").get(settled.inputId)))
        .toEqual({ status: "CLEARED", cleared_at: null });
    } finally {
      fixture.database.close();
    }
  });

  it("revives a consumed goal input when a partner question arrives and routes the answer back", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "验证", personaSummary: "persona", projectLabel: "技能", scopeSummary: "验证" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-question", text: "验证搜索技能" });
      // Consume the goal the way a finished turn would, without pulling in model-source FKs.
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_question', ?, ?, 'joi_session:test', 'COMPLETED', '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`).run(accepted.inputId, workbench.workbenchId);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(accepted.inputId);
      });
      expect((await repository.loadInput(accepted.inputId))?.status).toBe("CONSUMED");

      // The partner paused with a blocking question after the goal turn had completed.
      await repository.requireClarification(accepted.inputId, "question_required", "搭档『验证搭档』在执行工作『搜索验证』时暂停并提问：\nTavily API Key 是什么？");
      const raised = (await repository.list()).find((entry) => entry.inputId === accepted.inputId);
      expect(raised).toMatchObject({ clarificationReasonCode: "question_required", status: "CLARIFICATION_REQUIRED" });
      if (raised?.questionId === undefined || raised.questionVersion === undefined) throw new Error("question metadata missing");

      // The user's answer appends to the original request and enters review before execution resumes.
      const answered = await repository.clarify(accepted.inputId, {
        expectedQuestionId: raised.questionId,
        expectedQuestionVersion: raised.questionVersion,
        text: "key 在 ~/.openclaw/.env",
      });
      expect(answered).toMatchObject({ status: "ROUTED" });
      expect(answered?.body).toContain("[用户补充] key 在 ~/.openclaw/.env");

      // A stale orphan-turn sweep must never swallow the card while the user is thinking.
      await repository.requireClarification(accepted.inputId, "question_required", "第二个问题？");
      await repository.failTurn(accepted.inputId, "turn_stale");
      expect((await repository.loadInput(accepted.inputId))?.status).toBe("CLARIFICATION_REQUIRED");
    } finally {
      await fixture.close();
    }
  });

  it("cascades goal cancellation onto not-yet-final work so waiting work cannot block synthesis", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "级联", personaSummary: "persona", projectLabel: "任务", scopeSummary: "取消" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-cascade", text: "两个任务" });
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_cascade', ?, ?, 'joi_session:test', 'COMPLETED', '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`).run(accepted.inputId, workbench.workbenchId);
        const insertWork = connection.prepare(`
          INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', ?, '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')`);
        insertWork.run("work_waiting", workbench.workbenchId, accepted.inputId, "等待回答", "WAITING");
        insertWork.run("work_done", workbench.workbenchId, accepted.inputId, "已完成", "COMPLETED");
      });

      const canceled = await repository.cancel(accepted.inputId);
      expect(canceled).toMatchObject({ status: "CONSUMED" });
      const statuses = fixture.database.transaction((connection) => connection.prepare(
        "SELECT work_id, status FROM work_items ORDER BY work_id",
      ).all()) as { status: string; work_id: string }[];
      expect(statuses).toEqual([
        { status: "COMPLETED", work_id: "work_done" },
        { status: "CANCELED", work_id: "work_waiting" },
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("cancels a consumed zombie goal whose waiting work was never resumed, freeing the card for dismissal", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "僵尸", personaSummary: "persona", projectLabel: "任务", scopeSummary: "取消僵尸目标" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "分析搭档", kind: "local-pi", skills: [], tools: [] });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-zombie", text: "分析 Sandcastle 项目" });
      const now = "2026-08-21T03:50:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_zombie', ?, ?, 'joi_session:test', 'COMPLETED', ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED', workbench_id = ? WHERE input_id = ?").run(workbench.workbenchId, accepted.inputId);
        connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan_zombie', 'turn_zombie', '{}', '[]', ?)`).run(now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work_zombie', ?, ?, '分析项目', '{}', 'READ', 'WAITING', ?, ?)`).run(workbench.workbenchId, accepted.inputId, now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
          VALUES ('attempt_zombie', 'plan_zombie', 'work_zombie', ?, 1, 'action_zombie', 'WAITING_INPUT', ?, ?)`)
          .run(partner.partnerRevisionId, now, now);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES ('run_zombie', 'attempt_zombie', 'action_zombie', ?, 'work_zombie', ?, 'LOCAL_PI', 'local:zombie', 'WAITING_INPUT', ?, ?)`)
          .run(workbench.workbenchId, partner.partnerRevisionId, now, now);
        // The goal already carries a current outcome; the zombie work is what pins it.
        connection.prepare(`INSERT INTO joi_goal_result_sets
          (original_input_id, revision, synthesized_revision, updated_at) VALUES (?, 1, 1, ?)`).run(accepted.inputId, now);
        connection.prepare(`INSERT INTO joi_goal_outcomes
          (input_id, result_revision, completion_summary, completed_at, updated_at)
          VALUES (?, 1, '初步分析已汇总。', ?, ?)`).run(accepted.inputId, now, now);
      });

      await new SqliteWorkbenchAttentionReconciler(fixture.database).reconcile({
        prompt: "点击继续原工作。",
        reasonCode: "partner_waiting_recovery_required",
        workbenchId: workbench.workbenchId,
      });
      // A waiting goal must never claim to need the user without explaining the action.
      const feedBefore = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-21T04:00:00.000Z"));
      expect(feedBefore.goals[0]).toMatchObject({ goalId: accepted.inputId, status: "NEEDS_ATTENTION" });
      expect(feedBefore.goals[0]?.clarification?.reasonCode).toBe("partner_waiting_recovery_required");
      expect(typeof feedBefore.goals[0]?.clarification?.prompt).toBe("string");

      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });

      const states = fixture.database.transaction((connection) => ({
        attempt: connection.prepare("SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_zombie'").get(),
        run: connection.prepare("SELECT status FROM partner_runs WHERE run_id = 'run_zombie'").get(),
        work: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work_zombie'").get(),
      }));
      expect(states).toEqual({ attempt: { status: "FAILED" }, run: { status: "FAILED" }, work: { status: "CANCELED" } });

      // The card is now a dismissible canceled goal, not a stuck needs-you card.
      const feedAfter = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date("2026-08-21T04:05:00.000Z"));
      expect(feedAfter.goals[0]).toMatchObject({ canDelete: true, goalId: accepted.inputId, status: "CANCELED" });
      const dismissed = await inbox.dismiss({ inputId: accepted.inputId });
      expect(dismissed).toMatchObject({ inputId: accepted.inputId });

      // Clean goals without cancelable work still refuse cancellation.
      const cleanGoal = await inbox.accept({ idempotencyKey: "key-zombie-clean", text: "已完成的目标" });
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?",
      ).run(cleanGoal.inputId));
      await expect(inbox.cancel({ inputId: cleanGoal.inputId })).rejects.toMatchObject({ code: "joi_cancel_unavailable" });
    } finally {
      await fixture.close();
    }
  });

  it("cancels an arranged queue, closes its outbox and makes the card removable", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "排队取消", personaSummary: "persona", projectLabel: "任务", scopeSummary: "排队取消" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "排队搭档", kind: "local-pi", skills: [], tools: [] });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-arranged-cancel", text: "排队后卡住" });
      const now = "2026-08-21T04:10:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_arranged_cancel', ?, ?, 'joi_session:test', 'COMPLETED', ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED', workbench_id = ? WHERE input_id = ?").run(workbench.workbenchId, accepted.inputId);
        connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan_arranged_cancel', 'turn_arranged_cancel', '{}', '[]', ?)`).run(now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work_arranged_cancel', ?, ?, '排队任务', '{}', 'READ', 'READY', ?, ?)`).run(workbench.workbenchId, accepted.inputId, now, now);
        connection.prepare(`INSERT INTO outbox
          (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
          VALUES ('outbox_arranged_cancel', 'partner.dispatch', '{}', 'PENDING', 0, ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, outbox_id, status, created_at, updated_at)
          VALUES ('attempt_arranged_cancel', 'plan_arranged_cancel', 'work_arranged_cancel', ?, 1, 'action_arranged_cancel', 'outbox_arranged_cancel', 'PENDING', ?, ?)`).run(partner.partnerRevisionId, now, now);
      });

      const feedBefore = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(now));
      expect(feedBefore.goals[0]).toMatchObject({ goalId: accepted.inputId, status: "ARRANGED", canDelete: false });

      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });
      const states = fixture.database.transaction((connection) => ({
        attempt: connection.prepare("SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_arranged_cancel'").get(),
        outbox: connection.prepare("SELECT status FROM outbox WHERE outbox_id = 'outbox_arranged_cancel'").get(),
        work: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work_arranged_cancel'").get(),
      }));
      expect(states).toEqual({ attempt: { status: "FAILED" }, outbox: { status: "DONE" }, work: { status: "CANCELED" } });
      const feedAfter = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(now));
      expect(feedAfter.goals[0]).toMatchObject({ goalId: accepted.inputId, status: "CANCELED", canDelete: true });
    } finally {
      await fixture.close();
    }
  });

  it("cancels a routed goal whose work is queued, the state the home feed shows as arranged", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "路由取消", personaSummary: "persona", projectLabel: "任务", scopeSummary: "路由取消" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "路由搭档", kind: "local-pi", skills: [], tools: [] });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-routed-cancel", text: "已安排但还没跑起来" });
      const now = "2026-08-21T04:30:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_routed_cancel', ?, ?, 'joi_session:test', 'COMPLETED', ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'ROUTED', workbench_id = ? WHERE input_id = ?").run(workbench.workbenchId, accepted.inputId);
        connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan_routed_cancel', 'turn_routed_cancel', '{}', '[]', ?)`).run(now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work_routed_cancel', ?, ?, '排队任务', '{}', 'READ', 'READY', ?, ?)`).run(workbench.workbenchId, accepted.inputId, now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
          VALUES ('attempt_routed_cancel', 'plan_routed_cancel', 'work_routed_cancel', ?, 1, 'action_routed_cancel', 'PENDING', ?, ?)`).run(partner.partnerRevisionId, now, now);
      });

      const feedBefore = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(now));
      expect(feedBefore.goals[0]).toMatchObject({ goalId: accepted.inputId, status: "ARRANGED" });

      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });
      const states = fixture.database.transaction((connection) => ({
        attempt: connection.prepare("SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_routed_cancel'").get(),
        work: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work_routed_cancel'").get(),
      }));
      expect(states).toEqual({ attempt: { status: "FAILED" }, work: { status: "CANCELED" } });
      const feedAfter = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(now));
      expect(feedAfter.goals[0]).toMatchObject({ goalId: accepted.inputId, status: "CANCELED" });
    } finally {
      await fixture.close();
    }
  });

  it("hard-cancels an in-flight goal so the aborting actor converges a late, non-authoritative result", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "在途取消", personaSummary: "persona", projectLabel: "任务", scopeSummary: "在途取消" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "在途搭档", kind: "local-pi", skills: [], tools: [] });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-inflight-cancel", text: "正在执行的主任务" });
      const now = "2026-08-21T04:40:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_inflight_cancel', ?, ?, 'joi_session:test', 'COMPLETED', ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'ROUTED', workbench_id = ? WHERE input_id = ?").run(workbench.workbenchId, accepted.inputId);
        connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
          VALUES ('plan_inflight_cancel', 'turn_inflight_cancel', '{}', '[]', ?)`).run(now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work_inflight_cancel', ?, ?, '在途任务', '{}', 'READ', 'RUNNING', ?, ?)`).run(workbench.workbenchId, accepted.inputId, now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
          VALUES ('attempt_inflight_cancel', 'plan_inflight_cancel', 'work_inflight_cancel', ?, 1, 'action_inflight_cancel', 'RUNNING', ?, ?)`).run(partner.partnerRevisionId, now, now);
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES ('run_inflight_cancel', 'attempt_inflight_cancel', 'action_inflight_cancel', ?, 'work_inflight_cancel', ?, 'LOCAL_PI', 'local:inflight', 'RUNNING', ?, ?)`)
          .run(workbench.workbenchId, partner.partnerRevisionId, now, now);
      });

      const feedBefore = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(now));
      expect(feedBefore.goals[0]).toMatchObject({ goalId: accepted.inputId, status: "RUNNING" });

      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });
      // Terminal rows up front: the dispatch actor's abort converges through complete(),
      // which no-ops on the FAILED attempt, and any recorded result lands as late.
      const states = fixture.database.transaction((connection) => ({
        attempt: connection.prepare("SELECT status FROM dispatch_attempts WHERE dispatch_attempt_id = 'attempt_inflight_cancel'").get(),
        run: connection.prepare("SELECT status FROM partner_runs WHERE run_id = 'run_inflight_cancel'").get(),
        work: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work_inflight_cancel'").get(),
      }));
      expect(states).toEqual({ attempt: { status: "FAILED" }, run: { status: "FAILED" }, work: { status: "CANCELED" } });
      const feedAfter = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(now));
      expect(feedAfter.goals[0]).toMatchObject({ goalId: accepted.inputId, status: "CANCELED" });
    } finally {
      await fixture.close();
    }
  });

  it("cancels a consumed goal whose summary turn is still looping and terminates its pending child inputs", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "总结", personaSummary: "persona", projectLabel: "任务", scopeSummary: "取消总结中" });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-summary-cancel", text: "正在汇总的目标" });
      const now = "2026-08-21T05:00:00.000Z";
      const reviewInputId = `joi_harness_review:goal:${accepted.inputId}:r1`;
      fixture.database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
          VALUES (?, 'summary-review:1', '汇总评审', 'PENDING', ?, ?, ?, ?)`).run(reviewInputId, workbench.workbenchId, accepted.inputId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_summary_done', ?, ?, 'joi_session:test', 'COMPLETED', ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn_summary_live', ?, ?, 'joi_session:test', 'RUNNING', ?, ?)`)
          .run(reviewInputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED', workbench_id = ? WHERE input_id = ?").run(workbench.workbenchId, accepted.inputId);
        connection.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id, workbench_id, destination, status, continuation_allowance, created_at, updated_at)
          VALUES (?, ?, '汇总', 'ACTIVE', 2, ?, ?)`).run(accepted.inputId, workbench.workbenchId, now, now);
        const insertWork = connection.prepare(`
          INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, '{}', 'READ', 'COMPLETED', ?, ?)`);
        insertWork.run("work_summary_done_1", workbench.workbenchId, accepted.inputId, "已完成一", now, now);
        insertWork.run("work_summary_done_2", workbench.workbenchId, accepted.inputId, "已完成二", now, now);
      });

      // Terminal work plus a looping summary turn is the card the home feed shows as
      // "正在总结" (FINALIZING): cancel must go through instead of being refused.
      const feedBefore = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(now));
      expect(feedBefore.goals[0]).toMatchObject({ goalId: accepted.inputId, status: "FINALIZING" });

      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });
      const states = fixture.database.transaction((connection) => ({
        goal: connection.prepare("SELECT canceled_at FROM joi_inbox_messages WHERE input_id = ?").get(accepted.inputId) as { canceled_at: string | null },
        child: connection.prepare("SELECT status, canceled_at FROM joi_inbox_messages WHERE input_id = ?").get(reviewInputId) as { canceled_at: string | null; status: string },
      }));
      expect(typeof states.goal.canceled_at).toBe("string");
      expect(states.child).toMatchObject({ status: "CONSUMED" });
      expect(typeof states.child.canceled_at).toBe("string");

      // The scheduler must not pick the canceled goal's pending children back up, and
      // the live child turn must resolve its cancellation through the goal row.
      const reader = new SqliteJoiTaskReader({
        database: fixture.database,
        failTurn: () => Promise.resolve(undefined),
        park: () => Promise.resolve(undefined),
      });
      await expect(reader.listPendingInputs()).resolves.not.toContainEqual(expect.objectContaining({ inputId: reviewInputId }));
      await expect(reader.isCanceled(reviewInputId)).resolves.toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("emergency-stops every active Workbench goal, in-flight runs included", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "全局停止", personaSummary: "persona", projectLabel: "任务", scopeSummary: "全局停止" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "停止搭档", kind: "local-pi", skills: [], tools: [] });
      const repository = new SqliteJoiInboxRepository(fixture.database);
      const inbox = new JoiInboxService({ clock: fixture.clock, ids: fixture.ids, repository });
      const queued = await inbox.accept({ idempotencyKey: "key-global-queued", text: "应被紧急停止的排队任务" });
      const running = await inbox.accept({ idempotencyKey: "key-global-running", text: "正在运行的任务" });
      const now = "2026-08-21T04:20:00.000Z";
      fixture.database.transaction((connection) => {
        const insertTurn = connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'joi_session:test', 'COMPLETED', ?, ?)`);
        insertTurn.run("turn_global_queued", queued.inputId, workbench.workbenchId, now, now);
        insertTurn.run("turn_global_running", running.inputId, workbench.workbenchId, now, now);
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED', workbench_id = ? WHERE input_id IN (?, ?)").run(workbench.workbenchId, queued.inputId, running.inputId);
        const insertPlan = connection.prepare(`INSERT INTO dispatch_plans
          (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at) VALUES (?, ?, '{}', '[]', ?)`);
        insertPlan.run("plan_global_queued", "turn_global_queued", now);
        insertPlan.run("plan_global_running", "turn_global_running", now);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work_global_queued', ?, ?, '排队', '{}', 'READ', 'READY', ?, ?),
                 ('work_global_running', ?, ?, '运行', '{}', 'READ', 'RUNNING', ?, ?)`).run(
          workbench.workbenchId, queued.inputId, now, now, workbench.workbenchId, running.inputId, now, now,
        );
        connection.prepare(`INSERT INTO outbox
          (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
          VALUES ('outbox_global_queued', 'partner.dispatch', '{}', 'PENDING', 0, ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO dispatch_attempts
          (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, outbox_id, status, created_at, updated_at)
          VALUES ('attempt_global_queued', 'plan_global_queued', 'work_global_queued', ?, 1, 'action_global_queued', 'outbox_global_queued', 'PENDING', ?, ?),
                 ('attempt_global_running', 'plan_global_running', 'work_global_running', ?, 1, 'action_global_running', NULL, 'RUNNING', ?, ?)`).run(
          partner.partnerRevisionId, now, now, partner.partnerRevisionId, now, now,
        );
        connection.prepare(`INSERT INTO partner_runs
          (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind, external_run_id, status, created_at, updated_at)
          VALUES ('run_global_running', 'attempt_global_running', 'action_global_running', ?, 'work_global_running', ?, 'LOCAL_PI', 'local:global-running', 'RUNNING', ?, ?)`).run(
          workbench.workbenchId, partner.partnerRevisionId, now, now,
        );
      });

      await expect(inbox.emergencyStopQueued()).resolves.toBe(2);
      const states = fixture.database.transaction((connection) => ({
        queued: connection.prepare("SELECT canceled_at FROM joi_inbox_messages WHERE input_id = ?").get(queued.inputId),
        queuedWork: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work_global_queued'").get(),
        running: connection.prepare("SELECT canceled_at FROM joi_inbox_messages WHERE input_id = ?").get(running.inputId),
        runningRun: connection.prepare("SELECT status FROM partner_runs WHERE run_id = 'run_global_running'").get(),
        runningWork: connection.prepare("SELECT status FROM work_items WHERE work_id = 'work_global_running'").get(),
      }));
      expect(states.queued?.canceled_at).toEqual(expect.any(String));
      expect(states.queuedWork).toEqual({ status: "CANCELED" });
      expect(states.running?.canceled_at).toEqual(expect.any(String));
      expect(states.runningRun).toEqual({ status: "FAILED" });
      expect(states.runningWork).toEqual({ status: "CANCELED" });
    } finally {
      await fixture.close();
    }
  });
});
