import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture.js";

async function seedSynthesis(fixture: RuntimeFixture) {
  const wb = await fixture.workbenchRegistry.create({ name: "Evidence", personaSummary: "Careful", projectLabel: "Test", scopeSummary: "Test" });
  const now = fixture.clock.now().toISOString();
  const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const harness = new SqliteJoiHarnessRepository(fixture.database);
  const synthesisId = "joi_result_input:goal:goal:r1:q0";
  fixture.database.transaction(db => {
    db.prepare(`INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
      VALUES ('goal','goal','Return evidence','CONSUMED',?,?,?)`).run(wb.workbenchId, now, now);
    db.prepare(`INSERT INTO joi_turns(turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
      VALUES ('original','goal',?,'original','COMPLETED',?,?)`).run(wb.workbenchId, now, now);
    db.prepare(`INSERT INTO work_items(work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
      VALUES ('work',?,'goal','Evidence','{}','READ','COMPLETED',?,?)`).run(wb.workbenchId, now, now);
    db.prepare(`INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,workbench_id,goal_input_id,result_revision,requirements_revision,created_at,updated_at)
      VALUES (?,?,'Synthesize evidence','PENDING',?,'goal',1,0,?,?)`).run(synthesisId, synthesisId, wb.workbenchId, now, now);
    db.prepare(`INSERT INTO joi_goal_result_sets(original_input_id,revision,synthesized_revision,synthetic_input_id,updated_at)
      VALUES ('goal',1,0,?,?)`).run(synthesisId, now);
  });
  const park = () => inbox.park(synthesisId, { failureCount: 8, reasonCode: "joi_turn_outcome_uncommitted" });
  const scan = () => harness.listStalledSyntheses({ now: fixture.clock.now().toISOString(), cooldownMillis: 600_000 });
  return { inbox, harness, synthesisId, wb, park, scan };
}

describe("synthesis failure convergence", () => {
  it("keeps a current synthesis failure visible when requirements still need processing", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { wb, park } = await seedSynthesis(fixture);
      await park();
      await new SqliteGoalRequirementsRepository(fixture.database).ensure({ goalInputId: "goal", workbenchId: wb.workbenchId });
      expect((await fixture.joiHomeFeed.load()).goals[0]).toMatchObject({ status: "FAILED", failure: { attempts: 8 } });
    } finally { await fixture.close(); }
  });

  it("durably parks a synthesis consumed by a failed terminal tool call", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { inbox, synthesisId, wb, park, scan } = await seedSynthesis(fixture);
      await inbox.createTurn({ inputId: synthesisId, turnId: "failed-commit", sessionId: "synthesis", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString() });
      await inbox.recordTurnProgress("failed-commit", { formalOutputStarted: false, sideEffectStarted: true });
      await inbox.failTurn(synthesisId, "failed-commit", { reasonCode: "joi_turn_outcome_uncommitted" });
      expect(await inbox.loadInput(synthesisId)).toMatchObject({ status: "CONSUMED" });
      expect(await park()).toMatchObject({ failureReasonCode: "joi_turn_outcome_uncommitted", failureCount: 8 });
      fixture.clock.advance(3_600_000);
      expect(await scan()).toEqual([]);
      expect((await fixture.joiHomeFeed.load()).goals[0]).toMatchObject({ status: "FAILED" });
    } finally { await fixture.close(); }
  });

  it("does not project or revive a parked synthesis for superseded requirements", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { wb, inbox, synthesisId, park } = await seedSynthesis(fixture);
      await park();
      const requirements = new SqliteGoalRequirementsRepository(fixture.database);
      await requirements.ensure({ goalInputId: "goal", workbenchId: wb.workbenchId });
      await requirements.readSource({ goalInputId: "goal", workbenchId: wb.workbenchId, sourceRevision: 1, offset: 0 });
      await requirements.update({ goalInputId: "goal", workbenchId: wb.workbenchId, expectedRevision: 0, processedSourceRevision: 1,
        upserts: [{ id: "objective", text: "Return evidence", kind: "OBJECTIVE", scope: "GLOBAL", mandatory: true, source: { sourceRevision: 1, start: 0, end: 15 } }], retirements: [] });
      const goal = (await fixture.joiHomeFeed.load()).goals[0];
      expect(goal?.failure).toBeUndefined();
      expect(goal?.status).not.toBe("FAILED");
      await inbox.retry("goal", {});
      expect(await inbox.loadInput(synthesisId)).toMatchObject({ status: "CONSUMED" });
    } finally { await fixture.close(); }
  });

  it.each(["partial", "empty", "execution-error", "successful", "late"] as const)("classifies %s partner output without changing execution or verification facts", async scenario => {
    const fixture = await createRuntimeFixture();
    try {
      const { wb } = await seedSynthesis(fixture);
      const partner = await fixture.partners.add({ displayName: "Reader", capabilities: [], kind: "local-pi", tools: [], skills: [] });
      const instance = await fixture.instances.ensure({ workbenchId: wb.workbenchId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const now = fixture.clock.now().toISOString();
      const status = scenario === "successful" ? "COMPLETED" : "FAILED";
      fixture.database.transaction(db => {
        db.prepare("UPDATE partner_instances SET status='DISPOSED',disposal_reason=?,disposed_at=? WHERE instance_id=?")
          .run(scenario === "successful" ? "ephemeral_completed" : "ephemeral_failed", now, instance.instanceId);
        db.prepare("INSERT INTO dispatch_plans(dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at) VALUES ('plan','original','{}','{}',?)").run(now);
        db.prepare(`INSERT INTO dispatch_attempts(dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,instance_id,status,created_at,updated_at)
          VALUES ('attempt','plan','work',?,1,'action',?,?,?,?)`).run(instance.partnerRevisionId, instance.instanceId, status, now, now);
        db.prepare(`INSERT INTO partner_runs(run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at)
          VALUES ('run','attempt','action',?,'work',?,'LOCAL_PI','external',?,?,?)`).run(wb.workbenchId, instance.partnerRevisionId, status, now, now);
        db.prepare("INSERT INTO work_result_bodies(body_ref,body,created_at) VALUES ('body',?,?)").run(scenario === "empty" ? " " : "Evidence has been collected; one acceptance check remains unverified.", now);
        db.prepare(`INSERT INTO work_results(result_id,run_id,action_id,workbench_id,work_id,partner_revision_id,instance_id,status,summary,body_ref,artifacts_json,is_late,is_authoritative,created_at)
          VALUES ('result','run','action',?,'work',?,?,?,'Receipt','body','[]',?,?,?)`).run(wb.workbenchId, instance.partnerRevisionId, instance.instanceId, status, scenario === "late" ? 1 : 0, scenario === "late" ? 0 : 1, now);
        db.prepare("INSERT INTO work_result_verifications(result_id,status,reason_code,created_at) VALUES ('result',?,'verification_file_missing',?)")
          .run(scenario === "execution-error" ? "NOT_REQUIRED" : scenario === "successful" ? "PASSED" : "FAILED", now);
      });
      const repository = new SqliteWorkbenchAgentRepository(fixture.database);
      for (const goalId of ["goal", undefined]) {
        const [card] = (await repository.listAgents({ workbenchId: wb.workbenchId, limit: 20, ...(goalId === undefined ? {} : { goalId }) })).items;
        if (scenario === "partial") expect(card).toMatchObject({ resultAssessment: "INSUFFICIENT" });
        else expect(card).not.toHaveProperty("resultAssessment");
      }
      expect(fixture.database.transaction(db => db.prepare("SELECT status FROM partner_runs WHERE run_id='run'").get())?.status).toBe(status);
    } finally { await fixture.close(); }
  });

  it("shows a parked current synthesis as a safe failed goal and keeps the projection read-only", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { inbox, synthesisId, park } = await seedSynthesis(fixture);
      await park();
      const before = await inbox.loadInput(synthesisId);
      for (let i = 0; i < 2; i++) {
        expect((await fixture.joiHomeFeed.load()).goals[0]).toMatchObject({
          goalId: "goal", status: "FAILED", canArchive: true, canDelete: false,
          work: { total: 1, completed: 1, active: 0 },
          failure: { attempts: 8, reasonCode: "joi_turn_outcome_uncommitted", suggestedAction: "RETRY_OR_EXPORT_DIAGNOSTICS" },
        });
      }
      expect(await inbox.loadInput(synthesisId)).toEqual(before);
    } finally { await fixture.close(); }
  });

  it("keeps a parked synthesis stopped across cooldowns and repository reconstruction", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { synthesisId, park, scan } = await seedSynthesis(fixture);
      await park();
      fixture.clock.advance(3_600_000);
      expect(await scan()).toEqual([]);
      const rebuilt = new SqliteJoiHarnessRepository(fixture.database);
      expect(await rebuilt.redriveSynthesis({ now: fixture.clock.now().toISOString(), seed: { goalInputId: "goal", resultRevision: 1 } })).toBe(false);
      expect(fixture.database.transaction(db => db.prepare("SELECT status,failure_count FROM joi_inbox_messages WHERE input_id=?").get(synthesisId)))
        .toEqual({ status: "CONSUMED", failure_count: 8 });
    } finally { await fixture.close(); }
  });

  it.each(["park", "cancel", "new-revision", "live-work", "live-turn", "question"] as const)("rechecks a %s change between scanning and re-driving", async change => {
    const fixture = await createRuntimeFixture();
    try {
      const { inbox, harness, synthesisId, wb, park, scan } = await seedSynthesis(fixture);
      fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET status='CONSUMED' WHERE input_id=?").run(synthesisId));
      fixture.clock.advance(600_000);
      const [seed] = await scan();
      if (seed === undefined) throw new Error("Missing recovery candidate");
      if (change === "park") {
        fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET status='PENDING' WHERE input_id=?").run(synthesisId));
        await park();
      }
      if (change === "cancel") fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET canceled_at=? WHERE input_id='goal'").run(fixture.clock.now().toISOString()));
      if (change === "new-revision") fixture.database.transaction(db => db.prepare("UPDATE joi_goal_result_sets SET revision=2 WHERE original_input_id='goal'").run());
      if (change === "live-work") fixture.database.transaction(db => db.prepare("UPDATE work_items SET status='RUNNING' WHERE work_id='work'").run());
      if (change === "live-turn") await inbox.createTurn({ inputId: "goal", turnId: "live", sessionId: "live", workbenchId: wb.workbenchId, createdAt: fixture.clock.now().toISOString() });
      if (change === "question") await inbox.requireClarification("goal", "question_required", "Choose a scope");
      expect(await harness.redriveSynthesis({ now: fixture.clock.now().toISOString(), seed })).toBe(false);
    } finally { await fixture.close(); }
  });

  it("retries only the parked synthesis on explicit continuation without replaying completed work", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { inbox, synthesisId, park } = await seedSynthesis(fixture);
      await park();
      fixture.clock.advance(1_000);
      await inbox.retry("goal", {});
      expect(await inbox.loadInput(synthesisId)).toMatchObject({ status: "PENDING" });
      expect(fixture.database.transaction(db => db.prepare("SELECT failed_at,failure_reason_code,failure_count FROM joi_inbox_messages WHERE input_id=?").get(synthesisId)))
        .toEqual({ failed_at: null, failure_reason_code: null, failure_count: null });
      expect(fixture.database.transaction(db => db.prepare("SELECT input_id FROM joi_inbox_messages WHERE status='PENDING'").all()))
        .toEqual([{ input_id: synthesisId }]);
      const goal = (await fixture.joiHomeFeed.load()).goals[0];
      expect(goal).toMatchObject({ status: "FINALIZING", work: { total: 1, completed: 1, active: 0 } });
      expect(goal?.failure).toBeUndefined();
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind='partner.dispatch'").get())?.n).toBe(0);
    } finally { await fixture.close(); }
  });

  it("ignores an older parked synthesis when a newer result input is current", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const { synthesisId, wb, park } = await seedSynthesis(fixture);
      await park();
      fixture.database.transaction(db => {
        const now = fixture.clock.now().toISOString();
        db.prepare(`INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,workbench_id,goal_input_id,result_revision,created_at,updated_at)
          VALUES ('new-synthesis','new-synthesis','Synthesize new evidence','PENDING',?,'goal',2,?,?)`).run(wb.workbenchId, now, now);
        db.prepare("UPDATE joi_goal_result_sets SET revision=2,synthetic_input_id='new-synthesis' WHERE synthetic_input_id=?").run(synthesisId);
      });
      const goal = (await fixture.joiHomeFeed.load()).goals[0];
      expect(goal).toMatchObject({ status: "FINALIZING" });
      expect(goal?.failure).toBeUndefined();
    } finally { await fixture.close(); }
  });
});
