import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

const NOW = "2026-10-19T00:00:00.000Z";

describe("goal detail projection (AC-37/44/48)", () => {
  it("returns a complete safe title and all distinct paths across bounded pages with real work states", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.database.transaction((db) => {
        db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,
          project_label,memory_namespace_id,status,created_at,updated_at)
          VALUES ('wb','Fixture','persona','summary','scope','project','memory','ACTIVE',?,?)`).run(NOW, NOW);
        const insert = db.prepare(`INSERT INTO joi_inbox_messages
          (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,?,'ROUTED','wb',?,?)`);
        insert.run("goal", "goal", `${"完整目标".repeat(80)}\n最后一条要求 token=synthetic-secret C:\\private\\hidden\\project\\docs\\result.md`, NOW, NOW);
        insert.run("other", "other", "other private goal", NOW, NOW);
        for (const id of ["goal", "other"]) db.prepare(`INSERT INTO joi_harness_maps
          (goal_input_id,workbench_id,status,revision,reviewed_revision,created_at,updated_at)
          VALUES (?,'wb','ACTIVE',7,2,?,?)`).run(id, NOW, NOW);
        db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
          VALUES ('turn','goal','wb','session','COMPLETED',?,?)`).run(NOW, NOW);
        db.prepare(`INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
          VALUES ('failed-work','wb','goal','work','{}','READ','FAILED',?,?)`).run(NOW, NOW);
        for (let i = 0; i < 7; i++) db.prepare(`INSERT INTO joi_harness_paths
          (path_id,goal_input_id,layer,title,status,work_id,created_at,updated_at)
          VALUES (?,'goal',?,?,'CLOSED',?,?,?)`).run(`path-${String(i)}`, i < 3 ? 1 : 2,
            `同名路径${"说明".repeat(50)}`, i === 6 ? "failed-work" : null, NOW, NOW);
        db.prepare(`INSERT INTO joi_harness_decisions (decision_id,goal_input_id,kind,summary,detail,created_at)
          VALUES ('decision','goal','APPROACH','已决定','cookie=synthetic-cookie',?)`).run(NOW);
        db.prepare("UPDATE joi_harness_paths SET resolved_decision_id='decision' WHERE path_id='path-6'").run();
        db.prepare(`INSERT INTO joi_harness_fog (fog_id,goal_input_id,note,status,graduated_path_id,created_at,updated_at)
          VALUES ('fog','goal','待验证内容','GRADUATED','path-6',?,?)`).run(NOW, NOW);
        db.prepare(`INSERT INTO joi_harness_paths (path_id,goal_input_id,layer,title,status,created_at,updated_at)
          VALUES ('foreign-path','other',1,'foreign private title','OPEN',?,?)`).run(NOW, NOW);
      });
      const repository = new SqliteJoiHomeFeedRepository(fixture.database);
      const first = await repository.loadGoalDetail("goal", { offset: 0, limit: 3 });
      expect(first?.fullTitle).toContain("最后一条要求 token=[redacted]");
      expect(first?.fullTitle).toContain("C:\\…\\project\\docs\\result.md");
      expect(first?.harness).toMatchObject({ currentLayer: 2, pathCount: 7, decisionCount: 1, fogCount: 1 });
      expect(first?.harness?.decisions[0]).toMatchObject({ decisionId: "decision", detail: "cookie=[redacted]" });
      expect(first?.harness?.fog[0]).toMatchObject({ status: "GRADUATED", graduatedPathId: "path-6" });
      const middle = await repository.loadGoalDetail("goal", { offset: 3, limit: 3 });
      const last = await repository.loadGoalDetail("goal", { offset: 6, limit: 3 });
      const paths = [...(first?.harness?.paths ?? []), ...(middle?.harness?.paths ?? []), ...(last?.harness?.paths ?? [])];
      expect(paths).toHaveLength(7);
      expect(new Set(paths.map((p) => p.pathId)).size).toBe(7);
      expect(paths.find((p) => p.pathId === "path-6")).toMatchObject({ layer: 2, status: "CLOSED", workStatus: "FAILED", resolvedDecisionId: "decision" });
      expect(paths[0]?.title.length).toBeGreaterThan(80);
      expect(first?.nextOffset).toBe(3);
      expect(last?.nextOffset).toBeUndefined();
      const serialized = JSON.stringify([first, middle, last]);
      for (const secret of ["synthetic-secret", "synthetic-cookie", "foreign private title", "other private goal"]) expect(serialized).not.toContain(secret);
      expect(await repository.loadGoalDetail("missing", {})).toBeNull();
      fixture.database.transaction((db) => db.prepare("UPDATE joi_inbox_messages SET dismissed_at=? WHERE input_id='goal'").run(NOW));
      expect(await repository.loadGoalDetail("goal", {})).toBeNull();
    } finally { await fixture.close(); }
  });

  it("reads an unmapped goal without inventing a map and rejects invalid paging", async () => {
    const fixture = await createRuntimeFixture();
    try {
      fixture.database.transaction((db) => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,created_at,updated_at) VALUES ('plain','plain','A complete goal','PENDING',?,?)`).run(NOW, NOW));
      const repository = new SqliteJoiHomeFeedRepository(fixture.database);
      expect(await repository.loadGoalDetail("plain", {})).toEqual({ goalId: "plain", fullTitle: "A complete goal" });
      for (const options of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 101 }, { offset: Infinity }]) {
        await expect(repository.loadGoalDetail("plain", options)).rejects.toMatchObject({ code: "goal_detail_page_invalid" });
      }
    } finally { await fixture.close(); }
  });
});
