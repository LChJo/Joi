import { createWorkResult } from "../../src/main/domain/work/work-result.js";
import type { WorkHandoff } from "../../src/main/domain/work/work-handoff.js";
import { SqliteWorkResultRepository } from "../../src/main/infrastructure/persistence/sqlite-work-result-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { enqueueGoalResultSynthesis } from "../../src/main/infrastructure/persistence/sqlite-goal-result-synthesis.js";
import { createRuntimeFixture } from "./runtime-fixture.js";

export async function createGoalEvidenceFixture(results: { handoff?: WorkHandoff; status?: "COMPLETED" | "FAILED"; verification?: "PASSED" | "FAILED" | "NOT_REQUIRED" }[]) {
  const fixture = await createRuntimeFixture();
  const wb = await fixture.workbenchRegistry.create({ name: "Synthetic", personaSummary: "fixture", projectLabel: "fixture", scopeSummary: "fixture" });
  const partner = await fixture.partners.add({ capabilities: [], displayName: "Synthetic", kind: "local-pi", skills: [], tools: [] });
  const now = fixture.clock.now().toISOString();
  fixture.database.transaction(db => {
    db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
      VALUES ('goal','goal-key','Complete the synthetic research','CONSUMED',?,?,?)`).run(wb.workbenchId, now, now);
    db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
      VALUES ('original-turn','goal',?,'original-session','COMPLETED',?,?)`).run(wb.workbenchId, now, now);
    db.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at)
      VALUES ('plan','original-turn','{}','[]',?)`).run(now);
    db.prepare(`INSERT INTO joi_goal_result_sets (original_input_id,revision,synthesized_revision,updated_at)
      VALUES ('goal',?,0,?)`).run(results.length, now);
  });
  const repository = new SqliteWorkResultRepository(fixture.database);
  for (const [index, spec] of results.entries()) {
    const id = String(index + 1);
    fixture.database.transaction(db => {
      db.prepare(`INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
        VALUES (?,?,'goal',?,'{}','READ','RUNNING',?,?)`).run(`work-${id}`, wb.workbenchId, `Work ${id}`, now, now);
      db.prepare(`INSERT INTO dispatch_attempts (dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,status,created_at,updated_at)
        VALUES (?,'plan',?,?,1,?,'RUNNING',?,?)`).run(`attempt-${id}`, `work-${id}`, partner.partnerRevisionId, `action-${id}`, now, now);
      db.prepare(`INSERT INTO partner_runs (run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'LOCAL_PI',?,'RUNNING',?,?)`).run(`run-${id}`, `attempt-${id}`, `action-${id}`, wb.workbenchId, `work-${id}`, partner.partnerRevisionId, `external-${id}`, now, now);
    });
    const result = createWorkResult({ actionId: `action-${id}`, artifacts: [], workbenchId: wb.workbenchId,
      body: `${"Opening preview. ".repeat(80)} PRIVATE_MIDDLE_${id} meaningful conclusion.`, createdAt: now,
      isLate: false, partnerRevisionId: partner.partnerRevisionId, resultId: `result-${id}`, runId: `run-${id}`, status: spec.status ?? "COMPLETED",
      verification: { status: spec.verification ?? "PASSED" }, workId: `work-${id}`,
      ...(spec.handoff === undefined ? {} : { handoff: spec.handoff }) });
    await repository.record(result);
    fixture.database.transaction(db => db.prepare(`INSERT INTO joi_goal_result_members (original_input_id,event_id,revision)
      VALUES ('goal',?,?)`).run(`partner_result:run-${id}:${result.status}`, index + 1));
  }
  const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const inputId = fixture.database.transaction(db => enqueueGoalResultSynthesis(db, "goal", wb.workbenchId, now));
  if (inputId === null) throw new Error("Synthetic synthesis must be queued.");
  await inbox.createTurn({ workbenchId: wb.workbenchId, createdAt: now, inputId, sessionId: "synthesis-session", turnId: "synthesis-turn" });
  return { ...fixture, inbox, inputId, repository, workbenchId: wb.workbenchId };
}
