import { DomainError } from "../../src/main/domain/errors";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

const NOW = "2026-08-06T10:00:00.000Z";

interface GoalSeedOptions {
  workbenchId?: string;
  goalInputId: string;
  status?: string;
  turn?: boolean;
}

function seedGoal(fixture: RuntimeFixture, options: GoalSeedOptions): { workbenchId: string } {
  const workbenchId = options.workbenchId ?? `workbench-${options.goalInputId}`;
  fixture.database.transaction((connection) => {
    connection.prepare(`INSERT OR IGNORE INTO workbenches
      (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
       memory_namespace_id, status, created_at, updated_at)
      VALUES (?, 'A', ?, 'summary', 'scope', 'project', ?, 'ACTIVE', ?, ?)`)
      .run(workbenchId, `persona-${workbenchId}`, `memory-${workbenchId}`, NOW, NOW);
    connection.prepare(`INSERT INTO joi_inbox_messages
      (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
      VALUES (?, ?, 'goal body', ?, ?, ?, ?)`)
      .run(options.goalInputId, `key-${options.goalInputId}`, options.status ?? "ROUTED", workbenchId, NOW, NOW);
    if (options.turn === true) {
      connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?)`)
        .run(`turn-${options.goalInputId}`, options.goalInputId, workbenchId, `session-${options.goalInputId}`, NOW, NOW);
    }
  });
  return { workbenchId };
}

function seedCompletedLayer(
  fixture: RuntimeFixture,
  goalInputId: string,
  revision: number,
  disposition: "BLOCKED" | "COMPLETED" | "CONTINUE" | "ACCEPTED_WITH_GAPS" = "COMPLETED",
): void {
  fixture.database.transaction((connection) => {
    connection.prepare(`INSERT INTO joi_goal_result_sets
      (original_input_id, revision, synthesized_revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(original_input_id) DO UPDATE SET revision = excluded.revision,
        synthesized_revision = excluded.synthesized_revision, updated_at = excluded.updated_at`)
      .run(goalInputId, revision, revision, NOW);
    connection.prepare(`INSERT INTO joi_goal_outcomes
      (input_id, result_revision, completion_summary, completed_at, updated_at, disposition)
      VALUES (?, ?, '一层完成', ?, ?, ?)
      ON CONFLICT(input_id) DO UPDATE SET result_revision = excluded.result_revision,
        completion_summary = excluded.completion_summary, updated_at = excluded.updated_at,
        disposition = excluded.disposition`)
      .run(goalInputId, revision, NOW, NOW, disposition);
  });
}

function forceMapCleared(fixture: RuntimeFixture, goalInputId: string): void {
  fixture.database.transaction((connection) => connection.prepare(`UPDATE joi_harness_maps
    SET status = 'CLEARED', cleared_at = ?, updated_at = ? WHERE goal_input_id = ?`)
    .run(NOW, NOW, goalInputId));
}

/**
 * A Work turns terminal a few milliseconds before `enqueuePartnerResult` puts its result into the
 * goal's result set. `absorbed: false` models the gap: the authoritative result and its event exist,
 * but the member row that would make the close-out see them has not been written yet.
 */
function seedCompletedWorkWithResult(fixture: RuntimeFixture, options: {
  absorbed: boolean;
  goalInputId: string;
  partnerRevisionId: string;
  workId: string;
}): void {
  const workbenchId = `workbench-${options.goalInputId}`;
  fixture.database.transaction((connection) => {
    connection.prepare(`INSERT INTO dispatch_plans
      (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
      VALUES (?, ?, '{}', '[]', ?)`).run(`plan-${options.workId}`, `turn-${options.goalInputId}`, NOW);
    connection.prepare(`INSERT INTO work_items
      (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
      VALUES (?, ?, ?, '关键分析', '{}', 'READ', 'COMPLETED', ?, ?)`)
      .run(options.workId, workbenchId, options.goalInputId, NOW, NOW);
    connection.prepare(`INSERT INTO dispatch_attempts
      (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision,
       action_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, 'COMPLETED', ?, ?)`)
      .run(`attempt-${options.workId}`, `plan-${options.workId}`, options.workId,
        options.partnerRevisionId, `action-${options.workId}`, NOW, NOW);
    connection.prepare(`INSERT INTO partner_runs
      (run_id, dispatch_attempt_id, action_id, workbench_id, work_id, partner_revision_id, kind,
       external_run_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'LOCAL_PI', ?, 'COMPLETED', ?, ?)`)
      .run(`run-${options.workId}`, `attempt-${options.workId}`, `action-${options.workId}`,
        workbenchId, options.workId, options.partnerRevisionId, `local:${options.workId}`, NOW, NOW);
    connection.prepare(`INSERT INTO work_result_bodies (body_ref, body, created_at) VALUES (?, 'RAW', ?)`)
      .run(`body-${options.workId}`, NOW);
    connection.prepare(`INSERT INTO work_results
      (result_id, run_id, action_id, workbench_id, work_id, partner_revision_id, status, summary,
       body_ref, artifacts_json, is_late, is_authoritative, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', '摘要', ?, '[]', 0, 1, ?)`)
      .run(`result-${options.workId}`, `run-${options.workId}`, `action-${options.workId}`,
        workbenchId, options.workId, options.partnerRevisionId, `body-${options.workId}`, NOW);
    connection.prepare(`INSERT INTO partner_result_events
      (event_id, run_id, workbench_id, work_id, partner_revision_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?)`)
      .run(`event-${options.workId}`, `run-${options.workId}`, workbenchId,
        options.workId, options.partnerRevisionId, NOW);
    if (options.absorbed) {
      connection.prepare(`INSERT INTO joi_goal_result_members (original_input_id, event_id, revision)
        VALUES (?, ?, 1)`).run(options.goalInputId, `event-${options.workId}`);
    }
  });
}

function harnessSnapshot(fixture: RuntimeFixture, goalInputId: string): Record<string, unknown> {
  return fixture.database.transaction((connection) => connection.prepare(
    `SELECT status, cleared_at, reviewed_revision, feedback_recorded_at FROM joi_harness_maps
      WHERE goal_input_id = ?`).get(goalInputId)) as Record<string, unknown>;
}

describe("SqliteJoiHarnessRepository", () => {
  let fixture: RuntimeFixture;
  let repository: SqliteJoiHarnessRepository;

  beforeEach(async () => {
    fixture = await createRuntimeFixture();
    repository = new SqliteJoiHarnessRepository(fixture.database);
  });

  afterEach(async () => {
    await fixture.close();
  });

  describe("adoption scan and map creation", () => {
    it("lists goals that have a turn but no map, skipping system inputs and canceled goals", async () => {
      seedGoal(fixture, { goalInputId: "goal-adopt", turn: true });
      seedGoal(fixture, { goalInputId: "goal-no-turn" });
      seedGoal(fixture, { goalInputId: "goal-canceled", status: "CONSUMED", turn: true });
      fixture.database.transaction((connection) => {
        connection.prepare(`UPDATE joi_inbox_messages SET canceled_at = ? WHERE input_id = 'goal-canceled'`).run(NOW);
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
          VALUES ('joi_result_input:goal:goal-adopt', 'key-synthetic', 'synthesis', 'CONSUMED', 'workbench-goal-adopt', 'goal-adopt', ?, ?)`)
          .run(NOW, NOW);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-synthetic', 'joi_result_input:goal:goal-adopt', 'workbench-goal-adopt', 's', 'COMPLETED', ?, ?)`)
          .run(NOW, NOW);
      });
      expect(await repository.listGoalsWithoutMap()).toEqual([
        { workbenchId: "workbench-goal-adopt", goalInputId: "goal-adopt" },
      ]);
    });

    it("adopts a goal that only reached a clarification gate and never its continuation rows", async () => {
      // A goal whose first Turn raised a workbench-selection clarification never gets a
      // joi_turns row: the gate row is the only proof the goal exists. Its resume/recovery
      // rows are orchestration continuations of that goal and must never own the map.
      seedGoal(fixture, { goalInputId: "goal-gated" });
      seedGoal(fixture, { goalInputId: "goal-resumed", turn: true });
      await new SqliteJoiInboxRepository(fixture.database, fixture.clock)
        .requireClarification("goal-gated", "workbench_selection_invalid");
      fixture.database.transaction((connection) => {
        for (const [inputId, turnId] of [
          ["joi_goal_resume:goal:goal-resumed:v1", "turn-resume"],
          ["joi_recovery:goal:goal-resumed:work:work-1", "turn-recovery"],
        ] as const) {
          connection.prepare(`INSERT INTO joi_inbox_messages
            (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
            VALUES (?, ?, 'continuation body', 'CONSUMED', 'workbench-goal-resumed', 'goal-resumed', ?, ?)`)
            .run(inputId, `key-${turnId}`, NOW, NOW);
          connection.prepare(`INSERT INTO joi_turns
            (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
            VALUES (?, ?, 'workbench-goal-resumed', 'session-continuation', 'COMPLETED', ?, ?)`)
            .run(turnId, inputId, NOW, NOW);
        }
      });

      expect(await repository.listGoalsWithoutMap()).toEqual([
        { workbenchId: "workbench-goal-gated", goalInputId: "goal-gated" },
        { workbenchId: "workbench-goal-resumed", goalInputId: "goal-resumed" },
      ]);
    });

    it("creates a map exactly once", async () => {
      seedGoal(fixture, { goalInputId: "goal-once", turn: true });
      expect(await repository.createMap({ workbenchId: "workbench-goal-once", goalInputId: "goal-once", now: NOW })).toBe(true);
      expect(await repository.createMap({ workbenchId: "workbench-goal-once", goalInputId: "goal-once", now: NOW })).toBe(false);
      expect(await repository.listGoalsWithoutMap()).toEqual([]);
    });
  });

  describe("home feed goal status", () => {
    it("keeps a direct-answer goal completed but reports a failed arrangement Turn as FAILED", async () => {
      // Mirrors the observed incident: one Turn consumed the inbox row with a text answer,
      // then the Turn that actually tried to dispatch died. The card must not keep claiming
      // attainment for a goal that stopped with no Work and no outcome.
      const answered = seedGoal(fixture, { goalInputId: "goal-answered", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId: answered.workbenchId, goalInputId: "goal-answered", now: NOW });
      const stalled = seedGoal(fixture, { goalInputId: "goal-stalled", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId: stalled.workbenchId, goalInputId: "goal-stalled", now: NOW });
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_turns SET status = 'FAILED' WHERE turn_id = 'turn-goal-stalled'",
      ).run());

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW));
      const statusOf = (goalId: string) => feed.goals.find((goal) => goal.goalId === goalId)?.status;
      expect(statusOf("goal-answered")).toBe("COMPLETED");
      expect(statusOf("goal-stalled")).toBe("FAILED");
    });

    it("reports a CONTINUE outcome on a closed map as completed, not as an unresolvable review", async () => {
      // A CONTINUE outcome is one evidence layer, and the card projects review while a live map
      // lets the harness adopt that layer. On a CLEARED map nothing can ever adopt it, so the same
      // projection strands the card behind a badge that can never resolve.
      const closed = seedGoal(fixture, { goalInputId: "goal-continue-closed", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId: closed.workbenchId, goalInputId: "goal-continue-closed", now: NOW });
      seedCompletedLayer(fixture, "goal-continue-closed", 1, "CONTINUE");
      forceMapCleared(fixture, "goal-continue-closed");
      const live = seedGoal(fixture, { goalInputId: "goal-continue-live", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId: live.workbenchId, goalInputId: "goal-continue-live", now: NOW });
      seedCompletedLayer(fixture, "goal-continue-live", 1, "CONTINUE");

      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW));
      const statusOf = (goalId: string) => feed.goals.find((goal) => goal.goalId === goalId)?.status;
      expect(statusOf("goal-continue-closed")).toBe("COMPLETED");
      expect(statusOf("goal-continue-live")).toBe("REVIEWING");
    });
  });

  describe("close-out race with in-flight results", () => {
    it("withholds AUTO_CLEAR until the result set has absorbed every completed result", async () => {
      // The incident: a Work turned COMPLETED, the close-out read the still-stale result set as
      // "facts complete" and cleared the map, and the synthesis landing 16ms later published a
      // revision the map had already outrun. Both arms pin the same facts and differ only in
      // whether the member row exists yet.
      const partner = await fixture.partners.add({
        capabilities: [], displayName: "分析搭档", kind: "local-pi", skills: [], tools: [],
      });
      // Both arms pin identical close-out facts — every Work terminal, the revision synthesized
      // and reviewed, the outcome COMPLETED — and differ only in whether the member row that
      // proves the result was absorbed exists yet.
      for (const goalInputId of ["goal-inflight", "goal-absorbed"]) {
        seedGoal(fixture, { goalInputId, status: "CONSUMED", turn: true });
        await repository.createMap({ workbenchId: `workbench-${goalInputId}`, goalInputId, now: NOW });
        seedCompletedLayer(fixture, goalInputId, 1);
        const [digest] = await repository.listReviewDigests();
        if (digest === undefined) throw new Error("review digest missing");
        const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
        if (reviewInputId === null) throw new Error("review input missing");
        fixture.database.transaction((connection) => {
          connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(reviewInputId);
          connection.prepare(`INSERT INTO joi_turns
            (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'COMPLETED', 1, ?, ?)`).run(
            `turn-${goalInputId}-review`, reviewInputId, `workbench-${goalInputId}`,
            `session-${goalInputId}-review`, NOW, NOW,
          );
        });
      }
      seedCompletedWorkWithResult(fixture, {
        absorbed: false, goalInputId: "goal-inflight", partnerRevisionId: partner.partnerRevisionId, workId: "work-inflight",
      });
      seedCompletedWorkWithResult(fixture, {
        absorbed: true, goalInputId: "goal-absorbed", partnerRevisionId: partner.partnerRevisionId, workId: "work-absorbed",
      });
      // A terminal Work with no path of its own is an unresolved fact in its own right, which
      // would quarantine the candidate for an unrelated reason and hide what this arm tests.
      await repository.synchronizeWorkPaths({ now: NOW });

      const candidates = await repository.listReviewRecoveries();
      expect(candidates.map((candidate) => candidate.digest.goalInputId)).toEqual(["goal-absorbed"]);
      expect(candidates[0]).toMatchObject({ action: "AUTO_CLEAR", reasonCode: "review_facts_complete" });
    });

    it("re-opens a map that was closed while a newer layer was still arriving", async () => {
      seedGoal(fixture, { goalInputId: "goal-reopen", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-reopen", goalInputId: "goal-reopen", now: NOW });
      // The close-out ran against revision 1 and cleared the map; the synthesis that landed right
      // after published revision 2, which no scan can adopt while the map stays CLEARED.
      seedCompletedLayer(fixture, "goal-reopen", 2);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_harness_maps SET reviewed_revision = 1 WHERE goal_input_id = 'goal-reopen'",
      ).run());
      forceMapCleared(fixture, "goal-reopen");

      const seeds = await repository.listUnreviewedClearedMaps();
      expect(seeds).toEqual([{ goalInputId: "goal-reopen", resultRevision: 2, workbenchId: "workbench-goal-reopen" }]);
      const seed = seeds[0];
      if (seed === undefined) throw new Error("unreviewed cleared map missing");
      expect(await repository.reopenUnreviewedMap({ now: NOW, seed })).toBe(true);
      expect(harnessSnapshot(fixture, "goal-reopen")).toMatchObject({
        cleared_at: null, feedback_recorded_at: null, reviewed_revision: 1, status: "ACTIVE",
      });
      // The point of re-opening: the ordinary review scan reaches the layer it outran.
      expect((await repository.listReviewDigests()).map((digest) => digest.resultRevision)).toEqual([2]);
      // Re-opening is one-way — the map is ACTIVE now, so the scan must not offer it again.
      expect(await repository.listUnreviewedClearedMaps()).toEqual([]);
      expect(await repository.reopenUnreviewedMap({ now: NOW, seed })).toBe(false);
    });

    it("leaves a map that closed on its own revision alone", async () => {
      const settled = seedGoal(fixture, { goalInputId: "goal-settled", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId: settled.workbenchId, goalInputId: "goal-settled", now: NOW });
      seedCompletedLayer(fixture, "goal-settled", 1);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_harness_maps SET reviewed_revision = 1 WHERE goal_input_id = 'goal-settled'",
      ).run());
      forceMapCleared(fixture, "goal-settled");
      // A goal the user revoked mid-layer must not be re-opened either.
      const revoked = seedGoal(fixture, { goalInputId: "goal-revoked", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId: revoked.workbenchId, goalInputId: "goal-revoked", now: NOW });
      seedCompletedLayer(fixture, "goal-revoked", 2);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_harness_maps SET reviewed_revision = 1 WHERE goal_input_id = 'goal-revoked'",
      ).run());
      forceMapCleared(fixture, "goal-revoked");
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_inbox_messages SET canceled_at = ? WHERE input_id = 'goal-revoked'",
      ).run(NOW));

      expect(await repository.listUnreviewedClearedMaps()).toEqual([]);
    });
  });

  describe("completion feedback", () => {
    it("appends one entry to the workbench task summary exactly once per cleared map", async () => {
      seedGoal(fixture, { goalInputId: "goal-feedback", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-feedback", goalInputId: "goal-feedback", now: NOW });
      forceMapCleared(fixture, "goal-feedback");
      expect(await repository.listFeedbackTargets()).toEqual([{
        workbenchId: "workbench-goal-feedback",
        completionSummary: "",
        destination: null,
        goalInputId: "goal-feedback",
      }]);
      expect(await repository.recordCompletionFeedback({
        workbenchId: "workbench-goal-feedback", entry: "[2026-08-06] 「目标」达成：收尾", goalInputId: "goal-feedback", now: NOW,
      })).toBe(true);
      expect(await repository.recordCompletionFeedback({
        workbenchId: "workbench-goal-feedback", entry: "重复写入", goalInputId: "goal-feedback", now: NOW,
      })).toBe(false);
      const summary = fixture.database.transaction((connection) => connection.prepare(
        "SELECT task_summary FROM workbenches WHERE workbench_id = 'workbench-goal-feedback'",
      ).get()) as { task_summary: string };
      expect(summary.task_summary).toBe("[2026-08-06] 「目标」达成：收尾");
      expect(await repository.listFeedbackTargets()).toEqual([]);
    });

    it("keeps only the trailing 2000 characters of the task summary", async () => {
      seedGoal(fixture, { goalInputId: "goal-trim", turn: true });
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE workbenches SET task_summary = ? WHERE workbench_id = 'workbench-goal-trim'",
      ).run("A".repeat(2_500)));
      await repository.createMap({ workbenchId: "workbench-goal-trim", goalInputId: "goal-trim", now: NOW });
      forceMapCleared(fixture, "goal-trim");
      await repository.recordCompletionFeedback({
        workbenchId: "workbench-goal-trim", entry: "TAIL", goalInputId: "goal-trim", now: NOW,
      });
      const summary = fixture.database.transaction((connection) => connection.prepare(
        "SELECT task_summary FROM workbenches WHERE workbench_id = 'workbench-goal-trim'",
      ).get()) as { task_summary: string };
      expect(summary.task_summary).toHaveLength(2_000);
      expect(summary.task_summary.endsWith("TAIL")).toBe(true);
    });

    it("marks accepted incomplete evidence so feedback cannot claim full attainment", async () => {
      seedGoal(fixture, { goalInputId: "goal-feedback-gaps", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-feedback-gaps", goalInputId: "goal-feedback-gaps", now: NOW });
      seedCompletedLayer(fixture, "goal-feedback-gaps", 1, "ACCEPTED_WITH_GAPS");
      forceMapCleared(fixture, "goal-feedback-gaps");

      expect(await repository.listFeedbackTargets()).toEqual([{
        acceptedWithGaps: true,
        workbenchId: "workbench-goal-feedback-gaps",
        completionSummary: "一层完成",
        destination: null,
        goalInputId: "goal-feedback-gaps",
      }]);
    });
  });

  describe("trivial map garbage collection", () => {
    it("clears empty maps of consumed goals and skips maps with content", async () => {
      seedGoal(fixture, { goalInputId: "goal-trivial", status: "CONSUMED", turn: true });
      seedGoal(fixture, { goalInputId: "goal-named", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-trivial", goalInputId: "goal-trivial", now: NOW });
      await repository.createMap({ workbenchId: "workbench-goal-named", goalInputId: "goal-named", now: NOW });
      await repository.nameDestination({ destination: "有名字的地图", goalInputId: "goal-named", turnId: "turn-goal-named" });
      expect(await repository.listTrivialMapCandidates()).toEqual([{ goalInputId: "goal-trivial" }]);
      expect(await repository.clearTrivialMap({ goalInputId: "goal-trivial", now: NOW })).toBe(true);
      expect(await repository.clearTrivialMap({ goalInputId: "goal-trivial", now: NOW })).toBe(false);
      // Trivially cleared maps never enter the feedback queue.
      expect(await repository.listFeedbackTargets()).toEqual([]);
    });
  });

  describe("reasoning-side writes", () => {
    it("auto-creates the map on first write and rejects oversized destinations", async () => {
      seedGoal(fixture, { goalInputId: "goal-dest", turn: true });
      await expect(repository.nameDestination({
        destination: "x".repeat(241), goalInputId: "goal-dest", turnId: "turn-goal-dest",
      })).rejects.toMatchObject({ code: "harness_destination_invalid" });
      const named = await repository.nameDestination({
        destination: "分析股票 688141", goalInputId: "goal-dest", turnId: "turn-goal-dest",
      });
      expect(named).toEqual({ destination: "分析股票 688141", revision: 1 });
      expect(await repository.listGoalsWithoutMap()).toEqual([]);
    });

    it("charts and closes paths, rejecting work from other goals", async () => {
      seedGoal(fixture, { goalInputId: "goal-path", turn: true });
      seedGoal(fixture, { goalInputId: "goal-other", turn: true });
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-other', 'workbench-goal-other', 'goal-other', 'other work', '{}', 'READ', 'COMPLETED', ?, ?)`)
        .run(NOW, NOW));
      const opened = await repository.chartPath({
        goalInputId: "goal-path",
        open: { layer: 1, title: "先收集资料" },
        turnId: "turn-goal-path",
      });
      expect(opened.status).toBe("OPEN");
      await expect(repository.chartPath({
        goalInputId: "goal-path",
        open: { layer: 1, title: "跨 goal 的 work", workId: "work-other" },
        turnId: "turn-goal-path",
      })).rejects.toMatchObject({ code: "harness_path_invalid" });
      await expect(repository.chartPath({
        goalInputId: "goal-path",
        open: { layer: 33, title: "层数越界" },
        turnId: "turn-goal-path",
      })).rejects.toMatchObject({ code: "harness_path_invalid" });
      const closed = await repository.chartPath({
        close: { pathId: opened.pathId, status: "CLOSED" },
        goalInputId: "goal-path",
        turnId: "turn-goal-path",
      });
      expect(closed.status).toBe("CLOSED");
      await expect(repository.chartPath({
        close: { pathId: opened.pathId, status: "CLOSED" },
        goalInputId: "goal-path",
        turnId: "turn-goal-path",
      })).rejects.toMatchObject({ code: "harness_path_invalid" });
    });

    it("records decisions and optionally closes a path", async () => {
      seedGoal(fixture, { goalInputId: "goal-decision", turn: true });
      const opened = await repository.chartPath({
        goalInputId: "goal-decision",
        open: { layer: 1, title: "待决策路径" },
        turnId: "turn-goal-decision",
      });
      const recorded = await repository.recordDecision({
        closePathId: opened.pathId,
        detail: "细节",
        goalInputId: "goal-decision",
        kind: "APPROACH",
        summary: "采用轻量方案",
        turnId: "turn-goal-decision",
      });
      expect(recorded.decisionId).toBeTypeOf("string");
      const projection = await repository.loadGoalProjections();
      expect(projection).toHaveLength(1);
      expect(projection[0]).toMatchObject({
        decisionCount: 1,
        goalInputId: "goal-decision",
        openPathCount: 0,
        topPaths: [{ pathId: opened.pathId, status: "CLOSED", title: "待决策路径" }],
      });
      await expect(repository.recordDecision({
        goalInputId: "goal-decision", kind: "BOGUS" as never, summary: "非法类型", turnId: "turn-goal-decision",
      })).rejects.toMatchObject({ code: "harness_decision_invalid" });
    });

    it("notes fog and graduates it into an open path exactly once", async () => {
      seedGoal(fixture, { goalInputId: "goal-fog", turn: true });
      const noted = await repository.noteFog({ goalInputId: "goal-fog", note: "数据源还不明确", turnId: "turn-goal-fog" });
      const graduated = await repository.graduateFog({
        fogId: noted.fogId,
        goalInputId: "goal-fog",
        layer: 2,
        title: "确认数据源",
        turnId: "turn-goal-fog",
      });
      expect(graduated.pathId).toBeTypeOf("string");
      await expect(repository.graduateFog({
        fogId: noted.fogId, goalInputId: "goal-fog", layer: 2, title: "重复晋升", turnId: "turn-goal-fog",
      })).rejects.toMatchObject({ code: "harness_fog_invalid" });
      const projection = await repository.loadGoalProjections();
      expect(projection[0]).toMatchObject({ currentLayer: 2, fogCount: 0, openPathCount: 1 });
    });

    it("refuses map writes once the map is cleared", async () => {
      seedGoal(fixture, { goalInputId: "goal-cleared", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-cleared", goalInputId: "goal-cleared", now: NOW });
      forceMapCleared(fixture, "goal-cleared");
      await expect(repository.noteFog({
        goalInputId: "goal-cleared", note: "清空后不应再记录", turnId: "turn-goal-cleared",
      })).rejects.toBeInstanceOf(DomainError);
    });
  });

  describe("review enqueue gates", () => {
    it("posts exactly one review input per completed result layer", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review", now: NOW });
      seedCompletedLayer(fixture, "goal-review", 1);
      const digests = await repository.listReviewDigests();
      expect(digests).toHaveLength(1);
      const firstDigest = digests[0];
      if (firstDigest === undefined) throw new Error("review digest missing");
      expect(firstDigest).toMatchObject({
        workbenchId,
        completionSummary: "一层完成",
        destination: null,
        goalInputId: "goal-review",
        resultRevision: 1,
      });
      const inputId = await repository.enqueueReview({ digest: firstDigest, now: NOW });
      expect(inputId).toBe("joi_harness_review:goal:goal-review:r1");
      expect(await repository.listReviewRecoveries()).toEqual([]);
      const row = fixture.database.transaction((connection) => connection.prepare(`
        SELECT status, workbench_id, goal_input_id, result_revision, idempotency_key
          FROM joi_inbox_messages WHERE input_id = ?`).get(inputId)) as Record<string, unknown>;
      expect(row).toEqual({
        workbench_id: workbenchId,
        goal_input_id: "goal-review",
        idempotency_key: "harness_review_goal:goal-review:1",
        result_revision: null,
        status: "PENDING",
      });
      // The watermark advanced: neither the scan nor a replayed enqueue posts a second row.
      expect(await repository.listReviewDigests()).toEqual([]);
      expect(await repository.enqueueReview({ digest: firstDigest, now: NOW })).toBeNull();
      const count = fixture.database.transaction((connection) => connection.prepare(`
        SELECT COUNT(*) AS n FROM joi_inbox_messages WHERE input_id LIKE 'joi_harness_review:%'`)
        .get()) as { n: number };
      expect(count.n).toBe(1);
    });

    it("does not post reviews while work is active, synthesis lags, or the outcome is missing", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-gates", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-gates", now: NOW });
      // No result set at all.
      expect(await repository.listReviewDigests()).toEqual([]);
      // Result set exists but synthesis lags behind.
      fixture.database.transaction((connection) => connection.prepare(`
        INSERT INTO joi_goal_result_sets (original_input_id, revision, synthesized_revision, updated_at)
        VALUES ('goal-gates', 2, 1, ?)`).run(NOW));
      expect(await repository.listReviewDigests()).toEqual([]);
      // Synthesis caught up but no outcome row yet.
      fixture.database.transaction((connection) => connection.prepare(`
        UPDATE joi_goal_result_sets SET synthesized_revision = 2 WHERE original_input_id = 'goal-gates'`).run());
      expect(await repository.listReviewDigests()).toEqual([]);
      seedCompletedLayer(fixture, "goal-gates", 2);
      expect(await repository.listReviewDigests()).toHaveLength(1);
      // Active work blocks the review again.
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-active', ?, 'goal-gates', 'active', '{}', 'READ', 'RUNNING', ?, ?)`)
        .run(workbenchId, NOW, NOW));
      expect(await repository.listReviewDigests()).toEqual([]);
    });

    it("does not post a harness review for a blocked synthesis outcome", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-blocked", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-blocked", now: NOW });
      seedCompletedLayer(fixture, "goal-blocked", 1);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_outcomes SET disposition = 'BLOCKED' WHERE input_id = 'goal-blocked'",
      ).run());

      expect(await repository.listReviewDigests()).toEqual([]);
    });

    it("automatically reviews two continuation layers then requests a goal-level decision", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-continue", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-continue", now: NOW });

      for (const layer of [1, 2, 3]) {
        if (layer > 1) {
          fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_harness_paths
            (path_id, goal_input_id, layer, title, status, created_at, updated_at)
            VALUES (?, 'goal-continue', ?, '补充证据', 'CLOSED', ?, ?)`)
            .run(`path-continue-${String(layer)}`, layer, NOW, NOW));
        }
        seedCompletedLayer(fixture, "goal-continue", layer, "CONTINUE");
        const digests = await repository.listReviewDigests();
        if (layer <= 2) {
          expect(digests).toHaveLength(1);
          const digest = digests[0];
          if (digest === undefined) throw new Error("expected continuation review digest");
          await expect(repository.enqueueReview({ digest, now: NOW })).resolves.not.toBeNull();
        } else {
          expect(digests).toEqual([]);
        }
      }

      const decisions = await repository.listContinuationDecisionSeeds();
      expect(decisions).toEqual([{
        goalInputId: "goal-continue",
        resultRevision: 3,
        workbenchId,
      }]);
      const decision = decisions[0];
      if (decision === undefined) throw new Error("expected continuation decision seed");
      await expect(repository.requestContinuationDecision({ now: NOW, seed: decision })).resolves.toBe(true);
      await expect(repository.requestContinuationDecision({ now: NOW, seed: decision })).resolves.toBe(false);
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW))).goals[0])
        .toMatchObject({
          clarification: { reasonCode: "goal_continuation_required" },
          goalId: "goal-continue",
          status: "NEEDS_ATTENTION",
        });
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT kind, result_revision, status
        FROM joi_user_action_requests WHERE input_id = 'goal-continue'`).get())).toEqual({
        kind: "GOAL_CONTINUATION",
        result_revision: 3,
        status: "OPEN",
      });
    });

    it("re-raises a continuation decision when an applied grant left the goal exhausted", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-continue-reraise", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-continue-reraise", now: NOW });
      for (const layer of [1, 2, 3]) {
        if (layer > 1) {
          fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_harness_paths
            (path_id, goal_input_id, layer, title, status, created_at, updated_at)
            VALUES (?, 'goal-continue-reraise', ?, '补充证据', 'CLOSED', ?, ?)`)
            .run(`path-reraise-${String(layer)}`, layer, NOW, NOW));
        }
        seedCompletedLayer(fixture, "goal-continue-reraise", layer, "CONTINUE");
      }
      const decisions = await repository.listContinuationDecisionSeeds();
      const decision = decisions[0];
      if (decision === undefined) throw new Error("expected continuation decision seed");
      await expect(repository.requestContinuationDecision({ now: NOW, seed: decision })).resolves.toBe(true);

      // Simulate the grant being applied without opening room (recovery-appended layers):
      // the goal is still exhausted and idle, so the decision must be askable again.
      fixture.database.transaction((connection) => {
        connection.prepare(`UPDATE joi_user_action_requests SET status = 'APPLIED', decision = 'CONTINUE'
          WHERE input_id = 'goal-continue-reraise' AND status = 'OPEN'`).run();
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', clarification_reason_code = NULL,
          clarification_prompt = NULL WHERE input_id = 'goal-continue-reraise'`).run();
      });

      const again = await repository.listContinuationDecisionSeeds();
      expect(again).toEqual([decision]);
      await expect(repository.requestContinuationDecision({ now: NOW, seed: decision })).resolves.toBe(true);
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT action_id, status
        FROM joi_user_action_requests WHERE input_id = 'goal-continue-reraise' ORDER BY action_id`).all())).toEqual([
        { action_id: "joi_action:goal_continuation:goal-continue-reraise:r3:s1", status: "APPLIED" },
        { action_id: "joi_action:goal_continuation:goal-continue-reraise:r3:s2", status: "OPEN" },
      ]);
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT status, clarification_reason_code
        FROM joi_inbox_messages WHERE input_id = 'goal-continue-reraise'`).get())).toEqual({
        clarification_reason_code: "goal_continuation_required",
        status: "CLARIFICATION_REQUIRED",
      });
    });

    it("does not overwrite an unrelated user clarification with automatic continuation", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-continue-guard", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-continue-guard", now: NOW });
      seedCompletedLayer(fixture, "goal-continue-guard", 1, "CONTINUE");
      fixture.database.transaction((connection) => connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = 'question_required',
            clarification_prompt = '先确认范围' WHERE input_id = 'goal-continue-guard'`).run());

      expect(await repository.listReviewDigests()).toEqual([]);
      fixture.database.transaction((connection) => {
        const insertPath = connection.prepare(`INSERT INTO joi_harness_paths
          (path_id, goal_input_id, layer, title, status, created_at, updated_at)
          VALUES (?, 'goal-continue-guard', ?, '补充证据', 'CLOSED', ?, ?)`);
        insertPath.run("path-continue-guard-2", 2, NOW, NOW);
        insertPath.run("path-continue-guard-3", 3, NOW, NOW);
      });
      seedCompletedLayer(fixture, "goal-continue-guard", 3, "CONTINUE");
      expect(await repository.listContinuationDecisionSeeds()).toEqual([]);
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT status, clarification_reason_code
        FROM joi_inbox_messages WHERE input_id = 'goal-continue-guard'`).get())).toEqual({
        clarification_reason_code: "question_required",
        status: "CLARIFICATION_REQUIRED",
      });
    });

    it("queues a dedicated recovery turn and clears an internal dispatch clarification", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-self-heal", status: "CLARIFICATION_REQUIRED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-self-heal", now: NOW });
      seedCompletedLayer(fixture, "goal-self-heal", 1);
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_goal_outcomes SET disposition = 'BLOCKED' WHERE input_id = 'goal-self-heal'").run();
        connection.prepare(`UPDATE joi_inbox_messages SET clarification_reason_code = 'workspace_permission_required',
          clarification_prompt = 'permission required' WHERE input_id = 'goal-self-heal'`).run();
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-self-heal', ?, 'goal-self-heal', 'missing report', '{}', 'READ', 'FAILED', ?, ?)`)
          .run(workbenchId, NOW, NOW);
      });

      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW))).goals[0])
        .toMatchObject({ goalId: "goal-self-heal", status: "NEEDS_ATTENTION" });
      fixture.database.transaction((connection) => connection.prepare(`UPDATE joi_inbox_messages
        SET clarification_reason_code = 'work_dispatch_failed', clarification_prompt = 'internal failure'
        WHERE input_id = 'goal-self-heal'`).run());

      const [seed] = await repository.listWorkRecoverySeeds();
      expect(seed).toEqual({ attemptNo: 1, goalInputId: "goal-self-heal", sourceWorkId: "work-self-heal", workbenchId });
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW))).goals[0])
        .toMatchObject({ canDelete: false, goalId: "goal-self-heal", status: "EXTENDING" });
      if (seed === undefined) throw new Error("recovery seed missing");
      const recoveryInputId = await repository.enqueueWorkRecovery({ now: NOW, seed });
      expect(recoveryInputId).toBe("joi_recovery:goal:goal-self-heal:work:work-self-heal:a1");
      expect(await repository.listWorkRecoverySeeds()).toEqual([]);
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT status, clarification_reason_code
        FROM joi_inbox_messages WHERE input_id = 'goal-self-heal'`).get())).toEqual({
        clarification_reason_code: null,
        status: "CONSUMED",
      });
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT goal_input_id, status
        FROM joi_inbox_messages WHERE input_id = ?`).get(recoveryInputId))).toEqual({ goal_input_id: "goal-self-heal", status: "PENDING" });
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW))).goals[0])
        .toMatchObject({ canDelete: false, goalId: "goal-self-heal", status: "EXTENDING" });

      fixture.database.transaction((connection) => connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CONSUMED', failed_at = ? WHERE input_id = ?`).run(NOW, recoveryInputId));
      const [secondSeed] = await repository.listWorkRecoverySeeds();
      expect(secondSeed).toMatchObject({ attemptNo: 2, goalInputId: "goal-self-heal", sourceWorkId: "work-self-heal" });
      if (secondSeed === undefined) throw new Error("second recovery seed missing");
      const secondRecoveryInputId = await repository.enqueueWorkRecovery({ now: NOW, seed: secondSeed });
      expect(secondRecoveryInputId).toBe("joi_recovery:goal:goal-self-heal:work:work-self-heal:a2");
      fixture.database.transaction((connection) => connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CONSUMED', failed_at = ? WHERE input_id = ?`).run(NOW, secondRecoveryInputId));
      expect(await repository.listWorkRecoverySeeds()).toEqual([]);
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW))).goals[0])
        .toMatchObject({ goalId: "goal-self-heal", status: "FAILED" });
    });

    it("does not let historical review recovery quarantine a goal owned by work recovery", async () => {
      const goalInputId = "goal-recovery-owns-blocked";
      const { workbenchId } = seedGoal(fixture, { goalInputId, status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId, now: NOW });
      seedCompletedLayer(fixture, goalInputId, 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_goal_outcomes SET disposition = 'BLOCKED' WHERE input_id = ?").run(goalInputId);
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', failed_at = ?,
          failure_reason_code = 'legacy_scheduler_failure', failure_count = 8 WHERE input_id = ?`).run(NOW, reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('turn-recovery-owned-review', ?, ?, 'review-recovery-owned', 'COMPLETED', 1, ?, ?)`).run(
          reviewInputId, workbenchId, NOW, NOW,
        );
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-recovery-owned', ?, ?, 'missing artifact', '{}', 'WRITE', 'FAILED', ?, ?)`).run(
          workbenchId, goalInputId, NOW, NOW,
        );
      });

      expect(await repository.listReviewRecoveries()).toHaveLength(1);
      const [seed] = await repository.listWorkRecoverySeeds();
      if (seed === undefined) throw new Error("work recovery seed missing");
      expect(await repository.enqueueWorkRecovery({ now: NOW, seed })).not.toBeNull();
      expect(await repository.listReviewRecoveries()).toEqual([]);
    });

    it("requeues a consumed review once when its history proves no side effect started", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-recovery", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-recovery", now: NOW });
      seedCompletedLayer(fixture, "goal-review-recovery", 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_goal_outcomes SET disposition = 'BLOCKED' WHERE input_id = 'goal-review-recovery'").run();
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', failed_at = ?,
          failure_reason_code = 'legacy_scheduler_failure', failure_count = 8 WHERE input_id = ?`).run(NOW, reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('turn-review-recovery', ?, ?, 'review-recovery', 'FAILED', 0, ?, ?)`).run(reviewInputId, workbenchId, NOW, NOW);
      });

      const candidates = await repository.listReviewRecoveries();
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("review recovery candidate missing");
      expect(candidate).toMatchObject({ action: "REQUEUE", reasonCode: "review_turn_failed_without_side_effect" });
      const result = await repository.reconcileReview({ candidate, now: NOW });
      expect(result).toEqual({ action: "REQUEUED", inputId: reviewInputId });
      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT status, failed_at, failure_reason_code, failure_count FROM joi_inbox_messages WHERE input_id = ?`)
        .get(reviewInputId))).toEqual({ failure_count: null, failure_reason_code: null, failed_at: null, status: "PENDING" });
      expect(await repository.listReviewRecoveries()).toEqual([]);
    });

    it("requeues a review whose turn completed without any side effect, then quarantines a repeat", async () => {
      // A review truncated by its output budget ends COMPLETED with zero tool calls:
      // no work completion ever re-arms the goal and disposition stays CONTINUE, so
      // without this arm the goal idles forever behind an ACTIVE map.
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-wasted", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-wasted", now: NOW });
      seedCompletedLayer(fixture, "goal-review-wasted", 1, "CONTINUE");
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED', body = 'stale body' WHERE input_id = ?").run(reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, formal_output_started, side_effect_started, created_at, updated_at)
          VALUES ('turn-review-wasted', ?, ?, 'review-wasted', 'COMPLETED', 0, 0, ?, ?)`).run(reviewInputId, workbenchId, NOW, NOW);
      });

      const candidates = await repository.listReviewRecoveries();
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("review recovery candidate missing");
      expect(candidate).toMatchObject({ action: "REQUEUE", reasonCode: "review_completed_without_side_effect" });
      const result = await repository.reconcileReview({ candidate, now: NOW });
      expect(result).toEqual({ action: "REQUEUED", inputId: reviewInputId });
      const requeued = fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, body FROM joi_inbox_messages WHERE input_id = ?").get(reviewInputId)) as { body: string; status: string };
      expect(requeued.status).toBe("PENDING");
      // The replay must not reuse the prompt the wasted turn choked on.
      expect(requeued.body).not.toBe("stale body");
      expect(requeued.body).toContain("goalInputId=goal-review-wasted");
      expect(await repository.listReviewRecoveries()).toEqual([]);

      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, formal_output_started, side_effect_started, created_at, updated_at)
          VALUES ('turn-review-wasted-2', ?, ?, 'review-wasted-2', 'COMPLETED', 0, 0, ?, ?)`).run(reviewInputId, workbenchId, NOW, NOW);
      });
      const [second] = await repository.listReviewRecoveries();
      expect(second).toMatchObject({ action: "QUARANTINE", reasonCode: "review_repeatedly_completed_without_side_effect" });
      if (second === undefined) throw new Error("second review recovery candidate missing");
      expect(await repository.reconcileReview({ candidate: second, now: NOW })).toEqual({ action: "QUARANTINED" });
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, clarification_reason_code FROM joi_inbox_messages WHERE input_id = 'goal-review-wasted'").get()))
        .toMatchObject({ clarification_reason_code: "harness_review_unrecoverable", status: "CLARIFICATION_REQUIRED" });
      expect(await repository.listReviewRecoveries()).toEqual([]);
    });

    it("quarantines a consumed review when a historical side effect is present", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-unsafe", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-unsafe", now: NOW });
      seedCompletedLayer(fixture, "goal-review-unsafe", 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_goal_outcomes SET disposition = 'BLOCKED' WHERE input_id = 'goal-review-unsafe'").run();
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', failed_at = ?,
          failure_reason_code = 'legacy_scheduler_failure', failure_count = 8 WHERE input_id = ?`).run(NOW, reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('turn-review-unsafe', ?, ?, 'review-unsafe', 'COMPLETED', 1, ?, ?)`).run(reviewInputId, workbenchId, NOW, NOW);
      });

      const candidates = await repository.listReviewRecoveries();
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("review recovery candidate missing");
      expect(candidate).toMatchObject({ action: "QUARANTINE", reasonCode: "review_side_effect_unknown" });
      const result = await repository.reconcileReview({ candidate, now: NOW });
      expect(result).toEqual({ action: "QUARANTINED" });
      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT status, clarification_reason_code, clarification_prompt FROM joi_inbox_messages WHERE input_id = 'goal-review-unsafe'`)
        .get())).toMatchObject({ clarification_reason_code: "harness_review_unrecoverable", status: "CLARIFICATION_REQUIRED" });
      expect(await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW))).toMatchObject({
        goals: [expect.objectContaining({ goalId: "goal-review-unsafe", status: "NEEDS_ATTENTION" })],
      });
      expect(await repository.listReviewRecoveries()).toEqual([]);
    });

    it("auto-clears a quarantined review when terminal Work facts prove the goal is complete", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-auto-clear", status: "CLARIFICATION_REQUIRED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-auto-clear", now: NOW });
      seedCompletedLayer(fixture, "goal-review-auto-clear", 1);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_outcomes SET disposition = 'COMPLETED' WHERE input_id = 'goal-review-auto-clear'",
      ).run());
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CLARIFICATION_REQUIRED',
          clarification_reason_code = 'harness_review_unrecoverable', clarification_prompt = '历史评审记录无法安全恢复。' WHERE input_id = 'goal-review-auto-clear'`).run();
        // A stale scheduler may leave the derived review row pending even though
        // its Turn has already ended; completed facts must still converge it.
        connection.prepare("UPDATE joi_inbox_messages SET status = 'PENDING' WHERE input_id = ?").run(reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('turn-review-auto-clear', ?, ?, 'review-auto-clear', 'COMPLETED', 1, ?, ?)`).run(reviewInputId, workbenchId, NOW, NOW);
      });

      const candidate = (await repository.listReviewRecoveries())[0];
      expect(candidate).toMatchObject({ action: "AUTO_CLEAR", reasonCode: "review_facts_complete" });
      if (candidate === undefined) throw new Error("review recovery candidate missing");
      expect(await repository.reconcileReview({ candidate, now: NOW })).toEqual({ action: "AUTO_CLEARED" });
      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT status FROM joi_harness_maps WHERE goal_input_id = 'goal-review-auto-clear'`).get())).toEqual({ status: "CLEARED" });
      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT status, clarification_reason_code FROM joi_inbox_messages WHERE input_id = 'goal-review-auto-clear'`).get())).toEqual({
        clarification_reason_code: null,
        status: "CONSUMED",
      });
    });

    it("stops reconciling an already cleared review without touching the goal inbox again", async () => {
      const LATER = "2026-08-06T11:00:00.000Z";
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-zombie", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-zombie", now: NOW });
      seedCompletedLayer(fixture, "goal-review-zombie", 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CONSUMED', failed_at = ?,
          failure_reason_code = 'legacy_scheduler_failure', failure_count = 8 WHERE input_id = ?`).run(NOW, reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('turn-review-zombie', ?, ?, 'review-zombie', 'FAILED', 0, ?, ?)`).run(reviewInputId, workbenchId, NOW, NOW);
      });

      const candidates = await repository.listReviewRecoveries();
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("review recovery candidate missing");
      expect(candidate).toMatchObject({ action: "AUTO_CLEAR", reasonCode: "review_facts_complete" });
      expect(await repository.reconcileReview({ candidate, now: LATER })).toEqual({ action: "AUTO_CLEARED" });
      // The goal row was already clean CONSUMED: clearing the review must not bump its
      // updated_at, or every actor tick re-sorts the completed goal to the top of the home feed.
      const goalUpdatedAt = () => fixture.database.transaction((connection) => connection.prepare(
        "SELECT updated_at FROM joi_inbox_messages WHERE input_id = 'goal-review-zombie'").get()) as { updated_at: string };
      expect(goalUpdatedAt()).toEqual({ updated_at: NOW });
      expect(await repository.listReviewRecoveries()).toEqual([]);
      // A stale candidate kept from an earlier tick converges to a no-op instead of re-touching rows.
      expect(await repository.reconcileReview({ candidate, now: LATER })).toBeNull();
      expect(goalUpdatedAt()).toEqual({ updated_at: NOW });
    });

    it("removes a stale historical clarification after the map was already cleared", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-stale-clarification", status: "CLARIFICATION_REQUIRED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-stale-clarification", now: NOW });
      seedCompletedLayer(fixture, "goal-review-stale-clarification", 1);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_outcomes SET disposition = 'COMPLETED' WHERE input_id = 'goal-review-stale-clarification'",
      ).run());
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_harness_maps SET reviewed_revision = 1 WHERE goal_input_id = 'goal-review-stale-clarification'",
      ).run());
      forceMapCleared(fixture, "goal-review-stale-clarification");
      fixture.database.transaction((connection) => connection.prepare(`UPDATE joi_inbox_messages
        SET clarification_reason_code = 'harness_review_unrecoverable', clarification_prompt = '历史评审记录无法安全恢复。'
        WHERE input_id = 'goal-review-stale-clarification'`).run());

      const candidate = (await repository.listReviewRecoveries())[0];
      expect(candidate).toMatchObject({ action: "AUTO_CLEAR", reasonCode: "review_facts_complete" });
      if (candidate === undefined) throw new Error("review recovery candidate missing");
      expect(await repository.reconcileReview({ candidate, now: NOW })).toEqual({ action: "AUTO_CLEARED" });
      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT status, clarification_reason_code FROM joi_inbox_messages WHERE input_id = 'goal-review-stale-clarification'`).get())).toEqual({
        clarification_reason_code: null,
        status: "CONSUMED",
      });
    });

    it("closes a completed review after delayed Work path synchronization without replaying it", async () => {
      const goalInputId = "goal-review-sync-race";
      const { workbenchId } = seedGoal(fixture, { goalInputId, status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId, now: NOW });
      for (let index = 0; index < 15; index++) {
        const workId = `work-review-sync-${String(index)}`;
        fixture.database.transaction((connection) => connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES (?, ?, ?, '检查证据', '{}', 'READ', ?, ?, ?)`)
          .run(workId, workbenchId, goalInputId, index < 12 ? "COMPLETED" : "FAILED", NOW, NOW));
        await repository.chartPath({ goalInputId, open: { layer: 1, title: "待同步路径", workId }, turnId: `turn-${goalInputId}` });
      }
      seedCompletedLayer(fixture, goalInputId, 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      await inbox.createTurn({ inputId: reviewInputId, turnId: "turn-sync-review", workbenchId, sessionId: "review-sync", createdAt: NOW });
      await inbox.completeInput(reviewInputId, "turn-sync-review");
      const feed = new SqliteJoiHomeFeedRepository(fixture.database);
      expect((await feed.load(new Date(NOW))).goals[0]).toMatchObject({
        status: "REVIEWING", work: { completed: 12, failed: 3, total: 15, active: 0 },
      });
      await repository.synchronizeWorkPaths({ now: NOW });

      const [candidate] = await repository.listReviewRecoveries();
      expect(candidate).toMatchObject({ action: "AUTO_CLEAR", reasonCode: "review_facts_complete" });
      if (candidate === undefined) throw new Error("review recovery candidate missing");
      expect(await repository.reconcileReview({ candidate, now: NOW })).toEqual({ action: "AUTO_CLEARED" });
      expect((await feed.load(new Date(NOW))).goals[0]).toMatchObject({ status: "COMPLETED", completionSummary: "一层完成" });
      expect(await repository.listReviewRecoveries()).toEqual([]);
      expect(await repository.reconcileReview({ candidate, now: NOW })).toBeNull();
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, (SELECT COUNT(*) FROM joi_turns WHERE input_id = ?) AS turns FROM joi_inbox_messages WHERE input_id = ?",
      ).get(reviewInputId, reviewInputId))).toEqual({ status: "CONSUMED", turns: 1 });
    });

    it("auto-clears rather than quarantines a normally consumed review with complete facts", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-normal", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-normal", now: NOW });
      seedCompletedLayer(fixture, "goal-review-normal", 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('turn-review-normal', ?, ?, 'review-normal', 'COMPLETED', 0, ?, ?)`).run(reviewInputId, workbenchId, NOW, NOW);
      });

      expect(await repository.listReviewRecoveries()).toEqual([expect.objectContaining({
        action: "AUTO_CLEAR", reasonCode: "review_facts_complete",
      })]);
    });

    // "continue" is deliberately absent: a wasted review over a CONTINUE outcome with
    // converged facts is the dead zone the recovery scan must requeue, covered below.
    it.each([
      "live-review", "active-work", "open-path", "missing-path", "blocked",
      "waiting-gate", "reviewing-gate", "canceled", "new-revision",
    ])("does not auto-close completed review when %s appears, including after scanning", async (blocker) => {
      const goalInputId = "goal-review-recheck";
      const { workbenchId } = seedGoal(fixture, { goalInputId, status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId, now: NOW });
      seedCompletedLayer(fixture, goalInputId, 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
          VALUES ('turn-review-recheck', ?, ?, 'review-recheck', 'COMPLETED', ?, ?)`)
          .run(reviewInputId, workbenchId, NOW, NOW);
      });
      const [candidate] = await repository.listReviewRecoveries();
      expect(candidate).toMatchObject({ action: "AUTO_CLEAR" });
      if (candidate === undefined) throw new Error("review recovery candidate missing");

      fixture.database.transaction((connection) => {
        if (blocker === "live-review") connection.prepare("UPDATE joi_turns SET status = 'RUNNING' WHERE turn_id = 'turn-review-recheck'").run();
        if (blocker === "active-work" || blocker === "missing-path") connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-review-recheck', ?, ?, '新证据', '{}', 'READ', ?, ?, ?)`)
          .run(workbenchId, goalInputId, blocker === "active-work" ? "READY" : "COMPLETED", NOW, NOW);
        if (blocker === "blocked") connection.prepare("UPDATE joi_goal_outcomes SET disposition = 'BLOCKED' WHERE input_id = ?")
          .run(goalInputId);
        if (blocker === "waiting-gate" || blocker === "reviewing-gate") connection.prepare(`INSERT INTO joi_goal_execution_gates
          (goal_input_id, question_id, question_version, status, reason_code, created_at, updated_at)
          VALUES (?, 'question-recheck', 1, ?, 'question_required', ?, ?)`)
          .run(goalInputId, blocker === "waiting-gate" ? "WAITING_INPUT" : "REVIEWING", NOW, NOW);
        if (blocker === "canceled") connection.prepare("UPDATE joi_inbox_messages SET canceled_at = ? WHERE input_id = ?").run(NOW, goalInputId);
      });
      if (blocker === "new-revision") seedCompletedLayer(fixture, goalInputId, 2);
      if (blocker === "open-path") await repository.chartPath({
        goalInputId, open: { layer: 1, title: "未完成验证" }, turnId: "turn-review-recheck",
      });
      expect(await repository.listReviewRecoveries()).toEqual([]);
      expect(await repository.reconcileReview({ candidate, now: NOW })).toBeNull();
      expect((await repository.loadGoalProjections())[0]?.mapStatus).toBe("ACTIVE");
    });

    it("closes a quarantined historical review only after the user confirms and gates pass", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-history-close", status: "CLARIFICATION_REQUIRED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-history-close", now: NOW });
      seedCompletedLayer(fixture, "goal-review-history-close", 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => {
        connection.prepare(`UPDATE joi_inbox_messages SET status = 'CLARIFICATION_REQUIRED',
          clarification_reason_code = 'harness_review_unrecoverable', clarification_prompt = '确认' WHERE input_id = 'goal-review-history-close'`).run();
        connection.prepare("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = ?").run(reviewInputId);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
          VALUES ('turn-review-history-close', ?, ?, 'review-history-close', 'COMPLETED', 1, ?, ?)`).run(reviewInputId, workbenchId, NOW, NOW);
      });

      const inboxRepository = new SqliteJoiInboxRepository(fixture.database);
      const closed = await inboxRepository.closeHistoricalReview("goal-review-history-close");
      expect(closed).toMatchObject({ inputId: "goal-review-history-close", status: "CONSUMED" });
      expect(fixture.database.transaction((connection) => connection.prepare(`
        SELECT status FROM joi_harness_maps WHERE goal_input_id = 'goal-review-history-close'`).get())).toEqual({ status: "CLEARED" });
      expect(await inboxRepository.closeHistoricalReview("goal-review-history-close")).toBeNull();
    });

    it("quarantines an active map whose canonical review row is missing", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-missing", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-missing", now: NOW });
      seedCompletedLayer(fixture, "goal-review-missing", 1);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_outcomes SET disposition = 'BLOCKED' WHERE input_id = 'goal-review-missing'",
      ).run());
      fixture.database.transaction((connection) => connection.prepare(`UPDATE joi_harness_maps
        SET reviewed_revision = 1 WHERE goal_input_id = 'goal-review-missing'`).run());

      const candidates = await repository.listReviewRecoveries();
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0];
      if (candidate === undefined) throw new Error("review recovery candidate missing");
      expect(candidate).toMatchObject({ action: "QUARANTINE", reasonCode: "review_row_missing" });
      await expect(repository.reconcileReview({ candidate, now: NOW })).resolves.toEqual({ action: "QUARANTINED" });
    });
  });

  describe("wayfinder-driven goal lifecycle", () => {
    it("projects a synthesized active map as review instead of a terminal goal", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-review-state", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-review-state", now: NOW });
      seedCompletedLayer(fixture, "goal-review-state", 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      await repository.enqueueReview({ digest, now: NOW });

      let feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW));
      expect(feed.goals[0]).toMatchObject({ canDelete: false, goalId: "goal-review-state", status: "REVIEWING" });
      expect(feed.goals[0]?.completionSummary).toBeUndefined();
      expect(feed.thinking).toEqual([expect.objectContaining({
        goalId: "goal-review-state", stage: "REVIEWING",
      })]);

      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-review-extension', ?, 'goal-review-state', '补充验证', '{}', 'READ', 'PLANNED', ?, ?)`)
        .run(workbenchId, NOW, NOW));
      feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW));
      expect(feed.goals[0]).toMatchObject({ canDelete: false, goalId: "goal-review-state", status: "EXTENDING" });
      expect(feed.thinking).toEqual([expect.objectContaining({
        goalId: "goal-review-state", stage: "EXTENDING",
      })]);
    });

    it("synchronizes goal Work into deterministic path facts and closes paths from Work truth", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-path-sync", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-path-sync", now: NOW });
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('work-path-sync', ?, 'goal-path-sync', '核对证据', '{}', 'READ', 'RUNNING', ?, ?)`)
        .run(workbenchId, NOW, NOW));

      const synchronizer = repository as unknown as {
        synchronizeWorkPaths(input: { now: string }): Promise<{ closed: number; created: number }>;
      };
      await expect(synchronizer.synchronizeWorkPaths({ now: NOW })).resolves.toEqual({ closed: 0, created: 1 });
      expect((await repository.loadGoalProjections())[0]).toMatchObject({
        currentLayer: 1,
        openPathCount: 1,
        topPaths: [expect.objectContaining({ status: "OPEN", title: "核对证据" })],
      });

      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE work_items SET status = 'COMPLETED', updated_at = ? WHERE work_id = 'work-path-sync'",
      ).run(NOW));
      await expect(synchronizer.synchronizeWorkPaths({ now: NOW })).resolves.toEqual({ closed: 1, created: 0 });
      expect((await repository.loadGoalProjections())[0]).toMatchObject({ openPathCount: 0 });
    });

    it("clears a map only from its active review turn after all mechanical gates pass", async () => {
      const { workbenchId } = seedGoal(fixture, { goalInputId: "goal-clear-gates", status: "CONSUMED", turn: true });
      await repository.createMap({ workbenchId, goalInputId: "goal-clear-gates", now: NOW });
      seedCompletedLayer(fixture, "goal-clear-gates", 1);
      const [digest] = await repository.listReviewDigests();
      if (digest === undefined) throw new Error("review digest missing");
      const reviewInputId = await repository.enqueueReview({ digest, now: NOW });
      if (reviewInputId === null) throw new Error("review input missing");
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES ('turn-review-clear', ?, ?, 'review-session', 'RUNNING', ?, ?)`)
        .run(reviewInputId, workbenchId, NOW, NOW));

      expect(await repository.clearMap({ goalInputId: "goal-clear-gates", turnId: "turn-goal-clear-gates" })).toBe(false);
      seedCompletedLayer(fixture, "goal-clear-gates", 2);
      const [nextDigest] = await repository.listReviewDigests();
      if (nextDigest === undefined) throw new Error("next review digest missing");
      const nextReviewInputId = await repository.enqueueReview({ digest: nextDigest, now: NOW });
      if (nextReviewInputId === null) throw new Error("next review input missing");
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_turns
        (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
        VALUES ('turn-review-clear-current', ?, ?, 'review-session-current', 'RUNNING', ?, ?)`)
        .run(nextReviewInputId, workbenchId, NOW, NOW));
      expect(await repository.clearMap({ goalInputId: "goal-clear-gates", turnId: "turn-review-clear" })).toBe(false);
      const path = await repository.chartPath({
        goalInputId: "goal-clear-gates", open: { layer: 1, title: "仍未闭合" }, turnId: "turn-review-clear-current",
      });
      expect(await repository.clearMap({ goalInputId: "goal-clear-gates", turnId: "turn-review-clear-current" })).toBe(false);
      await repository.chartPath({
        close: { pathId: path.pathId, status: "CLOSED" }, goalInputId: "goal-clear-gates", turnId: "turn-review-clear-current",
      });
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_outcomes SET disposition = 'CONTINUE' WHERE input_id = 'goal-clear-gates'",
      ).run());
      expect(await repository.clearMap({ goalInputId: "goal-clear-gates", turnId: "turn-review-clear-current" })).toBe(false);
      fixture.database.transaction((connection) => connection.prepare(
        "UPDATE joi_goal_outcomes SET disposition = 'COMPLETED' WHERE input_id = 'goal-clear-gates'",
      ).run());
      expect(await repository.clearMap({ goalInputId: "goal-clear-gates", turnId: "turn-review-clear-current" })).toBe(true);
      expect(await repository.clearMap({ goalInputId: "goal-clear-gates", turnId: "turn-review-clear-current" })).toBe(false);
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW));
      expect(feed.goals[0]).toMatchObject({ canDelete: true, status: "COMPLETED" });
      expect(feed.goals[0]?.completionSummary).toBe("一层完成");
    });
  });

  describe("home feed merge", () => {
    it("merges the harness projection into goal cards and hides review inputs", async () => {
      seedGoal(fixture, { goalInputId: "goal-feed", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-feed", goalInputId: "goal-feed", now: NOW });
      await repository.nameDestination({ destination: "目的地", goalInputId: "goal-feed", turnId: "turn-goal-feed" });
      await repository.chartPath({ goalInputId: "goal-feed", open: { layer: 1, title: "路径" }, turnId: "turn-goal-feed" });
      fixture.database.transaction((connection) => connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
        VALUES ('joi_harness_review:goal:goal-feed:r1', 'key-review', 'review', 'PENDING', 'workbench-goal-feed', 'goal-feed', ?, ?)`)
        .run(NOW, NOW));
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(new Date(NOW));
      expect(feed.goals.map((goal) => goal.goalId)).toEqual(["goal-feed"]);
      const harnessDto = feed.goals[0]?.harness;
      expect(harnessDto).toMatchObject({
        currentLayer: 1,
        decisionCount: 0,
        destination: "目的地",
        mapStatus: "ACTIVE",
        openPathCount: 1,
      });
      expect(harnessDto?.topPaths.map((topPath) => ({ status: topPath.status, title: topPath.title })))
        .toEqual([{ status: "OPEN", title: "路径" }]);
      expect(harnessDto?.topPaths.every((topPath) => typeof topPath.pathId === "string" && topPath.pathId.length > 0)).toBe(true);
    });
  });

  describe("goal projections", () => {
    it("projects destination, counts, fog and top paths for the home feed", async () => {
      seedGoal(fixture, { goalInputId: "goal-projection", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-projection", goalInputId: "goal-projection", now: NOW });
      await repository.nameDestination({ destination: "目的地", goalInputId: "goal-projection", turnId: "turn-goal-projection" });
      await repository.chartPath({ goalInputId: "goal-projection", open: { layer: 1, title: "路径一" }, turnId: "turn-goal-projection" });
      await repository.chartPath({ goalInputId: "goal-projection", open: { layer: 2, title: "路径二" }, turnId: "turn-goal-projection" });
      await repository.noteFog({ goalInputId: "goal-projection", note: "雾区一条", turnId: "turn-goal-projection" });
      const projections = await repository.loadGoalProjections();
      expect(projections).toHaveLength(1);
      const projection = projections[0];
      if (projection === undefined) throw new Error("projection missing");
      expect(projection).toMatchObject({
        currentLayer: 2,
        decisionCount: 0,
        destination: "目的地",
        fogCount: 1,
        goalInputId: "goal-projection",
        mapStatus: "ACTIVE",
        openPathCount: 2,
        revision: 4,
        topFogNote: "雾区一条",
      });
      expect(projection.topPaths.map((topPath) => ({ status: topPath.status, title: topPath.title }))).toEqual([
        { status: "OPEN", title: "路径二" },
        { status: "OPEN", title: "路径一" },
      ]);
      expect(projection.topPaths.every((topPath) => typeof topPath.pathId === "string" && topPath.pathId.length > 0)).toBe(true);
    });

    it("shows a re-charted same-title path once, keeping the deepest layer", async () => {
      seedGoal(fixture, { goalInputId: "goal-dedup", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-dedup", goalInputId: "goal-dedup", now: NOW });
      await repository.nameDestination({ destination: "目的地", goalInputId: "goal-dedup", turnId: "turn-goal-dedup" });
      await repository.chartPath({ goalInputId: "goal-dedup", open: { layer: 1, title: "同一路径" }, turnId: "turn-goal-dedup" });
      await repository.chartPath({ goalInputId: "goal-dedup", open: { layer: 2, title: "同一路径" }, turnId: "turn-goal-dedup" });
      await repository.chartPath({ goalInputId: "goal-dedup", open: { layer: 2, title: "另一条" }, turnId: "turn-goal-dedup" });
      const projection = (await repository.loadGoalProjections()).find((candidate) => candidate.goalInputId === "goal-dedup");
      if (projection === undefined) throw new Error("projection missing");
      expect(projection.topPaths.map((topPath) => ({ status: topPath.status, title: topPath.title }))).toEqual([
        { status: "OPEN", title: "另一条" },
        { status: "OPEN", title: "同一路径" },
      ]);
    });
  });

  describe("stalled synthesis recovery", () => {
    it("finds and re-drives a synthesis that no other scan can reach", async () => {
      const goalInputId = "goal-stalled-synthesis";
      seedGoal(fixture, { goalInputId, status: "CONSUMED", turn: true });
      seedCompletedLayer(fixture, goalInputId, 3);
      const staleAt = "2026-08-06T09:00:00.000Z";
      fixture.database.transaction((connection) => {
        // A later revision landed after the goal's synthesis had already run and been consumed, so
        // review and continuation both skip it — nothing else would ever revisit the goal.
        connection.prepare("UPDATE joi_goal_result_sets SET revision = 4, updated_at = ? WHERE original_input_id = ?").run(NOW, goalInputId);
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, result_revision, goal_input_id, created_at, updated_at)
          VALUES (?, 'key-synth-stalled', 'synthesize', 'CONSUMED', 3, ?, ?, ?)`)
          .run(`joi_result_input:goal:${goalInputId}`, goalInputId, staleAt, staleAt);
      });

      const stalled = await repository.listStalledSyntheses({ cooldownMillis: 10 * 60_000, now: NOW });
      expect(stalled).toEqual([{ goalInputId, resultRevision: 4 }]);

      const [seed] = stalled;
      if (seed === undefined) throw new Error("expected a stalled synthesis seed");
      await expect(repository.redriveSynthesis({ now: NOW, seed })).resolves.toBe(true);
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT status, result_revision FROM joi_inbox_messages WHERE input_id = ?")
        .get(`joi_result_input:goal:${goalInputId}`)))
        .toEqual({ result_revision: 4, status: "PENDING" });

      // Re-driving moves it, so the cooldown holds the next scan off until the attempt has run.
      await expect(repository.listStalledSyntheses({ cooldownMillis: 10 * 60_000, now: NOW })).resolves.toEqual([]);
    });

    it("leaves a goal alone while it is still waiting on the user or its Work", async () => {
      const goalInputId = "goal-stalled-guarded";
      seedGoal(fixture, { goalInputId, status: "CONSUMED", turn: true });
      seedCompletedLayer(fixture, goalInputId, 3);
      const staleAt = "2026-08-06T09:00:00.000Z";
      fixture.database.transaction((connection) => {
        connection.prepare("UPDATE joi_goal_result_sets SET revision = 4, updated_at = ? WHERE original_input_id = ?").run(NOW, goalInputId);
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, result_revision, goal_input_id, created_at, updated_at)
          VALUES (?, 'key-synth-guarded', 'synthesize', 'CONSUMED', 3, ?, ?, ?)`)
          .run(`joi_result_input:goal:${goalInputId}`, goalInputId, staleAt, staleAt);
        connection.prepare(`INSERT INTO work_items
          (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-still-running', ?, ?, '还在跑', '{}', 'READ', 'RUNNING', ?, ?)`)
          .run(`workbench-${goalInputId}`, goalInputId, NOW, NOW);
      });

      await expect(repository.listStalledSyntheses({ cooldownMillis: 10 * 60_000, now: NOW })).resolves.toEqual([]);
    });
  });
});
