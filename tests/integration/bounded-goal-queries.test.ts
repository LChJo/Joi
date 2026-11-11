import { DatabaseSync } from "node:sqlite";
import { SqliteGoalEvidenceRepository,goalEvidenceIndex,loadGoalEvidenceCatalog } from "../../src/main/infrastructure/persistence/sqlite-goal-evidence-repository.js";
import { SqliteWorkPlanRepository } from "../../src/main/infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { withGoalRequirementsTools } from "../../src/main/infrastructure/pi/joi-requirements-tools.js";
import { Type } from "typebox";
import { } from "@earendil-works/pi-ai";

function fixture(count = 1000) {
  const connection = new DatabaseSync(":memory:");
  connection.exec(`
    CREATE TABLE work_items(work_id TEXT,input_id TEXT,workbench_id TEXT,title TEXT,intent_json TEXT,status TEXT,created_at TEXT);
    CREATE TABLE dispatch_attempts(work_id TEXT,action_id TEXT,created_at TEXT);
    CREATE TABLE work_results(result_id TEXT,work_id TEXT,workbench_id TEXT,body_ref TEXT,status TEXT,is_late INTEGER,is_authoritative INTEGER,created_at TEXT,action_id TEXT,artifacts_json TEXT);
    CREATE TABLE work_result_bodies(body_ref TEXT,body TEXT);
    CREATE TABLE work_result_verifications(result_id TEXT,status TEXT);
    CREATE TABLE joi_inbox_messages(input_id TEXT,workbench_id TEXT);
    CREATE TABLE joi_goal_outcomes(input_id TEXT,result_revision INTEGER,requirements_revision INTEGER,disposition TEXT,completion_summary TEXT);
    CREATE TABLE joi_goal_outcome_history(goal_input_id TEXT,result_revision INTEGER,requirements_revision INTEGER,disposition TEXT,completion_summary TEXT);
    INSERT INTO joi_inbox_messages VALUES ('goal','bench');
    INSERT INTO joi_goal_outcomes VALUES ('goal',2,1,'CONTINUE','current');
    INSERT INTO joi_goal_outcome_history VALUES ('goal',1,1,'CONTINUE','old');
  `);
  const body = "unselected private body".repeat(1000);
  for (let n = 0; n < count; n++) {
    const id = String(n).padStart(4,"0");
    connection.prepare("INSERT INTO work_items VALUES (?,?,?,'Work',?,?,?)").run(`w${id}`,"goal","bench",JSON.stringify({ requirementsRevision: n % 2 + 1 }),n % 2 ? "READY" : "COMPLETED",id);
    connection.prepare("INSERT INTO work_results VALUES (?,?,?,?,?,0,1,?,?,'[]')").run(`r${id}`,`w${id}`,"bench",`b${id}`,"COMPLETED",id,`a${id}`);
    connection.prepare("INSERT INTO dispatch_attempts VALUES (?,?,?)").run(`w${id}`,`a${id}`,id);
    connection.prepare("INSERT INTO work_result_bodies VALUES (?,?)").run(`b${id}`,body);
  }
  const queries: string[] = [];
  const materialized: number[] = [];
  const fields: string[] = [];
  const database = { transaction<T>(operation: (db: DatabaseSync) => T): T {
    const proxy = new Proxy(connection,{ get(target,key) {
      if (key === "prepare") return (sql: string) => {
        queries.push(sql);
        const statement = target.prepare(sql);
        return new Proxy(statement,{ get(statementTarget,method) {
          if (method === "all") return (...args: Parameters<typeof statement.all>) => { const rows = statementTarget.all(...args); materialized.push(rows.length); for (const row of rows) fields.push(...Object.keys(row)); return rows; };
          const value: unknown = Reflect.get(statementTarget,method,statementTarget);
          return typeof value === "function" ? value.bind(statementTarget) as unknown : value;
        } });
      };
      const value: unknown = Reflect.get(target,key,target);
      return typeof value === "function" ? value.bind(target) as unknown : value;
    } });
    return operation(proxy);
  } };
  return { connection,database,queries,materialized,fields };
}

describe("AC-43/48/53/67 bounded goal queries",() => {
  it("keeps scoped guarded tools and stale-brief checks bounded while excluding only a reassigned target",async () => {
    const f = fixture(0);
    try {
      f.connection.exec(`INSERT INTO work_items VALUES ('target','goal','bench','Target','{"requirementsRevision":1}','READY','0'),
        ('stale','goal','bench','Other stale','{"requirementsRevision":1}','PLANNED','1'),
        ('foreign','different-goal','bench','Foreign','{"requirementsRevision":2}','READY','2'),
        ('foreign-bench','goal','different-bench','Other bench','{"requirementsRevision":2}','READY','3')`);
      const repository = new SqliteWorkPlanRepository(f.database);
      const requirements = new SqliteGoalRequirementsRepository(f.database);
      vi.spyOn(requirements,"assertReady").mockResolvedValue(null);
      vi.spyOn(requirements,"checkpointTurn").mockResolvedValue(undefined);
      vi.spyOn(requirements,"load").mockResolvedValue(null);
      const fullList = vi.fn(() => Promise.reject(new Error("Full Work lists must not be read by guards.")));
      const executed = vi.fn(() => Promise.resolve({ content: [{ type: "text" as const,text: '{"status":"DONE"}' }],details: {} }));
      const build = () => withGoalRequirementsTools(["turn_complete","work_reassign"].map(name => ({ name,label: name,description: name,parameters: Type.Object({}),execute: executed })),{
        requirements,goalInputId: "goal",workbenchId: "bench",turnId: "turn",work: {
          listForGoal: fullList,listGoalPage: query => repository.listGoalPage(query),readBrief: () => Promise.resolve(null),refreshBrief: () => Promise.resolve(),
        },
      });
      const invoke = async (name: string,args: Record<string,unknown>) => {
        const tool = build().find(value => value.name === name);
        const result = await tool?.execute("call",args);
        return JSON.parse((result?.content[0] as { text: string }).text) as { status: string; reasonCode?: string };
      };
      expect(await invoke("turn_complete",{ requirementsRevision: 2 })).toMatchObject({ reasonCode: "goal_requirements_work_stale" });
      expect(await invoke("work_reassign",{ workId: "target",requirementsRevision: 2 })).toMatchObject({ reasonCode: "goal_requirements_work_stale" });
      f.connection.exec("UPDATE work_items SET intent_json='{\"requirementsRevision\":2}' WHERE work_id='stale'");
      expect(await invoke("work_reassign",{ workId: "target",requirementsRevision: 2 })).toEqual({ status: "DONE" });
      for (const workId of ["foreign","foreign-bench","missing"]) expect(await invoke("work_reassign",{ workId,requirementsRevision: 2 })).toMatchObject({ reasonCode: "goal_requirements_scope_invalid" });
      expect(executed).toHaveBeenCalledTimes(1);
      expect(fullList).not.toHaveBeenCalled();
      expect(Math.max(...f.materialized)).toBeLessThanOrEqual(2);
      expect(f.fields).not.toContain("intent_json");
    } finally { f.connection.close(); }
  });
  it.each([10,100,1000])("only materializes a bounded metadata page for %i results",async count => {
    const f = fixture(count);
    try {
      const repository = new SqliteGoalEvidenceRepository(f.database);
      const page = await repository.index({ goalInputId: "goal",workbenchId: "bench" });
      const value = JSON.parse(page.content) as { results: { resultId: string }[] };
      expect(value.results.length).toBeLessThanOrEqual(8);
      expect(value.results[0]?.resultId).toBe(`r${String(count - 1).padStart(4,"0")}`);
      expect(page.content.length).toBeLessThanOrEqual(8000);
      expect(page.content).not.toContain("unselected private body");
      expect(Math.max(...f.materialized)).toBeLessThanOrEqual(9);
      expect(f.fields).not.toContain("body");
    } finally { f.connection.close(); }
  });

  it("filters and snapshots goal Work pages without loading private instructions",async () => {
    const f = fixture(100);
    try {
      const repository = new SqliteWorkPlanRepository(f.database);
      const request = { goalInputId: "goal",workbenchId: "bench",statuses: ["READY"],requirementsRevision: 2,limit: 3 };
      const page = await repository.listGoalPage(request);
      expect(page.items.map(row => row.workId)).toEqual(["w0001","w0003","w0005"]);
      expect(page.nextCursor).toBeDefined();
      f.connection.prepare("INSERT INTO work_items VALUES ('inserted','goal','bench','New','{\"requirementsRevision\":2}','READY','0006')").run();
      const cursor = page.nextCursor ?? "missing";
      const next = await repository.listGoalPage({ ...request,cursor });
      expect(next.items.map(row => row.workId)).toEqual(["w0007","w0009","w0011"]);
      await expect(repository.listGoalPage({ ...request,workbenchId: "foreign",cursor })).rejects.toMatchObject({ code: "work_list_cursor_invalid" });
      await expect(repository.listGoalPage({ ...request,requirementsRevision: 1,cursor })).rejects.toMatchObject({ code: "work_list_cursor_invalid" });
      expect(Math.max(...f.materialized)).toBeLessThanOrEqual(4);
      expect(f.fields).not.toContain("intent_json");
      expect(await repository.listForGoal("goal","bench")).toHaveLength(101);
    } finally { f.connection.close(); }
  });

  it("keeps all evidence reachable with snapshot cursors and preserves numeric legacy JSON offsets",async () => {
    const f = fixture(100);
    try {
      const repository = new SqliteGoalEvidenceRepository(f.database);
      const scope = { goalInputId: "goal",workbenchId: "bench" };
      const first = await repository.index(scope);
      await expect(repository.index({ ...scope,workbenchId: "foreign",cursor: first.nextCursor ?? "missing" })).rejects.toMatchObject({ code: "work_result_cursor_invalid" });
      f.connection.exec("INSERT INTO work_results VALUES ('new','w0000','bench','b0000','COMPLETED',0,1,'9999','new','[]')");
      const collected: string[] = [];
      const outcomes: string[] = [];
      let page = first;
      for (;;) {
        const value = JSON.parse(page.content) as { results: { resultId: string }[]; conclusions: { outcomeId: string }[] };
        collected.push(...value.results.map(row => row.resultId)); outcomes.push(...value.conclusions.map(row => row.outcomeId));
        if (page.nextCursor === undefined) break;
        page = await repository.index({ ...scope,cursor: page.nextCursor });
      }
      expect(collected).toHaveLength(100);
      expect(new Set(collected).size).toBe(100);
      expect(collected).not.toContain("new");
      expect(outcomes).toEqual(["r2:q1","r1:q1"]);
      f.connection.prepare("UPDATE work_result_bodies SET body=? WHERE body_ref='b0000'").run("😀".repeat(10));
      f.connection.exec("UPDATE work_results SET artifacts_json='[{\"name\":\"artifact\"}]' WHERE result_id='r0000'");
      const original = goalEvidenceIndex(loadGoalEvidenceCatalog(f.connection,scope));
      for (const offset of [0,8000,16000]) {
        const legacy = await repository.index({ ...scope,cursor: String(offset) });
        expect(legacy.content).toBe(original.slice(offset,offset + 8000));
        expect(legacy.totalCharacters).toBe(original.length);
      }
    } finally { f.connection.close(); }
  });

  it("does not let unavailable body references truncate the remaining evidence pages",async () => {
    const f = fixture(10);
    try {
      for (let n = 0; n < 12; n++) f.connection.prepare("INSERT INTO work_results VALUES (?,'w0000','bench','missing-body','COMPLETED',0,1,?,?,'[]')")
        .run(`orphan${String(n)}`,`999${String(n)}`,`orphan${String(n)}`);
      const repository = new SqliteGoalEvidenceRepository(f.database);
      const results: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await repository.index({ goalInputId: "goal",workbenchId: "bench",...(cursor === undefined ? {} : { cursor }) });
        results.push(...(JSON.parse(page.content) as { results: { resultId: string }[] }).results.map(row => row.resultId));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(results).toHaveLength(10);
    } finally { f.connection.close(); }
  });

  it.each([10,100,1000])("keeps a fixed three-result increment bounded after %i historical results",async count => {
    const f = fixture(count);
    try {
      for (let n = 0; n < 3; n++) f.connection.prepare("INSERT INTO work_results VALUES (?,?,'bench',?,'COMPLETED',0,1,?,?,'[]')")
        .run(`new${String(n)}`,"w0000","b0000",`999${String(n)}`,`new${String(n)}`);
      const page = await new SqliteGoalEvidenceRepository(f.database).index({ goalInputId: "goal",workbenchId: "bench" });
      const value = JSON.parse(page.content) as { results: { resultId: string }[] };
      expect(value.results.slice(0,3).map(row => row.resultId)).toEqual(["new2","new1","new0"]);
      expect(value.results).toHaveLength(8);
      expect(Math.max(...f.materialized)).toBe(9);
      expect(f.fields).not.toContain("body");
      expect(page.content.length).toBeLessThan(4000);
    } finally { f.connection.close(); }
  });

  it("reads only the requested conclusion and preserves Unicode and legacy offsets",async () => {
    const f = fixture(10);
    try {
      const body = "a".repeat(7999) + "😀" + "tail".repeat(3000);
      f.connection.prepare("UPDATE joi_goal_outcome_history SET completion_summary=?").run(body);
      const repository = new SqliteGoalEvidenceRepository(f.database);
      let cursor: string | undefined;
      let restored = "";
      do {
        const page = await repository.readConclusion({ goalInputId: "goal",workbenchId: "bench",outcomeId: "r1:q1",...(cursor === undefined ? {} : { cursor }) });
        expect(page.content.length).toBeLessThanOrEqual(8000);
        expect(page.content).not.toMatch(/[\uD800-\uDBFF]$/u);
        restored += page.content; cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(restored).toBe(body);
      const legacy = await repository.readConclusion({ goalInputId: "goal",workbenchId: "bench",outcomeId: "r1:q1",cursor: "8001" });
      expect(legacy.content).toBe(body.slice(8001,16001));
      expect(f.queries.some(sql => /FROM work_results/iu.test(sql))).toBe(false);
      expect(f.materialized).toEqual([]);
      await expect(repository.readConclusion({ goalInputId: "goal",workbenchId: "foreign",outcomeId: "r1:q1" })).rejects.toMatchObject({ code: "goal_evidence_not_found" });
    } finally { f.connection.close(); }
  });
});
