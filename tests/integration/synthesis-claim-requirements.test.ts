import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { buildGoalSynthesisState } from "../../src/main/infrastructure/persistence/sqlite-goal-synthesis-state.js";
import { loadGoalSynthesisContext } from "../../src/main/infrastructure/persistence/sqlite-goal-result-synthesis.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";

describe("AC-48/53/67 synthesis claim requirement provenance", () => {
  it("counts a completed unaccepted self-report as an evidence gap", async () => {
    const fixture = await createGoalEvidenceFixture([{ verification: "NOT_REQUIRED" }]);
    try {
      const context = fixture.database.transaction(db => loadGoalSynthesisContext(db, "goal", fixture.workbenchId, 1, 0));
      expect(context).toMatchObject({ totalResults: 1, gapCount: 1 });
    } finally { await fixture.close(); }
  });
  it("combines a report and appendix from separately scoped current verified runs", async () => {
    const fixture = await createGoalEvidenceFixture([{}, {}]);
    try {
      const state = fixture.database.transaction(db => {
        db.prepare("INSERT INTO joi_goal_requirements (goal_input_id,workbench_id,revision,processed_source_revision) VALUES ('goal',?,2,0)").run(fixture.workbenchId);
        db.prepare("INSERT INTO joi_goal_requirement_snapshots (goal_input_id,revision,requirements_json) VALUES ('goal',2,?)")
          .run(JSON.stringify(["req-A", "req-B"].map(id => ({ id, kind: "DELIVERABLE", mandatory: true, scope: "SCOPED", text: id, source: { sourceRevision: 1, start: 0, end: 1 } }))));
        db.prepare("UPDATE partner_runs SET requirements_revision=2,requirement_ids_json=? WHERE run_id=?").run('["req-A"]', "run-1");
        db.prepare("UPDATE partner_runs SET requirements_revision=2,requirement_ids_json=? WHERE run_id=?").run('["req-B"]', "run-2");
        return buildGoalSynthesisState(db, { goalInputId: "goal", workbenchId: fixture.workbenchId, resultRevision: 2, requirementsRevision: 2,
          draft: { version: 1, claims: [{ statement: "The report and appendix are both delivered.", requirementIds: ["req-A", "req-B"], resultIds: ["result-1", "result-2"] }], unresolved: [], conflicts: [] } });
      });
      expect(state.claims[0]?.verification).toBe("VERIFIED");
    } finally { await fixture.close(); }
  });
  it("checks 1000 prior references and three new results in one metadata query without loading any bodies", () => {
    const connection = new DatabaseSync(":memory:");
    try {
      connection.exec(`CREATE TABLE joi_goal_requirements(goal_input_id TEXT,workbench_id TEXT,revision INTEGER,processed_source_revision INTEGER);
        CREATE TABLE joi_goal_requirement_snapshots(goal_input_id TEXT,revision INTEGER,requirements_json TEXT);
        CREATE TABLE joi_goal_requirement_sources(goal_input_id TEXT,source_revision INTEGER);
        CREATE TABLE joi_goal_outcomes(input_id TEXT,synthesis_state_json TEXT);
        CREATE TABLE work_items(work_id TEXT,input_id TEXT,workbench_id TEXT,status TEXT);
        CREATE TABLE work_results(result_id TEXT,work_id TEXT,run_id TEXT,workbench_id TEXT,status TEXT,action_id TEXT,is_late INTEGER,is_authoritative INTEGER);
        CREATE TABLE partner_runs(run_id TEXT,requirements_revision INTEGER,requirement_ids_json TEXT);
        CREATE TABLE dispatch_attempts(work_id TEXT,action_id TEXT,created_at TEXT);
        CREATE TABLE work_result_verifications(result_id TEXT,status TEXT);
        CREATE TABLE joi_goal_result_members(original_input_id TEXT,event_id TEXT,revision INTEGER);
        CREATE TABLE partner_result_events(event_id TEXT,run_id TEXT,status TEXT);`);
      const ids = Array.from({ length: 1003 }, (_, index) => `r${String(index + 1)}`);
      const work = connection.prepare("INSERT INTO work_items VALUES (?,'goal','bench','COMPLETED')");
      const result = connection.prepare("INSERT INTO work_results VALUES (?,?,?,'bench','COMPLETED',?,0,1)");
      const run = connection.prepare("INSERT INTO partner_runs VALUES (?,0,'[]')");
      const attempt = connection.prepare("INSERT INTO dispatch_attempts VALUES (?,?,'now')");
      const verification = connection.prepare("INSERT INTO work_result_verifications VALUES (?,'PASSED')");
      const member = connection.prepare("INSERT INTO joi_goal_result_members VALUES ('goal',?,?)");
      const event = connection.prepare("INSERT INTO partner_result_events VALUES (?,?,'COMPLETED')");
      for (const [index, id] of ids.entries()) {
        work.run(`w-${id}`); result.run(id, `w-${id}`, `run-${id}`, `a-${id}`); run.run(`run-${id}`);
        attempt.run(`w-${id}`, `a-${id}`); verification.run(id); member.run(`e-${id}`, index + 1); event.run(`e-${id}`, `run-${id}`);
      }
      const prepare = vi.spyOn(connection, "prepare");
      const claims = Array.from({ length: Math.ceil(ids.length / 128) }, (_, index) => ({ statement: `Evidence group ${String(index)}`,
        requirementIds: [], resultIds: ids.slice(index * 128, (index + 1) * 128) }));
      const state = buildGoalSynthesisState(connection, { goalInputId: "goal", workbenchId: "bench", resultRevision: 1003, requirementsRevision: 0,
        draft: { version: 1, claims, unresolved: [], conflicts: [] } });
      expect(state.claims.every(claim => claim.verification === "VERIFIED")).toBe(true);
      const metadataQueries = prepare.mock.calls.map(([sql]) => sql).filter(sql => /\b(?:FROM|JOIN)\s+work_results\b/iu.test(sql));
      expect(metadataQueries).toHaveLength(1);
      expect(metadataQueries[0]).not.toMatch(/work_result_bodies|\bbody\b/iu);
      prepare.mockRestore();
      connection.exec("UPDATE work_results SET is_late=1 WHERE result_id='r1'; UPDATE work_results SET is_authoritative=0 WHERE result_id='r2'; UPDATE work_result_verifications SET status='FAILED' WHERE result_id='r3'");
      const unverified = buildGoalSynthesisState(connection, { goalInputId: "goal", workbenchId: "bench", resultRevision: 1003, requirementsRevision: 0,
        draft: { version: 1, claims: ["r1", "r2", "r3"].map(id => ({ statement: id, requirementIds: [], resultIds: [id] })), unresolved: [], conflicts: [] } });
      expect(unverified.claims.map(claim => claim.verification)).toEqual(["UNVERIFIED", "UNVERIFIED", "UNVERIFIED"]);
      expect(() => buildGoalSynthesisState(connection, { goalInputId: "goal", workbenchId: "foreign", resultRevision: 1003, requirementsRevision: 0,
        draft: { version: 1, claims: claims.slice(0, 1), unresolved: [], conflicts: [] } })).toThrow("outside its goal or version");
    } finally { connection.close(); }
  });
  it.each([
    { name: "an earlier revision of the same requirement ID", runRevision: 1, deliveredIds: ["req-B"], claimId: "req-B", expected: "UNVERIFIED" },
    { name: "a current run dispatched for another scoped requirement", runRevision: 2, deliveredIds: ["req-A"], claimId: "req-B", expected: "UNVERIFIED" },
    { name: "the current requirement and its actual delivered scope", runRevision: 2, deliveredIds: ["req-B"], claimId: "req-B", expected: "VERIFIED" },
    { name: "a legacy run without frozen requirement scope", runRevision: 2, deliveredIds: null, claimId: "req-B", expected: "UNVERIFIED" },
  ])("binds verification to $name", async spec => {
    const fixture = await createGoalEvidenceFixture([{}]);
    try {
      const actual = fixture.database.transaction(db => {
        db.prepare("INSERT INTO joi_goal_requirements (goal_input_id,workbench_id,revision,processed_source_revision) VALUES ('goal',?,2,0)").run(fixture.workbenchId);
        const requirements = ["req-A", "req-B"].map(id => ({ id, kind: "DELIVERABLE", mandatory: true, scope: "SCOPED",
          text: id === "req-B" ? "Produce the appendix with the newly required audit fields." : "Produce the unrelated report.",
          source: { sourceRevision: 1, start: 0, end: 10 } }));
        db.prepare("INSERT INTO joi_goal_requirement_snapshots (goal_input_id,revision,requirements_json) VALUES ('goal',2,?)").run(JSON.stringify(requirements));
        db.prepare("UPDATE partner_runs SET requirements_revision=?,requirement_ids_json=? WHERE run_id='run-1'")
          .run(spec.runRevision, spec.deliveredIds === null ? null : JSON.stringify(spec.deliveredIds));
        return buildGoalSynthesisState(db, { goalInputId: "goal", workbenchId: fixture.workbenchId, resultRevision: 1, requirementsRevision: 2,
          draft: { version: 1, claims: [{ statement: "The current appendix requirement is satisfied.", requirementIds: [spec.claimId], resultIds: ["result-1"] }], unresolved: [], conflicts: [] } });
      });
      expect(actual.claims[0]?.verification).toBe(spec.expected);
    } finally { await fixture.close(); }
  });
});
