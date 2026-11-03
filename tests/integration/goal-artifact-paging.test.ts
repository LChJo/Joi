import { readFile } from "node:fs/promises";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";
import { probeSqlReads } from "../support/sql-read-probe.js";

const artifact = (index: number) => ({ artifactRef: `workspace:deliverables/group-${String(Math.floor(index / 3)).padStart(5, "0")}/file-${String(index).padStart(5, "0")}.json`, name: `file-${String(index).padStart(5, "0")}.json`, mimeType: "application/json", size: 100 });

async function setup(count = 123) {
  const fixture = await createGoalEvidenceFixture([{}, {}]);
  fixture.database.transaction(db => {
    db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(JSON.stringify(Array.from({ length: count }, (_, index) => artifact(index))));
    db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-2'").run(JSON.stringify([artifact(0)]));
  });
  await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { outcome: "RESULT_SYNTHESIZED", completionSummary: "# Synthetic completed delivery", committedByTool: true });
  return { ...fixture, reader: new SqliteJoiHomeFeedRepository(fixture.database) };
}

describe("bounded goal artifact projection (AC-PERF-01 / AC-37 / AC-57)", () => {
  it("seeks preview versions by Work instead of repeating workbench-wide result scans", async () => {
    const fixture = await setup(3);
    const probe = probeSqlReads(fixture.database);
    try {
      await new SqliteJoiHomeFeedRepository(probe.database).load(fixture.clock.now());
      const sourceQuery = probe.statements.find(sql => sql.includes("work_result_artifact_versions"));
      if (sourceQuery === undefined) throw new Error("Missing source version lookup");
      const plan = fixture.database.transaction(db => db.prepare(`EXPLAIN QUERY PLAN ${sourceQuery}`).all("goal", fixture.workbenchId));
      expect(plan.map(row => row.detail).join("\n")).toMatch(/SEARCH r USING INDEX idx_work_results_work_page \(work_id=\?/u);
    } finally { await fixture.close(); }
  });
  it("backfills preview versions without changing source manifests or opening identifiers", async () => {
    const fixture = await setup(3);
    try {
      const before = (await fixture.reader.load(fixture.clock.now())).goals.find(goal => goal.goalId === "goal");
      const migration = await readFile("resources/migrations/090_read_projection_versions.sql", "utf8");
      fixture.database.transaction(db => {
        const original = db.prepare("SELECT artifacts_json FROM work_results WHERE result_id='result-1'").get()?.artifacts_json;
        const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'projection_learning_%' OR name LIKE 'work_result_artifact_version_%')").all();
        for (const trigger of triggers) db.exec(`DROP TRIGGER "${String(trigger.name)}"`);
        db.exec("DROP TABLE work_result_artifact_versions; DROP TABLE read_projection_versions;");
        db.exec(migration);
        expect(db.prepare("SELECT artifacts_json FROM work_results WHERE result_id='result-1'").get()?.artifacts_json).toBe(original);
        expect(db.prepare("SELECT COUNT(*) AS count FROM work_result_artifact_versions").get()?.count).toBe(2);
      });
      const after = (await fixture.reader.load(fixture.clock.now())).goals.find(goal => goal.goalId === "goal");
      expect(after?.artifacts).toEqual(before?.artifacts);
      expect(after?.artifactCount).toBe(before?.artifactCount);
    } finally { await fixture.close(); }
  });
  it("reuses unchanged previews and invalidates same-length manifests and source ordering", async () => {
    const fixture = await setup(123);
    const probe = probeSqlReads(fixture.database);
    const reader = new SqliteJoiHomeFeedRepository(probe.database);
    const read = async () => (await reader.load(fixture.clock.now())).goals.find(goal => goal.goalId === "goal");
    const expensive = () => probe.statements.filter(sql => /COUNT\(DISTINCT a.relative_path\)|WITH ranked AS/iu.test(sql));
    try {
      const first = await read();
      expect(first?.artifactCount).toBe(123);
      if (first?.artifacts?.[0] === undefined) throw new Error("Missing initial preview");
      first.artifacts[0].name = "mutated caller value";
      probe.statements.length = 0;
      const repeated = await read();
      expect(repeated?.artifacts?.[0]?.name).toBe(artifact(0).name);
      expect(expensive()).toEqual([]);

      fixture.database.transaction(db => db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-2'")
        .run(JSON.stringify([{ ...artifact(0), name: "file-99999.json" }])));
      probe.statements.length = 0;
      expect((await read())?.artifactCount).toBe(123);
      expect(expensive().length).toBeGreaterThan(0);

      fixture.database.transaction(db => db.prepare("UPDATE work_results SET created_at='2030-01-01' WHERE result_id='result-2'").run());
      expect((await read())?.artifacts?.[0]).toMatchObject({ artifactId: "work_result_artifact:result-2:0", name: "file-99999.json" });
      fixture.database.transaction(db => db.prepare("UPDATE work_results SET is_authoritative=0 WHERE result_id='result-2'").run());
      expect((await read())?.artifacts?.[0]?.artifactId).toBe("work_result_artifact:result-1:0");
    } finally { await fixture.close(); }
  });
  it("represents a quarter-million changed files with one folder and keeps warm reads bounded", async () => {
    const fixture = await setup(0);
    try {
      const count = 251_159;
      const manifest = Array.from({ length: count }, (_, index) => ({ ...artifact(index), artifactRef: `workspace:out/${String(index).padStart(6, "0")}.json` }));
      fixture.database.transaction(db => db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(JSON.stringify(manifest)));
      const probe = probeSqlReads(fixture.database);
      const reader = new SqliteJoiHomeFeedRepository(probe.database);
      const goal = (await reader.load(fixture.clock.now())).goals.find(item => item.goalId === "goal");
      // The second source retains a distinct deliverables path in this fixture.
      expect(goal?.artifactCount).toBe(count + 1);
      expect(goal?.artifacts).toHaveLength(2);
      expect(goal?.artifacts?.find(item => item.kind === "DIRECTORY")).toMatchObject({ name: "out", fileCount: count });
      expect(JSON.stringify(goal).length).toBeLessThan(15_000);
      probe.statements.length = 0;
      const repeated = (await reader.load(fixture.clock.now())).goals.find(item => item.goalId === "goal");
      expect(repeated?.artifactCount).toBe(count + 1);
      expect(repeated?.artifacts).toEqual(goal?.artifacts);
      expect(probe.statements.filter(sql => /COUNT\(DISTINCT a.relative_path\)|WITH ranked AS/iu.test(sql))).toEqual([]);
      const page = await fixture.reader.listGoalArtifacts("goal", {});
      expect(page?.items).toHaveLength(2);
      expect(page?.nextCursor).toBeUndefined();
    } finally { await fixture.close(); }
  }, 30_000);
  it("backfills stored manifests without rewriting the source and indexes later inserts atomically", async () => {
    const fixture = await setup(3);
    try {
      const migration = await readFile("resources/migrations/089_goal_artifact_index.sql", "utf8");
      fixture.database.transaction(db => {
        const original = db.prepare("SELECT artifacts_json FROM work_results WHERE result_id='result-1'").get()?.artifacts_json;
        db.exec(`DROP TRIGGER work_result_artifact_index_insert; DROP TRIGGER work_result_artifact_index_update;
          DROP TRIGGER work_result_artifact_index_delete; DROP VIEW work_result_artifact_candidates; DROP TABLE work_result_artifact_index;`);
        db.exec(migration);
        expect(db.prepare("SELECT artifacts_json FROM work_results WHERE result_id='result-1'").get()?.artifacts_json).toBe(original);
        expect(db.prepare("SELECT COUNT(*) AS total FROM work_result_artifact_index").get()?.total).toBe(4);
        db.prepare(`INSERT INTO work_results
          (result_id,run_id,action_id,workbench_id,work_id,partner_revision_id,status,summary,body_ref,artifacts_json,is_late,is_authoritative,created_at)
          SELECT 'inserted-result',run_id,action_id,workbench_id,work_id,partner_revision_id,'FAILED',summary,body_ref,artifacts_json,0,0,created_at
          FROM work_results WHERE result_id='result-2'`).run();
        expect(db.prepare("SELECT COUNT(*) AS total FROM work_result_artifact_index WHERE result_id='inserted-result'").get()?.total).toBe(1);
        db.prepare("DELETE FROM work_results WHERE result_id='inserted-result'").run();
        expect(db.prepare("SELECT COUNT(*) AS total FROM work_result_artifact_index WHERE result_id='inserted-result'").get()?.total).toBe(0);
      });
      expect((await fixture.reader.listGoalArtifacts("goal", {}))?.items).toHaveLength(3);
    } finally { await fixture.close(); }
  });
  it("keeps home previews bounded without materializing historical JSON manifests", async () => {
    const fixture = await setup(1_200);
    try {
      const queries: string[] = [];
      const reader = new SqliteJoiHomeFeedRepository({ transaction: operation => fixture.database.transaction(db => operation(new Proxy(db, {
        get(target, property) {
          if (property === "prepare") return (sql: string) => { queries.push(sql); return target.prepare(sql); };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) as unknown : value;
        },
      }))) });
      const goal = (await reader.load(fixture.clock.now())).goals.find(item => item.goalId === "goal");
      expect(goal?.artifacts?.length).toBeLessThanOrEqual(20);
      expect(goal?.artifactCount).toBe(1_200);
      expect(goal?.artifactNextCursor).toBeTruthy();
      expect(JSON.stringify(goal).length).toBeLessThan(15_000);
      expect(queries.some(sql => /SELECT[\s\S]*\bartifacts_json\b/iu.test(sql))).toBe(false);
    } finally { await fixture.close(); }
  });

  it("pages every distinct path with stable existing open identifiers and rejects unrelated cursors", async () => {
    const fixture = await setup();
    try {
      const items = [];
      let cursor: string | undefined;
      do {
        const page = await fixture.reader.listGoalArtifacts("goal", { limit: 17, ...(cursor === undefined ? {} : { cursor }) });
        expect(page?.items.length).toBeLessThanOrEqual(17);
        items.push(...(page?.items ?? []));
        cursor = page?.nextCursor;
      } while (cursor !== undefined);
      expect(items).toHaveLength(123);
      expect(new Set(items.map(item => item.name)).size).toBe(123);
      expect(items[0]?.artifactId).toBe("work_result_artifact:result-2:0");
      expect(JSON.stringify(items)).not.toContain("artifactRef");
      expect(JSON.stringify(items)).not.toContain("workspace:");
      await expect(fixture.reader.listGoalArtifacts("goal", { cursor: "work_result_artifact:unrelated:0" })).rejects.toMatchObject({ code: "goal_artifact_page_invalid" });
      for (const limit of [0, -1, 101, 1.5, NaN]) {
        await expect(fixture.reader.listGoalArtifacts("goal", { limit })).rejects.toMatchObject({ code: "goal_artifact_page_invalid" });
      }
      expect(await fixture.reader.listGoalArtifacts("missing", {})).toBeNull();
      fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET dismissed_at=? WHERE input_id='goal'").run(fixture.clock.now().toISOString()));
      expect(await fixture.reader.listGoalArtifacts("goal", {})).toBeNull();
    } finally { await fixture.close(); }
  });

  it("tracks manifest changes and authority without returning invalid or hidden workspace paths", async () => {
    const fixture = await setup(2);
    try {
      fixture.database.transaction(db => {
        db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-2'").run(JSON.stringify([
          artifact(2), { ...artifact(3), artifactRef: "workspace:../private.json" },
          { ...artifact(4), artifactRef: "workspace:.git/config" }, { ...artifact(5), artifactRef: "workspace:node_modules/package.json" },
          { ...artifact(6), artifactRef: "workspace:/absolute.json" }, { ...artifact(7), artifactRef: "workspace:C:/absolute.json" },
          { ...artifact(8), artifactRef: "workspace:a\\b.json" }, { ...artifact(9), artifactRef: "workspace:a//b.json" },
          { ...artifact(10), artifactRef: "workspace:a/./b.json" }, { ...artifact(11), artifactRef: "workspace:a/../b.json" },
          { ...artifact(12), name: null }, { ...artifact(13), size: "invalid" }, null,
        ]));
        db.prepare("UPDATE work_results SET is_authoritative=0 WHERE result_id='result-1'").run();
      });
      expect((await fixture.reader.listGoalArtifacts("goal", {}))?.items.map(item => item.name)).toEqual([artifact(2).name]);
      fixture.database.transaction(db => db.prepare("UPDATE work_results SET artifacts_json='invalid' WHERE result_id='result-2'").run());
      expect((await fixture.reader.listGoalArtifacts("goal", {}))?.items).toEqual([]);
    } finally { await fixture.close(); }
  });
});
