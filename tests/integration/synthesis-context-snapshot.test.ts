import { enqueueGoalResultSynthesis } from "../../src/main/infrastructure/persistence/sqlite-goal-result-synthesis.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { composeJoiContinuationBackground } from "../../src/main/application/joi/joi-continuation-prompt.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("versioned synthesis background", () => {
  it("provides a private version-keyed conclusion archive", async () => {
    const fixture = await createRuntimeFixture();
    try {
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_goal_outcome_history").get())?.n).toBe(0);
    } finally { await fixture.close(); }
  });
  it("keeps 163 results retrievable without persisting or reinjecting seven cumulative inventories", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const workbench = await fixture.workbenchRegistry.create({ name: "test", personaSummary: "test", projectLabel: "test", scopeSummary: "test" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "test", kind: "local-pi", skills: [], tools: [] });
      const now = fixture.clock.now().toISOString();
      const original = `MANDATORY_START ${"mandatory ".repeat(600)} MANDATORY_END`;
      fixture.database.transaction(db => {
        db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
          VALUES ('snapshot-goal','snapshot-key',?,'CONSUMED',?,?,?)`).run(original, workbench.workbenchId, now, now);
        db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
          VALUES ('snapshot-turn','snapshot-goal',?,'snapshot-session','COMPLETED',?,?)`).run(workbench.workbenchId, now, now);
        db.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at)
          VALUES ('snapshot-plan','snapshot-turn','{}','[]',?)`).run(now);
        db.prepare(`INSERT INTO joi_goal_result_sets (original_input_id,revision,synthesized_revision,updated_at)
          VALUES ('snapshot-goal',163,0,?)`).run(now);
        for (let i = 1; i <= 163; i++) {
          const id = String(i);
          db.prepare(`INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
            VALUES (?,?,'snapshot-goal',?,'{}','READ','COMPLETED',?,?)`).run(`sw-${id}`, workbench.workbenchId, `work ${id}`, now, now);
          db.prepare(`INSERT INTO dispatch_attempts (dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,status,created_at,updated_at)
            VALUES (?,'snapshot-plan',?,?,1,?,'COMPLETED',?,?)`).run(`sa-${id}`, `sw-${id}`, partner.partnerRevisionId, `sx-${id}`, now, now);
          db.prepare(`INSERT INTO partner_runs (run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,'LOCAL_PI',?,'COMPLETED',?,?)`).run(`sr-${id}`, `sa-${id}`, `sx-${id}`, workbench.workbenchId, `sw-${id}`, partner.partnerRevisionId, `external-${id}`, now, now);
          db.prepare(`INSERT INTO work_result_bodies (body_ref,body,created_at) VALUES (?,?,?)`).run(`sb-${id}`, `PRIVATE_BODY_${id} ${"evidence ".repeat(1000)} CONCLUSION_TAIL_${id}`, now);
          db.prepare(`INSERT INTO work_results (result_id,run_id,action_id,workbench_id,work_id,partner_revision_id,status,summary,body_ref,artifacts_json,is_late,is_authoritative,created_at)
            VALUES (?,?,?,?,?,?,'COMPLETED',?,?,'[]',0,1,?)`).run(`se-${id}`, `sr-${id}`, `sx-${id}`, workbench.workbenchId, `sw-${id}`, partner.partnerRevisionId, `summary ${id}`, `sb-${id}`, now);
          db.prepare(`INSERT INTO work_result_verifications (result_id,status,created_at) VALUES (?,'PASSED',?)`).run(`se-${id}`, now);
          db.prepare(`INSERT INTO partner_result_events (event_id,run_id,workbench_id,work_id,partner_revision_id,status,created_at)
            VALUES (?,?,?,?,?,'COMPLETED',?)`).run(`ev-${id}`, `sr-${id}`, workbench.workbenchId, `sw-${id}`, partner.partnerRevisionId, now);
          db.prepare(`INSERT INTO joi_goal_result_members (original_input_id,event_id,revision) VALUES ('snapshot-goal',?,?)`).run(`ev-${id}`, i);
        }
      });
      const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
      for (let round = 0; round < 7; round++) {
        const revision = round === 0 ? 163 : 163 + round;
        fixture.database.transaction(db => db.prepare("UPDATE joi_goal_result_sets SET revision=? WHERE original_input_id='snapshot-goal'").run(revision));
        const inputId = fixture.database.transaction(db => enqueueGoalResultSynthesis(db, "snapshot-goal", workbench.workbenchId, now));
        expect(inputId).not.toBeNull();
        if (round === 0) fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET body=? WHERE input_id=?")
          .run("LEGACY_CUMULATIVE_INVENTORY ".repeat(10_000), inputId));
        const loaded = await inbox.loadInput(inputId ?? "");
        if (loaded === null) throw new Error("Synthesis input must exist.");
        expect(loaded.body).not.toContain("summary 1");
        expect(loaded.body).not.toContain("MANDATORY_START");
        expect(loaded.body.length).toBeLessThan(6000);
        if (round === 0) expect(fixture.database.transaction(db => db.prepare("SELECT length(body) AS n FROM joi_inbox_messages WHERE input_id=?").get(inputId))?.n).toBeGreaterThan(200_000);
        expect(loaded.synthesisContext?.originalRequest).toBe(original);
        const background = composeJoiContinuationBackground(loaded);
        expect(background).toContain("work_read_evidence");
        expect(background).not.toContain("PRIVATE_BODY_");
        expect(background?.length).toBeLessThanOrEqual(24_000);
        if (round > 0) {
          expect(background).toContain(`previous conclusion ${String(round - 1)}`);
          expect(background).not.toContain("summary 1");
        }
        expect(await inbox.loadInput(inputId ?? "")).toEqual(loaded);
        fixture.database.transaction(db => {
          db.prepare(`INSERT INTO joi_goal_outcomes (input_id,result_revision,disposition,completion_summary,completed_at,updated_at)
            VALUES ('snapshot-goal',?,'CONTINUE',?,?,?) ON CONFLICT(input_id) DO UPDATE SET result_revision=excluded.result_revision,completion_summary=excluded.completion_summary`)
            .run(revision, `previous conclusion ${String(round)}`, now, now);
          db.prepare("UPDATE joi_goal_result_sets SET synthesized_revision=? WHERE original_input_id='snapshot-goal'").run(revision);
        });
      }
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM work_result_bodies").get())?.n).toBe(163);
    } finally { await fixture.close(); }
  });
});
