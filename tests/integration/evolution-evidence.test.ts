import { DatabaseSync } from "node:sqlite";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";

it("uses only the newest authoritative attempt when a failed Work was subsequently verified", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE workbenches(workbench_id TEXT,status TEXT);
      CREATE TABLE joi_inbox_messages(input_id TEXT,workbench_id TEXT,updated_at TEXT,canceled_at TEXT,goal_input_id TEXT,status TEXT,dismissed_at TEXT);
      CREATE TABLE evolution_goal_pins(goal_id TEXT,eligible INTEGER);
      CREATE TABLE joi_goal_outcomes(input_id TEXT,disposition TEXT);
      CREATE VIEW joi_current_goal_outcomes AS SELECT * FROM joi_goal_outcomes;
      CREATE TABLE evolution_evidence(goal_id TEXT,workbench_id TEXT,revision_id TEXT,outcome TEXT,cause TEXT NOT NULL DEFAULT 'unknown',observed_at TEXT,classified_at TEXT);
      CREATE TABLE joi_harness_maps(goal_input_id TEXT,status TEXT);
      CREATE TABLE joi_turns(input_id TEXT,status TEXT);
      CREATE TABLE work_items(work_id TEXT,input_id TEXT,status TEXT);
      CREATE TABLE work_results(result_id TEXT,work_id TEXT,is_authoritative INTEGER,is_late INTEGER,created_at TEXT);
      CREATE TABLE work_result_verifications(result_id TEXT,status TEXT);
      INSERT INTO workbenches VALUES('a','ACTIVE');
      INSERT INTO joi_inbox_messages VALUES('g','a','2026-09-22',NULL,NULL,'CONSUMED',NULL);
      INSERT INTO evolution_goal_pins VALUES('g',1);
      INSERT INTO joi_goal_outcomes VALUES('g','COMPLETED');
      INSERT INTO work_items VALUES('w','g','COMPLETED');
      INSERT INTO work_results VALUES('old','w',1,0,'2026-09-21'),('latest','w',1,0,'2026-09-22'),('late','w',1,1,'2026-09-23');
      INSERT INTO work_result_verifications VALUES('old','FAILED'),('latest','PASSED'),('late','FAILED');
    `);
    const store = new SqliteEvolutionStore({ transaction: (operation) => operation(db) });
    expect(store.evidenceSeeds()).toEqual([{ goalId: "g", workbenchId: "a", observedAt: "2026-09-22", canceled: false, disposition: "COMPLETED", verified: 1, failed: 0, unverified: 0, workFailed: 0 }]);
    db.exec("UPDATE work_result_verifications SET status = 'NOT_REQUIRED' WHERE result_id = 'latest'");
    // NOT_REQUIRED means no acceptance check was declared: the absence of a question, not a missing
    // answer, so it no longer counts as unverified. It does not count as verified either, so a goal
    // whose only Work is unchecked still classifies UNEVALUABLE rather than VERIFIED.
    expect(store.evidenceSeeds()[0]).toMatchObject({ verified: 0, failed: 0, unverified: 0 });
    db.exec("UPDATE joi_goal_outcomes SET disposition = 'CONTINUE'");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("DELETE FROM joi_goal_outcomes");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("INSERT INTO joi_goal_outcomes VALUES('g','COMPLETED'); INSERT INTO joi_inbox_messages VALUES('review','a','2026-09-22',NULL,'g','PENDING',NULL)");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = 'review'; INSERT INTO joi_turns VALUES('review','RUNNING')");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("UPDATE joi_turns SET status = 'COMPLETED'");
    expect(store.evidenceSeeds()).toHaveLength(1);
    // A recorded classification freezes the goal only until its facts move again: without the
    // re-sample, a premature UNEVALUABLE snapshot (taken before the first Work was dispatched)
    // would permanently mask the verification failures that follow.
    db.exec("INSERT INTO evolution_evidence VALUES('g','a',NULL,'UNEVALUABLE','unknown','2026-09-22','2026-09-22')");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("UPDATE joi_inbox_messages SET updated_at = '2026-09-24' WHERE input_id = 'g'");
    expect(store.evidenceSeeds()).toHaveLength(1);
    db.exec("UPDATE joi_goal_outcomes SET disposition = 'CONTINUE'");
    // An active hand-off is still excluded: its continuation carries the outcome, and counting both
    // would double-count one goal.
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("UPDATE joi_inbox_messages SET canceled_at = '2026-09-25' WHERE input_id = 'g'");
    // A revoked goal has no continuation left to do that, and its disposition freezes at whatever it
    // was when the user gave up. Excluding it would hide the failures that made them give up.
    expect(store.evidenceSeeds()).toHaveLength(1);
    db.exec("UPDATE joi_inbox_messages SET canceled_at = NULL, dismissed_at = '2026-09-25' WHERE input_id = 'g'");
    expect(store.evidenceSeeds()).toHaveLength(1);
  } finally { db.close(); }
});
