import { WorkResultService } from "../../src/main/application/work/work-result-service.js";
import { SqliteGoalEvidenceRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-evidence-repository.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";

it("rejects a current conclusion cursor after a replacement at the same revisions", async () => {
  const fixture = await createGoalEvidenceFixture([{}]);
  try {
    const evidence = new SqliteGoalEvidenceRepository(fixture.database);
    const scope = { goalInputId: "goal",workbenchId: fixture.workbenchId,outcomeId: "r1:q0:current" };
    const now = fixture.clock.now().toISOString();
    fixture.database.transaction(db => db.prepare(`INSERT INTO joi_goal_outcomes
      (input_id,result_revision,disposition,completion_summary,completed_at,updated_at,completion_key)
      VALUES ('goal',1,'CONTINUE',?,?,?,'first')`).run("😀".repeat(8000),now,now));
    const first = await evidence.readConclusion(scope);
    if (first.nextCursor === undefined) throw new Error("Missing conclusion cursor.");
    const cursor = first.nextCursor;
    fixture.database.transaction(db => db.prepare("UPDATE joi_goal_outcomes SET completion_summary='Updated',completion_key='second' WHERE input_id='goal'").run());
    await expect(evidence.readConclusion({ ...scope,cursor })).rejects.toMatchObject({ code: "work_result_cursor_invalid" });
    expect((await evidence.readConclusion(scope)).content).toBe("Updated");
  } finally { await fixture.close(); }
});

it("classifies scope, retired turns and superseded evidence owners separately", async () => {
  const fixture = await createGoalEvidenceFixture([{}]);
  try {
    const evidence = new SqliteGoalEvidenceRepository(fixture.database);
    const read = { goalInputId: "goal",workbenchId: fixture.workbenchId,turnId: "synthesis-turn",
      resultId: "result-1",toolCallId: "read",start: 0,end: 10 };
    await expect(evidence.recordResultRead({ ...read,resultId: "foreign-result" })).rejects.toMatchObject({ code: "goal_evidence_not_found" });
    fixture.database.transaction(db => db.prepare("UPDATE joi_goal_result_sets SET revision=2 WHERE original_input_id='goal'").run());
    await expect(evidence.recordResultRead(read)).rejects.toMatchObject({ code: "goal_evidence_snapshot_stale" });
    fixture.database.transaction(db => db.prepare("UPDATE joi_turns SET status='COMPLETED' WHERE turn_id='synthesis-turn'").run());
    await expect(evidence.recordResultRead(read)).rejects.toMatchObject({ code: "goal_evidence_turn_inactive" });
    expect((await evidence.readRoadmap({ ...read,section: "reads" })).total).toBe(0);
  } finally { await fixture.close(); }
});

it("REV-02 follows roadmap paths, unmapped Work and Run evidence without crossing scope or mixing map revisions", async () => {
  const fixture = await createGoalEvidenceFixture(Array.from({ length: 11 }, () => ({})));
  try {
    const scope = { goalInputId: "goal",workbenchId: fixture.workbenchId };
    const now = fixture.clock.now().toISOString();
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO joi_harness_maps (goal_input_id,workbench_id,status,revision,created_at,updated_at) VALUES ('goal',?,'ACTIVE',1,?,?)")
        .run(scope.workbenchId,now,now);
      for (let index = 1; index <= 10; index += 1) {
        db.prepare(`INSERT INTO joi_harness_paths (path_id,goal_input_id,title,layer,status,work_id,created_at,updated_at)
          VALUES (?,'goal','Same title',1,'CLOSED',?,?,?)`).run(`path-${String(index)}`,`work-${String(index)}`,now,now);
      }
    });
    const evidence = new WorkResultService(fixture.repository,new SqliteGoalEvidenceRepository(fixture.database));
    const first = await evidence.readRoadmap({ ...scope,section: "paths" });
    expect(first).toMatchObject({ total: 10,counts: { paths: 10,unmapped: 1 } });
    expect(first.entries.find(row => row.pathId === "path-1")).toMatchObject({ workId: "work-1" });
    const cursor = first.nextCursor;
    if (cursor === undefined) throw new Error("Missing roadmap cursor");
    const next = await evidence.readRoadmap({ ...scope,section: "paths",cursor });
    expect([...first.entries,...next.entries]).toHaveLength(10);
    expect((await evidence.readRoadmap({ ...scope,section: "unmapped" })).entries)
      .toEqual([expect.objectContaining({ workId: "work-11" })]);
    expect((await evidence.readRoadmap({ ...scope,section: "runs",workId: "work-1" })).entries)
      .toEqual([expect.objectContaining({ runId: "run-1",resultId: "result-1",verification: "PASSED",isCurrentAttempt: 1 })]);
    await expect(evidence.readRoadmap({ ...scope,workbenchId: "unrelated",section: "runs",workId: "work-1" }))
      .rejects.toMatchObject({ code: "goal_evidence_not_found" });
    fixture.database.transaction(db => db.prepare("UPDATE joi_harness_maps SET revision=2 WHERE goal_input_id='goal'").run());
    await expect(evidence.readRoadmap({ ...scope,section: "paths",cursor }))
      .rejects.toMatchObject({ code: "goal_evidence_snapshot_stale" });
  } finally { await fixture.close(); }
});
