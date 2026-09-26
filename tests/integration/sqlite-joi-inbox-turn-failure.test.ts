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
  it("re-drives a failed synthesis instead of consuming it out of reach", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const repository = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      const inputId = "joi_result_input:goal:goal_stalled";
      seedFailingSynthesis(fixture.database, inputId, false);

      await repository.failTurn(inputId, "turn_failing");

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

      await repository.failTurn(inputId, "turn_failing");

      // Replaying a turn that already committed side effects is a double-dispatch hazard.
      expect((await repository.loadInput(inputId))?.status).toBe("CONSUMED");
    } finally {
      fixture.database.close();
    }
  });
});
