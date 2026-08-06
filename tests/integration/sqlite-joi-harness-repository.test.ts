import { DomainError } from "../../src/main/domain/errors";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository";
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

function seedCompletedLayer(fixture: RuntimeFixture, goalInputId: string, revision: number): void {
  fixture.database.transaction((connection) => {
    connection.prepare(`INSERT INTO joi_goal_result_sets
      (original_input_id, revision, synthesized_revision, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(original_input_id) DO UPDATE SET revision = excluded.revision,
        synthesized_revision = excluded.synthesized_revision, updated_at = excluded.updated_at`)
      .run(goalInputId, revision, revision, NOW);
    connection.prepare(`INSERT INTO joi_goal_outcomes
      (input_id, result_revision, completion_summary, completed_at, updated_at)
      VALUES (?, ?, '一层完成', ?, ?)
      ON CONFLICT(input_id) DO UPDATE SET result_revision = excluded.result_revision,
        completion_summary = excluded.completion_summary, updated_at = excluded.updated_at`)
      .run(goalInputId, revision, NOW, NOW);
  });
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

    it("creates a map exactly once", async () => {
      seedGoal(fixture, { goalInputId: "goal-once", turn: true });
      expect(await repository.createMap({ workbenchId: "workbench-goal-once", goalInputId: "goal-once", now: NOW })).toBe(true);
      expect(await repository.createMap({ workbenchId: "workbench-goal-once", goalInputId: "goal-once", now: NOW })).toBe(false);
      expect(await repository.listGoalsWithoutMap()).toEqual([]);
    });
  });

  describe("completion feedback", () => {
    it("appends one entry to the workbench task summary exactly once per cleared map", async () => {
      seedGoal(fixture, { goalInputId: "goal-feedback", turn: true });
      await repository.createMap({ workbenchId: "workbench-goal-feedback", goalInputId: "goal-feedback", now: NOW });
      await repository.clearMap({ goalInputId: "goal-feedback", turnId: "turn-goal-feedback" });
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
      await repository.clearMap({ goalInputId: "goal-trim", turnId: "turn-goal-trim" });
      await repository.recordCompletionFeedback({
        workbenchId: "workbench-goal-trim", entry: "TAIL", goalInputId: "goal-trim", now: NOW,
      });
      const summary = fixture.database.transaction((connection) => connection.prepare(
        "SELECT task_summary FROM workbenches WHERE workbench_id = 'workbench-goal-trim'",
      ).get()) as { task_summary: string };
      expect(summary.task_summary).toHaveLength(2_000);
      expect(summary.task_summary.endsWith("TAIL")).toBe(true);
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
      expect(await repository.clearMap({ goalInputId: "goal-cleared", turnId: "turn-goal-cleared" })).toBe(true);
      expect(await repository.clearMap({ goalInputId: "goal-cleared", turnId: "turn-goal-cleared" })).toBe(false);
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
  });
});
