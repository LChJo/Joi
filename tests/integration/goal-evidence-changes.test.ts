import { DatabaseSync } from "node:sqlite";
import { loadGoalEvidenceChanges,SqliteGoalEvidenceRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-evidence-repository.js";
import { WorkResultService } from "../../src/main/application/work/work-result-service.js";
import type { WorkResultRepository } from "../../src/main/application/ports/work-results.js";

function fixture(count = 10) {
  const connection = new DatabaseSync(":memory:");
  connection.exec(`CREATE TABLE joi_inbox_messages(input_id TEXT,workbench_id TEXT);
    CREATE TABLE work_items(work_id TEXT,input_id TEXT,workbench_id TEXT);
    CREATE TABLE work_results(result_id TEXT,run_id TEXT,work_id TEXT,workbench_id TEXT,status TEXT,summary TEXT,is_late INTEGER,is_authoritative INTEGER,handoff_json TEXT,handoff_status TEXT);
    CREATE TABLE partner_result_events(event_id TEXT,run_id TEXT,work_id TEXT,status TEXT);
    CREATE TABLE joi_goal_result_members(original_input_id TEXT,event_id TEXT,revision INTEGER);
    CREATE TABLE work_result_verifications(result_id TEXT,status TEXT,created_at TEXT);
    CREATE TABLE joi_goal_outcomes(input_id TEXT,result_revision INTEGER,requirements_revision INTEGER,disposition TEXT,completion_summary TEXT,synthesis_state_json TEXT);
    CREATE TABLE joi_goal_outcome_history(goal_input_id TEXT,result_revision INTEGER,requirements_revision INTEGER,disposition TEXT,completion_summary TEXT,synthesis_state_json TEXT);
    INSERT INTO joi_inbox_messages VALUES ('goal','bench');
    INSERT INTO joi_goal_outcomes VALUES ('goal',2,1,'CONTINUE','latest','{"state":"current"}');
    INSERT INTO joi_goal_outcome_history VALUES ('goal',1,1,'CONTINUE','previous','{"state":"old"}');`);
  const handoff = (conclusion: string) => ({ version: 1,conclusion,requirementIds: ["requirement"],evidenceResultIds: [],artifactRefs: [],unresolved: [],conflicts: [] });
  const add = (revision: number,id: string,workId = id,conclusion = `Conclusion ${id}`) => {
    if (connection.prepare("SELECT 1 FROM work_items WHERE work_id=?").get(workId) === undefined) connection.prepare("INSERT INTO work_items VALUES (?,'goal','bench')").run(workId);
    connection.prepare("INSERT INTO work_results VALUES (?,?,?,'bench','COMPLETED','preview',0,1,?,'PROVIDED')").run(id,`run-${id}`,workId,JSON.stringify(handoff(conclusion)));
    connection.prepare("INSERT INTO partner_result_events VALUES (?,?,?,'COMPLETED')").run(`event-${id}`,`run-${id}`,workId);
    connection.prepare("INSERT INTO joi_goal_result_members VALUES ('goal',?,?)").run(`event-${id}`,revision);
    connection.prepare("INSERT INTO work_result_verifications VALUES (?,'PASSED','2026-10-18')").run(id);
  };
  for (let n = 1; n <= count; n++) add(n,`r${String(n).padStart(4,"0")}`);
  const database = { transaction<T>(operation: (db: DatabaseSync) => T): T { return operation(connection); } };
  return { connection,database,add };
}

describe("AC-43/48/53/67 bounded semantic synthesis evidence",() => {
  it.each([10,100,1000])("loads exactly three new semantic results after %i historical results without a bodies table",async count => {
    const f = fixture(count);
    try {
      for (let n = 1; n <= 3; n++) f.add(count + n,`new${String(n)}`);
      const page = loadGoalEvidenceChanges(f.connection,{ goalInputId: "goal",workbenchId: "bench",resultRevision: count + 3,requirementsRevision: 2,afterResultRevision: count,afterUpdatedAt: "2026-10-19" });
      expect(page.totalChanges).toBe(3);
      expect(page.changedResults.map(row => row.resultId)).toEqual(["new1","new2","new3"]);
      expect(page.changedResults[0]).toMatchObject({ handoffStatus: "PROVIDED",handoff: { conclusion: "Conclusion new1" },verification: "PASSED" });
      expect(page.nextCursor).toBeUndefined();
      await expect(new SqliteGoalEvidenceRepository(f.database).readChanges({ goalInputId: "goal",workbenchId: "other",resultRevision: count + 3,requirementsRevision: 2,afterResultRevision: count })).resolves.toMatchObject({ changedResults: [],totalChanges: 0 });
    } finally { f.connection.close(); }
  });

  it("pages deltas with changed verification and superseded results, preserving scope and version bindings",async () => {
    const f = fixture(30);
    try {
      f.add(31,"replacement","r0001");
      f.connection.exec("UPDATE work_results SET is_authoritative=0 WHERE result_id='r0001'; UPDATE work_result_verifications SET status='FAILED',created_at='2026-10-20' WHERE result_id='r0002'");
      const repository = new SqliteGoalEvidenceRepository(f.database);
      const request = { goalInputId: "goal",workbenchId: "bench",resultRevision: 31,requirementsRevision: 2,afterResultRevision: 10,afterUpdatedAt: "2026-10-19" };
      const first = await repository.readChanges(request);
      expect(first.changedResults).toHaveLength(16);
      expect(first.totalChanges).toBe(23);
      const cursor = first.nextCursor ?? "missing";
      const second = await repository.readChanges({ ...request,cursor });
      expect(second.changedResults).toHaveLength(7);
      expect(second.nextCursor).toBeUndefined();
      expect(first.changedResults[0]).toMatchObject({ resultId: "r0001",isAuthoritative: false });
      expect(first.changedResults[1]).toMatchObject({ resultId: "r0002",verification: "FAILED" });
      await expect(repository.readChanges({ ...request,requirementsRevision: 3,cursor })).rejects.toMatchObject({ code: "work_result_cursor_invalid" });
      await expect(repository.readChanges({ ...request,goalInputId: "other",cursor })).rejects.toMatchObject({ code: "work_result_cursor_invalid" });
    } finally { f.connection.close(); }
  });

  it("keeps oversized handoffs explicitly readable and pages private state without splitting Unicode",async () => {
    const f = fixture(0);
    try {
      f.add(1,"large","large","😀".repeat(2500));
      const stored = JSON.parse(f.connection.prepare("SELECT handoff_json FROM work_results WHERE result_id='large'").get()?.handoff_json as string) as Record<string,unknown>;
      f.connection.prepare("UPDATE work_results SET handoff_json=? WHERE result_id='large'").run(JSON.stringify({ ...stored,unresolved: ["😀".repeat(1000),"😀".repeat(1000)] }));
      const repository = new SqliteGoalEvidenceRepository(f.database);
      const scope = { goalInputId: "goal",workbenchId: "bench" };
      const changes = await repository.readChanges({ ...scope,resultRevision: 1,requirementsRevision: 1,afterResultRevision: 0 });
      expect(changes.changedResults[0]).toMatchObject({ handoffStatus: "PROVIDED",handoffOmitted: true,handoffRef: "large" });
      expect(changes.changedResults[0]?.handoff).toBeUndefined();
      let cursor: string | undefined;
      let restored = "";
      do {
        const page = await repository.readHandoff({ ...scope,resultId: "large",...(cursor === undefined ? {} : { cursor }) });
        expect(page.content.length).toBeLessThanOrEqual(8000);
        expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/u);
        restored += page.content; cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(JSON.parse(restored)).toMatchObject({ conclusion: "😀".repeat(2500),unresolved: ["😀".repeat(1000),"😀".repeat(1000)] });
      const stateJson = JSON.stringify({ conclusion: "😀".repeat(5000) });
      f.connection.prepare("UPDATE joi_goal_outcome_history SET synthesis_state_json=?").run(stateJson);
      let state = await repository.readState({ ...scope,outcomeId: "r1:q1" });
      expect(state).toMatchObject({ stateStatus: "PROVIDED",outcomeId: "r1:q1" });
      expect(state.content.length).toBeLessThanOrEqual(8000);
      let stateRestored = state.content;
      const stateCursor = state.nextCursor ?? "missing";
      await expect(repository.readHandoff({ ...scope,resultId: "large",cursor: stateCursor })).rejects.toMatchObject({ code: "work_result_cursor_invalid" });
      while (state.nextCursor !== undefined) {
        state = await repository.readState({ ...scope,outcomeId: "r1:q1",cursor: state.nextCursor });
        stateRestored += state.content;
      }
      expect(stateRestored).toBe(stateJson);
      await expect(repository.readState({ ...scope,workbenchId: "other",outcomeId: "r1:q1" })).rejects.toMatchObject({ code: "goal_evidence_not_found" });
      await expect(repository.readHandoff({ ...scope,workbenchId: "other",resultId: "large" })).rejects.toMatchObject({ code: "goal_evidence_not_found" });
      const bodies: WorkResultRepository = { record: () => Promise.reject(new Error("unused")),readBody: () => Promise.reject(new Error("unused")),readVerification: () => Promise.resolve(null) };
      const service = new WorkResultService(bodies,repository);
      await expect(service.readChanges({ ...scope,resultRevision: 1,requirementsRevision: 1,afterResultRevision: 0 })).resolves.toMatchObject({ totalChanges: 1 });
      await expect(service.readState({ ...scope,outcomeId: "r2:q1" })).resolves.toMatchObject({ stateStatus: "PROVIDED" });
      await expect(service.readHandoff({ ...scope,resultId: "large" })).resolves.toMatchObject({ handoffStatus: "PROVIDED" });
    } finally { f.connection.close(); }
  });

  it("reports missing and invalid semantic metadata without substituting a display preview",async () => {
    const f = fixture(3);
    try {
      f.connection.exec("UPDATE work_results SET handoff_json=NULL,handoff_status='MISSING' WHERE result_id='r0001'; UPDATE work_results SET handoff_json='{}',handoff_status='PROVIDED' WHERE result_id='r0002'; UPDATE joi_goal_outcome_history SET synthesis_state_json=NULL");
      const repository = new SqliteGoalEvidenceRepository(f.database);
      const scope = { goalInputId: "goal",workbenchId: "bench" };
      const page = await repository.readChanges({ ...scope,resultRevision: 3,requirementsRevision: 1,afterResultRevision: 0 });
      expect(page.changedResults[0]).toMatchObject({ handoffStatus: "MISSING",summary: "preview" });
      expect(page.changedResults[0]?.handoff).toBeUndefined();
      expect(page.changedResults[1]).toMatchObject({ handoffStatus: "INVALID" });
      expect(page.changedResults[1]?.handoff).toBeUndefined();
      await expect(repository.readHandoff({ ...scope,resultId: "r0001" })).resolves.toMatchObject({ handoffStatus: "MISSING",content: "",totalCharacters: 0 });
      await expect(repository.readState({ ...scope,outcomeId: "r1:q1" })).resolves.toMatchObject({ stateStatus: "MISSING",content: "",totalCharacters: 0 });
    } finally { f.connection.close(); }
  });
});
