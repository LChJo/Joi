import { DatabaseSync } from "node:sqlite";
import { SqliteWorkbenchContextRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-context-repository.js";
import { createPartnerEvidenceTools } from "../../src/main/infrastructure/pi/pi-evidence-tools.js";

function fixture(count: number) {
  const connection = new DatabaseSync(":memory:");
  connection.exec(`CREATE TABLE work_items(work_id TEXT PRIMARY KEY,input_id TEXT,workbench_id TEXT,title TEXT,intent_json TEXT,status TEXT,created_at TEXT);
    CREATE TABLE dispatch_attempts(work_id TEXT,action_id TEXT,created_at TEXT);
    CREATE TABLE work_results(result_id TEXT PRIMARY KEY,work_id TEXT,workbench_id TEXT,body_ref TEXT,status TEXT,is_late INTEGER,is_authoritative INTEGER,created_at TEXT,action_id TEXT,artifacts_json TEXT);
    CREATE TABLE work_result_bodies(body_ref TEXT PRIMARY KEY,body TEXT);
    CREATE TABLE work_result_verifications(result_id TEXT,status TEXT,reason_code TEXT);
    CREATE TABLE joi_inbox_messages(input_id TEXT,workbench_id TEXT);
    CREATE TABLE joi_goal_outcomes(input_id TEXT,result_revision INTEGER,requirements_revision INTEGER,disposition TEXT,completion_summary TEXT);
    CREATE TABLE joi_goal_outcome_history(goal_input_id TEXT,result_revision INTEGER,requirements_revision INTEGER,disposition TEXT,completion_summary TEXT);
    CREATE TABLE work_dependencies(work_id TEXT,depends_on_work_id TEXT);
    CREATE TABLE work_run_directories(work_id TEXT,workbench_id TEXT,status TEXT,root_path TEXT);
    CREATE TABLE workbench_context_snapshots(context_snapshot_id TEXT,workbench_id TEXT,work_id TEXT,persona_revision_id TEXT,workspace_ref TEXT,safe_context_json TEXT,memory_summary_refs_json TEXT,created_at TEXT);
    INSERT INTO joi_inbox_messages VALUES ('goal','bench');
    INSERT INTO joi_goal_outcomes VALUES ('goal',1,1,'CONTINUE','Latest finding');`);
  for (let n = 0; n < count; n++) {
    const id = String(n).padStart(4,"0");
    connection.prepare("INSERT INTO work_items VALUES (?,'goal','bench','Work','{}','COMPLETED',?)").run(`w${id}`,id);
    connection.prepare("INSERT INTO dispatch_attempts VALUES (?,?,?)").run(`w${id}`,`a${id}`,id);
    connection.prepare("INSERT INTO work_results VALUES (?,?,'bench',?,'COMPLETED',0,1,?,?,'[]')").run(`r${id}`,`w${id}`,`b${id}`,id,`a${id}`);
    connection.prepare("INSERT INTO work_result_bodies VALUES (?,?)").run(`b${id}`,`BODY-${id}:` + "x".repeat(9000) + `:TAIL-${id}`);
    connection.prepare("INSERT INTO work_result_verifications VALUES (?,'PASSED',NULL)").run(`r${id}`);
  }
  const middle = Math.floor(count / 2);
  const id = (n: number) => String(n).padStart(4,"0");
  connection.prepare("INSERT INTO work_items VALUES ('current','goal','bench','Current',?,'READY','now')").run(JSON.stringify({ evidenceResultIds: [`r${id(middle)}`] }));
  connection.prepare("INSERT INTO work_dependencies VALUES ('current',?),(?,?)").run(`w${id(middle + 1)}`,`w${id(middle + 1)}`,`w${id(middle + 2)}`);
  const safeContext = { activeWork: [],workbenchName: "bench",projectLabel: "project",recentResults: [],responsibility: "MANDATORY_CONTEXT",work: { accessMode: "READ",title: "Current",workId: "current" } };
  connection.prepare("INSERT INTO workbench_context_snapshots VALUES ('snapshot','bench','current','persona',NULL,?,'[]','now')").run(JSON.stringify(safeContext));
  const bodyRows: number[] = [];
  const bodySizes: number[] = [];
  const database = { transaction<T>(operation: (db: DatabaseSync) => T): T {
    return operation(new Proxy(connection,{ get(target,key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return new Proxy(statement,{ get(selected,method) {
          if (method === "all") return (...args: Parameters<typeof statement.all>) => { const rows = selected.all(...args); const bodies = rows.filter(row => typeof row.body === "string"); bodyRows.push(bodies.length); bodySizes.push(...bodies.map(row => (row.body as string).length)); return rows; };
          const value: unknown = Reflect.get(selected,method,selected);
          return typeof value === "function" ? value.bind(selected) as unknown : value;
        } });
      };
      const value: unknown = Reflect.get(target,key,target);
      return typeof value === "function" ? value.bind(target) as unknown : value;
    } }));
  } };
  return { connection,database,bodyRows,bodySizes,middle,id };
}

describe("AC-43/48/53/67 lazy Pi evidence hydration",() => {
  it.each([10,100,1000])("bounds startup body reads with %i unrelated historical results and retains explicit/dependency evidence",async count => {
    const f = fixture(count);
    try {
      const repository = new SqliteWorkbenchContextRepository(f.database);
      const execution = await repository.loadForExecution("snapshot",{ evidenceMode: "LAZY" });
      expect(execution?.evidence?.files.length).toBe(0);
      expect(execution?.evidence?.reader).toBeDefined();
      expect(f.bodyRows.reduce((sum,n) => sum + n,0)).toBeLessThanOrEqual(12);
      expect(execution?.evidence?.inline).toContain(`Total historical results=${String(count)}`);
      for (const n of [f.middle,f.middle + 1,f.middle + 2]) expect(execution?.evidence?.inline).toContain(`BODY-${f.id(n)}:`);
      expect(execution?.promptSection).toContain("MANDATORY_CONTEXT");
      if (execution?.evidence?.statistics === undefined) throw new Error("Missing bounded evidence statistics.");
      expect(execution.evidence.statistics.omittedEvidenceCount).toBe(count - execution.evidence.statistics.evidenceCount);
      const tools = createPartnerEvidenceTools(execution.evidence);
      const read = async (name: string,args: Record<string,unknown>) => {
        const output = await tools.find(tool => tool.name === name)?.execute("read",args);
        return JSON.parse((output?.content[0] as { text: string }).text) as { content: string; nextCursor?: string };
      };
      let page = await read("work_read_result",{ resultId: `r${f.id(f.middle)}` });
      expect(page.content).toContain(`BODY-${f.id(f.middle)}:`);
      page = await read("work_read_result",{ resultId: `r${f.id(f.middle)}`,cursor: page.nextCursor });
      expect(page.content).toContain(`TAIL-${f.id(f.middle)}`);
      await expect(read("work_read_result",{ resultId: "foreign" })).rejects.toMatchObject({ code: "work_evidence_reference_invalid" });
      let cursor: string | undefined;
      const ids: string[] = [];
      do {
        page = await read("work_read_evidence",cursor === undefined ? {} : { cursor });
        ids.push(...(JSON.parse(page.content) as { results: { resultId: string }[] }).results.map(row => row.resultId));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(ids).toHaveLength(count);
      expect(new Set(ids).size).toBe(count);
    } finally { f.connection.close(); }
  });

  it("preserves complete native bundles by default and skips all evidence for path-only readers",async () => {
    const f = fixture(10);
    try {
      const repository = new SqliteWorkbenchContextRepository(f.database);
      expect((await repository.loadForExecution("snapshot"))?.evidence?.files).toHaveLength(11);
      f.bodyRows.length = 0;
      const paths = await repository.loadForExecution("snapshot",{ evidenceMode: "NONE" });
      expect(Boolean(paths?.evidence)).toBe(false);
      expect(f.bodyRows).toEqual([]);
    } finally { f.connection.close(); }
  });

  it("bounds oversized SQL body excerpts and keeps the omitted middle available through the scoped reader",async () => {
    const f = fixture(10);
    try {
      f.connection.prepare("UPDATE work_result_bodies SET body=? WHERE body_ref='b0005'").run("😀".repeat(100000) + "MIDDLE_SENTINEL" + "😀".repeat(100000) + "TAIL_REQUIRED");
      f.connection.prepare("UPDATE work_result_bodies SET body=? WHERE body_ref='b0009'").run("😀".repeat(200000) + "TAIL_OPTIONAL");
      const execution = await new SqliteWorkbenchContextRepository(f.database).loadForExecution("snapshot",{ evidenceMode: "LAZY" });
      expect(Math.max(...f.bodySizes)).toBeLessThan(121000);
      expect(execution?.evidence?.inline.includes("MIDDLE_SENTINEL")).toBe(false);
      expect(execution?.evidence?.inline.includes("TAIL_REQUIRED")).toBe(true);
      const middle = await execution?.evidence?.reader?.readResult({ resultId: "r0005",cursor: "100000" });
      expect(middle?.content.includes("MIDDLE_SENTINEL")).toBe(true);
      expect(middle?.content.length).toBeLessThanOrEqual(8000);
    } finally { f.connection.close(); }
  });
});
