import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("persisted joi Turn completions", () => {
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
      });
      const inbox = new SqliteJoiInboxRepository(fixture.database);
      await (inbox.completeInput as unknown as (
        inputId: string,
        turnId: string,
        completion: { completionSummary: string; outcome: "DIRECT_ANSWER" },
      ) => Promise<unknown>)("input-direct", "turn-direct", {
        completionSummary: "## 身份\n\n我是 Joi。 token=abcdefghijklmnop C:\\private\\answer.md",
        outcome: "DIRECT_ANSWER",
      });

      const persisted = fixture.database.transaction((connection) => connection.prepare(`SELECT input_id, turn_id,
        outcome_kind, completion_summary FROM joi_turn_completions WHERE input_id = 'input-direct'`).get());
      expect(persisted).toEqual({
        completion_summary: "## 身份\n\n我是 Joi。 token=[redacted] [redacted-path]",
        input_id: "input-direct",
        outcome_kind: "DIRECT_ANSWER",
        turn_id: "turn-direct",
      });
      const feed = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(feed.goals).toEqual([expect.objectContaining({
        completionSummary: "## 身份\n\n我是 Joi。 token=[redacted]",
        goalId: "input-direct",
        status: "COMPLETED",
        work: { active: 0, completed: 0, failed: 0, total: 0 },
      })]);

      await inbox.retry("input-direct", {});
      const retrying = await new SqliteJoiHomeFeedRepository(fixture.database).load(fixture.clock.now());
      expect(retrying.goals[0]).toMatchObject({ goalId: "input-direct", status: "ARRANGING" });
      expect(retrying.goals[0]?.completionSummary).toBeUndefined();
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
