import { DatabaseSync } from "node:sqlite";
import { loadGoalSynthesisContext } from "../../src/main/infrastructure/persistence/sqlite-goal-result-synthesis.js";

describe("synthesis delta evidence identity", () => {
  it("keeps absent acceptance UNVERIFIED and includes invalidated references when their Work gets a new result", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE joi_inbox_messages(input_id TEXT,workbench_id TEXT,body TEXT);
        CREATE TABLE joi_goal_outcomes(input_id TEXT,result_revision INTEGER,disposition TEXT,completion_summary TEXT,updated_at TEXT,requirements_revision INTEGER,synthesis_state_json TEXT);
        CREATE TABLE joi_goal_result_members(original_input_id TEXT,event_id TEXT,revision INTEGER);
        CREATE TABLE partner_result_events(event_id TEXT,run_id TEXT,work_id TEXT,status TEXT);
        CREATE TABLE work_results(result_id TEXT,run_id TEXT,work_id TEXT,status TEXT,summary TEXT,is_late INTEGER,is_authoritative INTEGER);
        CREATE TABLE work_items(work_id TEXT,workbench_id TEXT,input_id TEXT);
        CREATE TABLE work_result_verifications(result_id TEXT,status TEXT,created_at TEXT);
        INSERT INTO joi_inbox_messages VALUES ('goal','bench','MANDATORY');
        INSERT INTO joi_goal_outcomes VALUES ('goal',1,'CONTINUE','previous conclusion','2026-10-19T00:00:00Z',0,NULL);
        INSERT INTO work_items VALUES ('work','bench','goal');
        INSERT INTO work_results VALUES ('old','run-old','work','COMPLETED','previous evidence',0,0),('new','run-new','work','COMPLETED','new evidence',0,1);
        INSERT INTO work_result_verifications VALUES ('old','PASSED','2026-10-18T00:00:00Z');
        INSERT INTO partner_result_events VALUES ('event-old','run-old','work','COMPLETED'),('event-new','run-new','work','COMPLETED');
        INSERT INTO joi_goal_result_members VALUES ('goal','event-old',1),('goal','event-new',2);
      `);
      const snapshot = loadGoalSynthesisContext(db, "goal", "bench", 2, 1);
      expect(snapshot?.changedResults.find(result => result.resultId === "new")).toMatchObject({ verification: "UNVERIFIED" });
      expect(snapshot?.changedResults.find(result => result.resultId === "old")).toMatchObject({ isAuthoritative: false });
      expect(snapshot?.gapCount).toBe(2);
      expect(loadGoalSynthesisContext(db, "goal", "other-bench", 2, 1)).toBeUndefined();
    } finally { db.close(); }
  });
});
