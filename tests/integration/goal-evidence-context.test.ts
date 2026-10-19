import { DatabaseSync } from "node:sqlite";
import { SqliteGoalEvidenceRepository, loadGoalEvidenceCatalog } from "../../src/main/infrastructure/persistence/sqlite-goal-evidence-repository.js";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { WorkResultService } from "../../src/main/application/work/work-result-service.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";

/** A disposable SQLite fixture exercises the evidence adapter independently of Electron userData. */
function fixture() {
  const connection = new DatabaseSync(":memory:");
  connection.exec(`
    CREATE TABLE work_items(work_id TEXT,input_id TEXT,workbench_id TEXT,title TEXT,intent_json TEXT,status TEXT,created_at TEXT);
    CREATE TABLE dispatch_attempts(work_id TEXT,action_id TEXT,created_at TEXT);
    CREATE TABLE work_results(action_id TEXT,artifacts_json TEXT DEFAULT '[]',result_id TEXT,work_id TEXT,workbench_id TEXT,body_ref TEXT,status TEXT,is_late INTEGER,is_authoritative INTEGER,created_at TEXT);
    CREATE TABLE work_result_bodies(body_ref TEXT,body TEXT);
    CREATE TABLE work_result_verifications(result_id TEXT,status TEXT,reason_code TEXT);
    CREATE TABLE joi_inbox_messages(input_id TEXT,workbench_id TEXT);
    CREATE TABLE joi_goal_outcomes(input_id TEXT,result_revision INTEGER,disposition TEXT,completion_summary TEXT,requirements_revision INTEGER);
    CREATE TABLE joi_goal_outcome_history(goal_input_id TEXT,result_revision INTEGER,requirements_revision INTEGER,disposition TEXT,completion_summary TEXT);
    CREATE TABLE work_dependencies(work_id TEXT,depends_on_work_id TEXT);
    CREATE TABLE work_run_directories(work_id TEXT,workbench_id TEXT,status TEXT,root_path TEXT);
    CREATE TABLE workbench_context_snapshots(context_snapshot_id TEXT,workbench_id TEXT,work_id TEXT,persona_revision_id TEXT,workspace_ref TEXT,safe_context_json TEXT,memory_summary_refs_json TEXT,created_at TEXT);
    INSERT INTO joi_inbox_messages VALUES ('goal','bench'),('other-goal','bench');
    INSERT INTO joi_goal_outcomes VALUES ('goal',7,'CONTINUE','latest conclusion',2);
    INSERT INTO joi_goal_outcome_history VALUES ('goal',6,2,'CONTINUE','older conclusion tail'),('goal',7,2,'CONTINUE','latest conclusion');
  `);
  for (let n = 0; n < 163; n++) {
    connection.prepare("INSERT INTO work_items VALUES (?,?,?,'Work','{}','COMPLETED',?)").run(`w${String(n)}`,"goal","bench",String(n));
    connection.prepare("INSERT INTO work_results(result_id,work_id,workbench_id,body_ref,status,is_late,is_authoritative,created_at,action_id) VALUES (?,?,?,?,?,0,1,?,?)").run(`r${String(n)}`,`w${String(n)}`,"bench",`b${String(n)}`,"COMPLETED",String(n).padStart(4,"0"),`a${String(n)}`);
    connection.prepare("INSERT INTO dispatch_attempts VALUES (?,?,?)").run(`w${String(n)}`,`a${String(n)}`,String(n));
    connection.prepare("INSERT INTO work_result_bodies VALUES (?,?)").run(`b${String(n)}`,`body-${String(n)}:` + "x".repeat(9000) + ` conclusion-${String(n)}`);
    connection.prepare("INSERT INTO work_result_verifications VALUES (?,'PASSED',NULL)").run(`r${String(n)}`);
  }
  connection.prepare("INSERT INTO work_items VALUES ('current','goal','bench','Current',?,'READY','now')").run(JSON.stringify({ evidenceResultIds: ["r81"] }));
  connection.exec("INSERT INTO work_dependencies VALUES ('current','w80'),('w80','w79'); UPDATE work_results SET is_late=1,status='FAILED' WHERE result_id='r81'; UPDATE work_result_verifications SET status='FAILED' WHERE result_id='r81'");
  const safeContext = { activeWork: [],workbenchName: "bench",projectLabel: "project",recentResults: [],responsibility: "requirements must remain",work: { accessMode: "READ",title: "Current",workId: "current" } };
  connection.prepare("INSERT INTO workbench_context_snapshots VALUES ('snapshot','bench','current','persona',NULL,?,'[]','now')").run(JSON.stringify(safeContext));
  const database = { transaction<T>(operation: (db: DatabaseSync) => T): T { return operation(connection); } };
  return { connection,database };
}

describe("AC-43/48/53 goal evidence persistence", () => {
  it("retains all 163 result identities in a goal-scoped paginated index and rereads middle evidence", async () => {
    const { connection,database } = fixture();
    try {
      const evidence = new SqliteGoalEvidenceRepository(database);
      let cursor: string | undefined;
      let content = "";
      do {
        const page = await evidence.index({ goalInputId: "goal",workbenchId: "bench",...(cursor === undefined ? {} : { cursor }) });
        expect(page.content.length).toBeLessThanOrEqual(8000);
        content += page.content; cursor = page.nextCursor;
      } while (cursor !== undefined);
      const index = JSON.parse(content) as { results: { resultId: string; status: string; isLate: boolean; verificationStatus: string }[] };
      expect(index.results).toHaveLength(163);
      expect(index.results.find(r => r.resultId === "r81")).toMatchObject({ status: "FAILED",isLate: true,verificationStatus: "FAILED" });
      const service = new WorkResultService(new SqliteWorkResultRepository(database),evidence);
      const first = await service.read({ goalInputId: "goal",workbenchId: "bench",resultId: "r81" });
      expect(first.nextCursor).toBe("8000");
      expect(first.identity).toMatchObject({ status: "FAILED",isLate: true });
      const tail = await service.read({ goalInputId: "goal",workbenchId: "bench",resultId: "r81",cursor: first.nextCursor ?? "8000" });
      expect(tail.content).toContain("conclusion-81");
      await expect(service.read({ goalInputId: "other-goal",workbenchId: "bench",resultId: "r81" })).rejects.toMatchObject({ code: "work_evidence_reference_invalid" });
      await expect(evidence.assertReferences({ goalInputId: "goal",workbenchId: "foreign",resultIds: ["r81"] })).rejects.toMatchObject({ code: "work_evidence_reference_invalid" });
      await expect(evidence.readConclusion({ goalInputId: "goal",workbenchId: "bench",outcomeId: "r6:q2" })).resolves.toMatchObject({ content: "older conclusion tail" });
      expect(loadGoalEvidenceCatalog(connection,{ goalInputId: "goal",workbenchId: "bench" }).conclusions).toHaveLength(2);
      connection.exec("UPDATE joi_goal_outcomes SET disposition='ACCEPTED_WITH_GAPS',completion_summary='accepted latest conclusion' WHERE input_id='goal'");
      const changed = loadGoalEvidenceCatalog(connection,{ goalInputId: "goal",workbenchId: "bench" }).conclusions;
      expect(changed[0]).toMatchObject({ outcomeId: "r7:q2:current",disposition: "ACCEPTED_WITH_GAPS",body: "accepted latest conclusion" });
      expect(changed.some(c => c.outcomeId === "r7:q2" && c.disposition === "CONTINUE")).toBe(true);
      connection.exec("UPDATE joi_goal_outcomes SET disposition='CONTINUE',completion_summary='latest conclusion' WHERE input_id='goal'");
      connection.exec("INSERT INTO joi_goal_outcome_history VALUES ('goal',7,1,'CONTINUE','latest conclusion')");
      expect(loadGoalEvidenceCatalog(connection,{ goalInputId: "goal",workbenchId: "bench" }).conclusions.map(c => c.outcomeId)).toEqual(["r7:q2","r7:q1","r6:q2"]);
      await expect(evidence.index({ goalInputId: "goal",workbenchId: "bench",cursor: "2junk" })).rejects.toMatchObject({ code: "work_result_cursor_invalid" });
    } finally { connection.close(); }
  });

  it("authorizes legacy unbound goals only through Work in the requested Workbench", async () => {
    const { connection,database } = fixture();
    try {
      connection.exec("UPDATE joi_inbox_messages SET workbench_id=NULL WHERE input_id='goal'");
      const evidence = new SqliteGoalEvidenceRepository(database);
      await expect(evidence.readConclusion({ goalInputId: "goal",workbenchId: "bench",outcomeId: "r6:q2" })).resolves.toMatchObject({ content: "older conclusion tail" });
      const catalog = loadGoalEvidenceCatalog(connection,{ goalInputId: "goal",workbenchId: "bench" });
      expect(catalog.conclusions).toHaveLength(2);
      connection.exec("UPDATE joi_goal_outcomes SET completion_summary='current legacy conclusion' WHERE input_id='goal'");
      await expect(evidence.readConclusion({ goalInputId: "goal",workbenchId: "bench",outcomeId: "r7:q2:current" })).resolves.toMatchObject({ content: "current legacy conclusion" });
      expect(loadGoalEvidenceCatalog(connection,{ goalInputId: "goal",workbenchId: "foreign" }).conclusions).toHaveLength(0);
      await expect(evidence.readConclusion({ goalInputId: "goal",workbenchId: "foreign",outcomeId: "r6:q2" })).rejects.toMatchObject({ code: "goal_evidence_not_found" });
      connection.exec("UPDATE joi_inbox_messages SET workbench_id='different-bound-bench' WHERE input_id='goal'");
      expect(loadGoalEvidenceCatalog(connection,{ goalInputId: "goal",workbenchId: "bench" }).conclusions).toHaveLength(0);
    } finally { connection.close(); }
  });

  it("hydrates only selected bodies at execution boundaries while exposing all history as input files", async () => {
    const { connection,database } = fixture();
    try {
      const repository = new SqliteWorkbenchContextRepository(database);
      const execution = await repository.loadForExecution("snapshot");
      expect(execution?.evidence?.inline.length).toBeGreaterThan(24_000);
      expect(execution?.evidence?.inline.length).toBeLessThanOrEqual(40_000);
      expect(execution?.evidence?.inline).toContain("body-81:");
      expect(execution?.evidence?.inline).toContain("body-80:");
      expect(execution?.evidence?.inline).not.toContain("body-0:");
      expect(execution?.promptSection).toContain("requirements must remain");
      expect(execution?.promptSection).toContain(execution?.evidence?.inline);
      expect(execution?.evidence?.selfContainedInline).toContain("conclusion-81");
      expect(execution?.evidence?.selfContainedInline).toContain("conclusion-80");
      expect(execution?.evidence?.selfContainedInline).not.toContain("work_read_evidence");
      expect(execution?.evidence?.selfContainedInline).not.toContain("work_read_result");
      expect(execution?.evidence?.files).toHaveLength(165);
      expect(execution?.evidence?.files.some(f => f.body.includes("body-0:"))).toBe(true);
      expect(execution?.evidence).toEqual((await repository.loadForExecution("snapshot"))?.evidence);
      for (const n of [79,80,81]) connection.prepare("UPDATE work_result_bodies SET body=? WHERE body_ref=?").run("x".repeat(14_000) + ` conclusion-${String(n)}`,`b${String(n)}`);
      const expanded = await repository.loadForExecution("snapshot");
      expect(expanded?.evidence?.inline.length).toBeGreaterThan(40_000);
      expect(expanded?.evidence?.inline.length).toBeLessThanOrEqual(60_000);
      expect(expanded?.evidence?.inline).toContain("conclusion-81");
      connection.exec("UPDATE work_items SET intent_json='{}' WHERE work_id='current'; DELETE FROM work_dependencies");
      expect((await repository.loadForExecution("snapshot"))?.evidence?.inline.length).toBeLessThanOrEqual(24_000);
    } finally { connection.close(); }
  });
});
