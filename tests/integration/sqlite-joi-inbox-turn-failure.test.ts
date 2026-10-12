import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import type { RuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

const NOW = "2026-09-25T23:19:45.000Z";

/**
 * Seeds a result-synthesis input mid-flight: the goal's Work is all terminal, a synthesis has run
 * for earlier revisions, and the turn for the current revision has just failed.
 */
function seedFailingSynthesis(database: RuntimeDatabase, inputId: string, failingTurnSideEffects: boolean): void {
  database.transaction((connection) => {
    connection.prepare(`INSERT INTO joi_inbox_messages
      (input_id, idempotency_key, body, status, result_revision, created_at, updated_at)
      VALUES (?, ?, 'synthesize the goal', 'PENDING', 24, ?, ?)`).run(inputId, `key:${inputId}`, NOW, NOW);
    const insertTurn = connection.prepare(`INSERT INTO joi_turns
      (turn_id, input_id, workbench_id, session_id, status, side_effect_started, created_at, updated_at)
      VALUES (?, ?, NULL, 'joi_synthesis_session', 'RUNNING', ?, ?, ?)`);
    // An earlier revision's synthesis turn dispatched work. The input row is shared across every
    // revision, so this historical fact used to decide the fate of later, unrelated failures.
    insertTurn.run("turn_earlier_revision", inputId, 1, NOW, NOW);
    insertTurn.run("turn_failing", inputId, failingTurnSideEffects ? 1 : 0, NOW, NOW);
  });
}

describe("sqlite joi inbox turn failure", () => {
  it.each(["live-work", "canceled", "clarification", "answer", "no-side-effects"] as const)("keeps %s lifecycle authoritative when recording a dispatch failure", async (state) => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const workbench = await fixture.workbenchRegistry.create({ name: "Evidence", personaSummary: "Careful", projectLabel: "Test", scopeSummary: "Test" });
      const now = fixture.clock.now().toISOString();
      await repository.create({ inputId: "goal-protected", idempotencyKey: "goal-protected", body: "Read references.", workbenchId: workbench.workbenchId,
        status: "PENDING", createdAt: now, updatedAt: now });
      await repository.createTurn({ inputId: "goal-protected", turnId: "turn-protected", sessionId: "session", createdAt: now, workbenchId: workbench.workbenchId });
      if (state !== "no-side-effects") await repository.recordTurnProgress("turn-protected", { formalOutputStarted: false, sideEffectStarted: true });
      if (state === "live-work") fixture.database.transaction(connection => connection.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES ('running-work', ?, 'goal-protected', 'Read', '{}', 'READ', 'RUNNING', ?, ?)`).run(workbench.workbenchId, now, now));
      if (state === "canceled") await repository.cancel("goal-protected");
      if (state === "clarification") await repository.requireClarification("goal-protected", "question_required", "Which date?");
      if (state === "answer") await repository.completeInput("goal-protected", "turn-protected", { outcome: "DIRECT_ANSWER", completionSummary: "Evidence returned.", committedByTool: true });

      await repository.failTurn("goal-protected", "turn-protected", { reasonCode: "work_acceptance_checks_required" });
      const current = (await repository.list()).find(row => row.inputId === "goal-protected");
      expect(current?.failureReasonCode).toBeUndefined();
      expect(current?.status).toBe(state === "clarification" ? "CLARIFICATION_REQUIRED" : state === "no-side-effects" ? "PENDING" : "CONSUMED");
      if (state === "live-work") expect(await repository.retry("goal-protected", {})).toBeNull();
      if (state === "canceled") expect(current?.canceledAt).toBe(now);
    } finally {
      await fixture.close();
    }
  });

  it("persists a consumed goal's safe dispatch failure and continues it only on user retry", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const now = fixture.clock.now().toISOString();
      const workbench = await fixture.workbenchRegistry.create({ name: "Evidence", personaSummary: "Careful", projectLabel: "Test", scopeSummary: "Test" });
      await repository.create({ inputId: "goal-rejected", idempotencyKey: "goal-rejected", body: "Read references.", status: "PENDING", createdAt: now, updatedAt: now });
      await repository.createTurn({ inputId: "goal-rejected", turnId: "turn-rejected", sessionId: "session", createdAt: now, workbenchId: workbench.workbenchId });
      await repository.recordTurnProgress("turn-rejected", { formalOutputStarted: false, sideEffectStarted: true });
      await repository.failTurn("goal-rejected", "turn-rejected", { reasonCode: "work_acceptance_checks_required" });
      expect((await repository.list()).find(row => row.inputId === "goal-rejected"))
        .toMatchObject({ status: "CONSUMED", failureCount: 1, failureReasonCode: "work_acceptance_checks_required", failedAt: now });
      fixture.clock.advance(1000);
      await repository.failTurn("goal-rejected", "turn-rejected", { reasonCode: "work_acceptance_checks_required" });
      expect((await repository.list()).find(row => row.inputId === "goal-rejected"))
        .toMatchObject({ failureCount: 1, failedAt: now });
      expect(await repository.retry("goal-rejected", {})).toMatchObject({ status: "PENDING" });
      expect((await repository.list()).find(row => row.inputId === "goal-rejected")?.failureReasonCode).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("re-drives a failed synthesis instead of consuming it out of reach", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inputId = "joi_result_input:goal:goal_stalled";
      seedFailingSynthesis(fixture.database, inputId, false);

      await repository.failTurn(inputId, "turn_failing", { reasonCode: "reasoning_stream_error" });

      // Consuming it left the goal parked in FINALIZING with no retry, no card and no user path.
      expect((await repository.loadInput(inputId))?.status).toBe("PENDING");
      // Parked rows are the ones carrying the crash-loop breaker's markers.
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT failed_at, failure_count FROM joi_inbox_messages WHERE input_id = ?").get(inputId)))
        .toEqual({ failed_at: null, failure_count: null });
    } finally {
      fixture.database.close();
    }
  });

  it("still consumes a failed synthesis whose own turn started side effects", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inputId = "joi_result_input:goal:goal_side_effects";
      seedFailingSynthesis(fixture.database, inputId, true);

      await repository.failTurn(inputId, "turn_failing", { reasonCode: "reasoning_stream_error" });

      // Replaying a turn that already committed side effects is a double-dispatch hazard.
      expect((await repository.loadInput(inputId))?.status).toBe("CONSUMED");
      expect((await repository.list()).find(row => row.inputId === inputId)?.failedAt).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });
});
