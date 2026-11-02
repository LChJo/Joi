import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

const NOW = "2026-11-02T00:00:00.000Z";
const LATER = "2026-11-02T00:01:00.000Z";

async function setup() {
  const fixture = await createRuntimeFixture();
  fixture.database.transaction((db) => {
    db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,
      project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('wb','Fixture','p','private persona','scope','project','m','ACTIVE',?,?)`).run(NOW, NOW);
    for (const id of ["goal", "other"]) {
      db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES (?,?,?,'CONSUMED','wb',?,?)`).run(id, id, "Fixture goal", NOW, NOW);
      db.prepare(`INSERT INTO joi_harness_maps (goal_input_id,workbench_id,status,revision,reviewed_revision,created_at,updated_at)
        VALUES (?,'wb','ACTIVE',1,0,?,?)`).run(id, NOW, NOW);
    }
  });
  const addTurn = (inputId: string, goalId: string, status: string, index = 0) => fixture.database.transaction((db) => {
    db.prepare(`INSERT OR IGNORE INTO joi_inbox_messages
      (input_id,idempotency_key,body,status,workbench_id,goal_input_id,created_at,updated_at)
      VALUES (?,?,'token=private-payload','CONSUMED','wb',?,?,?)`).run(inputId, inputId, goalId, NOW, LATER);
    db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
      VALUES (?,?,'wb','private-session',?,?,?)`).run(`turn-${inputId}-${String(index)}`, inputId, status, NOW, LATER);
  });
  return { fixture, addTurn, repository: new SqliteJoiHomeFeedRepository(fixture.database) };
}

describe("JOI's goal-scoped progress (AC-44/48/53/67)", () => {
  it("distinguishes a queued review from execution and includes only bounded safe turn facts", async () => {
    const { fixture, addTurn, repository } = await setup();
    try {
      for (let i = 0; i < 15; i++) addTurn(`joi_harness_review:goal:goal:r${String(i + 1)}`, "goal", "COMPLETED", i);
      addTurn("joi_harness_review:goal:other:r99", "other", "RUNNING");
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,goal_input_id,created_at,updated_at)
        VALUES ('joi_harness_review:goal:goal:r16','queued','cookie=private-queued','PENDING','wb','goal',?,?)`).run(LATER, LATER));
      const progress = (await repository.loadGoalDetail("goal", {}))?.harness?.progress;
      expect(progress).toMatchObject({ state: "QUEUED", stage: "REVIEWING", turnCount: 15, reviewCount: 15, updatedAt: LATER });
      expect(progress?.recentTurns).toHaveLength(12);
      expect(progress?.recentTurns.every((turn) => turn.status === "COMPLETED")).toBe(true);
      const serialized = JSON.stringify(progress);
      for (const secret of ["private-payload", "private-session", "private persona", "private-queued", "other:r99"]) expect(serialized).not.toContain(secret);
    } finally { await fixture.close(); }
  });

  it("reports a live synthesis and updates when its turn ends without pretending the map is complete", async () => {
    const { fixture, addTurn, repository } = await setup();
    try {
      addTurn("joi_result_input:goal:goal", "goal", "RUNNING");
      let progress = (await repository.loadGoalDetail("goal", {}))?.harness?.progress;
      expect(progress).toMatchObject({ state: "RUNNING", stage: "FINALIZING", recentTurns: [{ status: "RUNNING", stage: "FINALIZING", startedAt: NOW, updatedAt: LATER }] });
      fixture.database.transaction((db) => db.prepare("UPDATE joi_turns SET status='COMPLETED' WHERE input_id='joi_result_input:goal:goal'").run());
      progress = (await repository.loadGoalDetail("goal", {}))?.harness?.progress;
      expect(progress?.state).toBe("IDLE");
      expect(progress?.recentTurns[0]?.status).toBe("COMPLETED");
    } finally { await fixture.close(); }
  });

  it("shows partner waiting, user waiting and cancellation from durable facts", async () => {
    const { fixture, addTurn, repository } = await setup();
    try {
      addTurn("goal", "goal", "COMPLETED");
      fixture.database.transaction((db) => db.prepare(`INSERT INTO work_items
        (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
        VALUES ('work','wb','goal','private work','{}','READ','RUNNING',?,?)`).run(NOW, LATER));
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress).toMatchObject({ state: "WAITING_PARTNERS", work: { active: 1, total: 1 } });
      addTurn("goal", "goal", "WAITING", 1);
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("WAITING_PARTNERS");
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_goal_execution_gates
        (goal_input_id,question_id,question_version,status,reason_code,created_at,updated_at)
        VALUES ('goal','q',1,'WAITING_INPUT','partner_question',?,?)`).run(NOW, LATER));
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("WAITING_USER");
      fixture.database.transaction((db) => db.prepare("UPDATE joi_inbox_messages SET canceled_at=? WHERE input_id='goal'").run(LATER));
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("CANCELED");
    } finally { await fixture.close(); }
  });

  it("reports a current blocked outcome as stopped and never completes a map whose result is uncommitted", async () => {
    const { fixture, addTurn, repository } = await setup();
    try {
      addTurn("joi_result_input:goal:goal", "goal", "COMPLETED");
      fixture.database.transaction((db) => {
        db.prepare(`INSERT INTO joi_goal_result_sets (original_input_id,revision,synthesized_revision,updated_at)
          VALUES ('goal',1,1,?)`).run(LATER);
        db.prepare(`INSERT INTO joi_goal_outcomes
          (input_id,result_revision,completion_summary,completed_at,updated_at,disposition)
          VALUES ('goal',1,'private blocked result',?,?,'BLOCKED')`).run(LATER, LATER);
      });
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("FAILED");
      fixture.database.transaction((db) => {
        db.prepare("DELETE FROM joi_goal_outcomes WHERE input_id='goal'").run();
        db.prepare("UPDATE joi_harness_maps SET status='CLEARED',reviewed_revision=1 WHERE goal_input_id='goal'").run();
      });
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("IDLE");
      fixture.database.transaction((db) => {
        db.prepare(`INSERT INTO joi_goal_outcomes
          (input_id,result_revision,completion_summary,completed_at,updated_at,disposition)
          VALUES ('goal',1,'retained closed lifecycle',?,?,'CONTINUE')`).run(LATER, LATER);
        db.prepare("UPDATE joi_harness_maps SET reviewed_revision=0 WHERE goal_input_id='goal'").run();
      });
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("COMPLETED");
    } finally { await fixture.close(); }
  });

  it("shows parked current synthesis failure as stopped rather than promising automatic recovery", async () => {
    const { fixture, addTurn, repository } = await setup();
    try {
      addTurn("joi_result_input:goal:goal", "goal", "FAILED");
      fixture.database.transaction((db) => {
        db.prepare(`INSERT INTO joi_goal_result_sets (original_input_id,revision,synthesized_revision,synthetic_input_id,updated_at)
          VALUES ('goal',1,0,'joi_result_input:goal:goal',?)`).run(LATER);
        db.prepare("UPDATE joi_inbox_messages SET failed_at=?,result_revision=1 WHERE input_id='joi_result_input:goal:goal'").run(LATER);
      });
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("FAILED");
      fixture.database.transaction((db) => db.prepare("UPDATE joi_goal_result_sets SET revision=2 WHERE original_input_id='goal'").run());
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("IDLE");
    } finally { await fixture.close(); }
  });

  it("does not promise automatic recovery for a failed planning turn without queued work", async () => {
    const { fixture, addTurn, repository } = await setup();
    try {
      addTurn("goal", "goal", "FAILED");
      expect((await repository.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("FAILED");
    } finally { await fixture.close(); }
  });
});
