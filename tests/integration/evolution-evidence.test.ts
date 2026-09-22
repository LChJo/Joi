import { DatabaseSync } from "node:sqlite";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";

it("uses only the newest authoritative attempt when a failed Work was subsequently verified", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE workbenches(workbench_id TEXT,status TEXT);
      CREATE TABLE joi_inbox_messages(input_id TEXT,workbench_id TEXT,updated_at TEXT,canceled_at TEXT,goal_input_id TEXT,status TEXT);
      CREATE TABLE evolution_goal_pins(goal_id TEXT,eligible INTEGER);
      CREATE TABLE joi_goal_outcomes(input_id TEXT,disposition TEXT);
      CREATE TABLE evolution_evidence(goal_id TEXT);
      CREATE TABLE joi_harness_maps(goal_input_id TEXT,status TEXT);
      CREATE TABLE joi_turns(input_id TEXT,status TEXT);
      CREATE TABLE work_items(work_id TEXT,input_id TEXT,status TEXT);
      CREATE TABLE work_results(result_id TEXT,work_id TEXT,is_authoritative INTEGER,is_late INTEGER,created_at TEXT);
      CREATE TABLE work_result_verifications(result_id TEXT,status TEXT);
      INSERT INTO workbenches VALUES('a','ACTIVE');
      INSERT INTO joi_inbox_messages VALUES('g','a','2026-09-22',NULL,NULL,'CONSUMED');
      INSERT INTO evolution_goal_pins VALUES('g',1);
      INSERT INTO joi_goal_outcomes VALUES('g','COMPLETED');
      INSERT INTO work_items VALUES('w','g','COMPLETED');
      INSERT INTO work_results VALUES('old','w',1,0,'2026-09-21'),('latest','w',1,0,'2026-09-22'),('late','w',1,1,'2026-09-23');
      INSERT INTO work_result_verifications VALUES('old','FAILED'),('latest','PASSED'),('late','FAILED');
    `);
    const store = new SqliteEvolutionStore({ transaction: (operation) => operation(db) });
    expect(store.evidenceSeeds()).toEqual([{ goalId: "g", workbenchId: "a", observedAt: "2026-09-22", canceled: false, disposition: "COMPLETED", verified: 1, failed: 0, unverified: 0, workFailed: 0 }]);
    db.exec("UPDATE work_result_verifications SET status = 'NOT_REQUIRED' WHERE result_id = 'latest'");
    expect(store.evidenceSeeds()[0]).toMatchObject({ verified: 0, failed: 0, unverified: 1 });
    db.exec("UPDATE joi_goal_outcomes SET disposition = 'CONTINUE'");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("DELETE FROM joi_goal_outcomes");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("INSERT INTO joi_goal_outcomes VALUES('g','COMPLETED'); INSERT INTO joi_inbox_messages VALUES('review','a','2026-09-22',NULL,'g','PENDING')");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("UPDATE joi_inbox_messages SET status = 'CONSUMED' WHERE input_id = 'review'; INSERT INTO joi_turns VALUES('review','RUNNING')");
    expect(store.evidenceSeeds()).toEqual([]);
    db.exec("UPDATE joi_turns SET status = 'COMPLETED'");
    expect(store.evidenceSeeds()).toHaveLength(1);
  } finally { db.close(); }
});
