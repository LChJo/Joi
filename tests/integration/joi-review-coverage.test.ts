import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";
import { WorkResultService } from "../../src/main/application/work/work-result-service.js";
import { SqliteGoalEvidenceRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-evidence-repository.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { SqliteGoalRequirementsRepository } from "../../src/main/infrastructure/persistence/sqlite-goal-requirements-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import path from "node:path";

it("reuses unchanged requirement evidence alongside new evidence and reports the remaining gaps privately", async () => {
  const fixture = await createGoalEvidenceFixture([{}, {}, { verification: "FAILED" }]);
  try {
    const { workbenchId } = fixture;
    const report = { id: "report", kind: "DELIVERABLE", mandatory: true, scope: "SCOPED",
      text: "Deliver the report", source: { sourceRevision: 1, start: 0, end: 1 } };
    const oldAudit = { ...report, id: "audit", text: "List the old audit checks" };
    const audit = { ...oldAudit, text: "Run the new audit checks", source: { ...report.source, sourceRevision: 2 } };
    const appendix = { ...audit, id: "appendix", text: "Deliver the appendix" };
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO joi_goal_requirements VALUES ('goal',?,2,0)").run(workbenchId);
      const snapshot = db.prepare("INSERT INTO joi_goal_requirement_snapshots VALUES ('goal',?,?)");
      snapshot.run(1, JSON.stringify([report, oldAudit]));
      snapshot.run(2, JSON.stringify([report, audit, appendix]));
      db.exec(`UPDATE partner_runs SET requirements_revision=1,requirement_ids_json='["report","audit"]' WHERE run_id='run-1';
        UPDATE partner_runs SET requirements_revision=2,requirement_ids_json='["audit","appendix"]' WHERE run_id='run-2';
        UPDATE partner_runs SET requirements_revision=2,requirement_ids_json='["report"]' WHERE run_id='run-3';
        UPDATE joi_turns SET requirements_revision=2 WHERE turn_id='synthesis-turn';`);
      db.prepare("UPDATE joi_inbox_messages SET requirements_revision=2 WHERE input_id=?").run(fixture.inputId);
    });
    const results = new WorkResultService(fixture.repository, new SqliteGoalEvidenceRepository(fixture.database));
    const read = (resultId: string) => results.read({ goalInputId: "goal", workbenchId, resultId,
      receipt: { turnId: "synthesis-turn", toolCallId: resultId } });
    await read("result-1");
    const claim = { statement: "PRIVATE_SYNTHESIS_TEXT", requirementIds: ["report", "audit", "appendix"],
      resultIds: ["result-1", "result-2", "result-3"] };
    const synthesisState = { version: 1 as const, claims: [claim], unresolved: [], conflicts: [] };
    await expect(fixture.inbox.validateSynthesisState(fixture.inputId, synthesisState, true)).rejects.toMatchObject({
      code: "goal_synthesis_coverage_incomplete",
      issues: {
        missingRequirementIds: ["audit", "appendix"],
        citations: [
          { resultId: "result-1", reason: "REQUIREMENT_CHANGED", requirementIds: ["audit"] },
          { resultId: "result-2", reason: "MISSING_READ_RECEIPT" },
          { resultId: "result-3", reason: "INELIGIBLE_RESULT" },
        ],
      },
    });
    await expect(fixture.inbox.validateSynthesisState(fixture.inputId, { ...synthesisState,
      claims: [{ ...claim, requirementIds: ["audit"], resultIds: ["result-1"] }] }, true))
      .rejects.toMatchObject({ issues: { missingRequirementIds: ["report", "audit", "appendix"] } });
    await read("result-2");
    const optionalReview = { description: "An additional independent review could increase confidence", requirementIds: ["report"], resultIds: [] };
    const advisory = { ...optionalReview, advisory: true as const };
    await expect(fixture.inbox.validateSynthesisState(fixture.inputId, { ...synthesisState, unresolved: [advisory] }, true)).resolves.toBeUndefined();
    await expect(fixture.inbox.validateSynthesisState(fixture.inputId, { ...synthesisState, unresolved: [optionalReview] }, true))
      .rejects.toMatchObject({ code: "goal_synthesis_coverage_incomplete" });
    await expect(fixture.inbox.validateSynthesisState(fixture.inputId, { ...synthesisState, claims: [], unresolved: [advisory] }, true))
      .rejects.toMatchObject({ code: "goal_synthesis_coverage_incomplete" });
    await expect(fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", {
      outcome: "RESULT_CONTINUE", completionSummary: "Only an optional review remains.",
      synthesisState: { ...synthesisState, unresolved: [advisory] },
    })).rejects.toMatchObject({ code: "goal_synthesis_state_invalid" });
    await expect(fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", {
      outcome: "RESULT_SYNTHESIZED", completionSummary: "Existing report and new checks delivered.",
      synthesisState: { ...synthesisState, conflicts: [{ description: "Conflicting report review",
        requirementIds: ["report"], resultIds: ["result-3"],
        resolution: { rationale: "Use the verified report.", resultIds: ["result-1"] } }] },
    })).resolves.toMatchObject({ disposition: "COMPLETED" });
  } finally { await fixture.close(); }
});

it("REV-04 refuses to publish a completed synthesis with an omitted mandatory requirement", async () => {
  const fixture = await createGoalEvidenceFixture([{}]);
  try {
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO joi_goal_requirements (goal_input_id,workbench_id,revision,processed_source_revision) VALUES ('goal',?,1,0)").run(fixture.workbenchId);
      db.prepare("INSERT INTO joi_goal_requirement_snapshots (goal_input_id,revision,requirements_json) VALUES ('goal',1,?)")
        .run(JSON.stringify(["report","appendix"].map(id => ({ id,kind: "DELIVERABLE",mandatory: true,scope: "SCOPED",
          text: id,source: { sourceRevision: 1,start: 0,end: 1 } }))));
      db.exec(`UPDATE partner_runs SET requirements_revision=1,requirement_ids_json='["report"]';
        UPDATE joi_turns SET requirements_revision=1 WHERE turn_id='synthesis-turn';`);
      db.prepare("UPDATE joi_inbox_messages SET requirements_revision=1 WHERE input_id=?").run(fixture.inputId);
    });
    await expect(fixture.inbox.completeInput(fixture.inputId,"synthesis-turn",{
      outcome: "RESULT_SYNTHESIZED",completionSummary: "The report is present.",
      synthesisState: { version: 1,claims: [{ statement: "Report delivered",requirementIds: ["report"],resultIds: ["result-1"] }],unresolved: [],conflicts: [] },
    })).rejects.toMatchObject({ code: "goal_synthesis_coverage_incomplete" });
    expect(fixture.database.transaction(db => db.prepare("SELECT disposition FROM joi_goal_outcomes WHERE input_id='goal'").get())).toBeUndefined();
  } finally { await fixture.close(); }
});

it.each(["CONSUMED","ROUTED"])("rechecks an active legacy synthesis (%s), surfaces failure after restart and retries only coverage", async goalStatus => {
  const fixture = await createGoalEvidenceFixture([{}]);
  try {
    const { workbenchId } = fixture;
    const now = fixture.clock.now().toISOString();
    const harness = new SqliteJoiHarnessRepository(fixture.database);
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO joi_goal_requirements (goal_input_id,workbench_id,revision,processed_source_revision) VALUES ('goal',?,1,0)").run(workbenchId);
      db.prepare("INSERT INTO joi_goal_requirement_snapshots (goal_input_id,revision,requirements_json) VALUES ('goal',1,?)")
        .run(JSON.stringify([{ id: "report",kind: "DELIVERABLE",mandatory: true,scope: "SCOPED",text: "Deliver report",
          source: { sourceRevision: 1,start: 0,end: 1 } }]));
      db.prepare("UPDATE joi_goal_result_sets SET synthesized_revision=1,synthesized_requirements_revision=1 WHERE original_input_id='goal'").run();
      db.prepare("UPDATE joi_turns SET status='COMPLETED' WHERE turn_id='synthesis-turn'").run();
      db.prepare("UPDATE joi_inbox_messages SET status='CONSUMED' WHERE input_id=?").run(fixture.inputId);
      db.prepare("UPDATE joi_inbox_messages SET status=? WHERE input_id='goal'").run(goalStatus);
      db.prepare("UPDATE partner_runs SET requirements_revision=1,requirement_ids_json=?").run('["report"]');
      db.prepare(`INSERT INTO joi_goal_outcomes (input_id,result_revision,requirements_revision,disposition,completion_summary,completed_at,updated_at)
        VALUES ('goal',1,1,'COMPLETED','Legacy conclusion',?,?)`).run(now,now);
      db.prepare(`INSERT INTO joi_goal_outcome_history (goal_input_id,result_revision,requirements_revision,disposition,completion_summary,completed_at)
        VALUES ('goal',1,1,'COMPLETED','Legacy conclusion',?)`).run(now);
    });
    await harness.createMap({ goalInputId: "goal",workbenchId,now });
    await harness.synchronizeWorkPaths({ now });
    const [digest] = await harness.listReviewDigests();
    if (digest === undefined) throw new Error("Expected a goal awaiting review");
    expect(await harness.enqueueReview({ digest,now })).toBeNull();
    expect(await harness.enqueueReview({ digest,now })).toBeNull();
    const scheduled = fixture.database.transaction(db => ({
      inputs: db.prepare("SELECT input_id FROM joi_inbox_messages WHERE goal_input_id='goal' AND status='PENDING'").all(),
      dispatches: db.prepare("SELECT COUNT(*) AS n FROM dispatch_attempts").get()?.n,
    }));
    expect(scheduled.inputs).toEqual([{ input_id: "joi_result_input:goal:goal:r1:q1:coverage" }]);
    expect(scheduled.dispatches).toBe(1);
    const coverageId = "joi_result_input:goal:goal:r1:q1:coverage";
    fixture.database.transaction(db => {
      db.prepare(`UPDATE joi_inbox_messages SET status='CONSUMED',failed_at=?,failure_reason_code='goal_synthesis_coverage_incomplete'
        WHERE input_id=?`).run(now,coverageId);
    });
    const restored = await openRuntimeDatabase({ databasePath: path.join(fixture.root,"runtime.sqlite"),migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const feed = new SqliteJoiHomeFeedRepository(restored);
      expect((await feed.load(new Date(now))).goals.find(goal => goal.goalId === "goal")).toMatchObject({ status: "FAILED" });
      expect((await feed.loadGoalDetail("goal", {}))?.harness?.progress?.state).toBe("FAILED");
    } finally { restored.close(); }
    expect((await fixture.inbox.retry("goal",{}))?.status).toBe("CONSUMED");
    expect((await fixture.inbox.loadInput(coverageId))?.status).toBe("PENDING");
    await fixture.inbox.createTurn({ inputId: coverageId,turnId: "retry-coverage",workbenchId,createdAt: now,sessionId: "coverage-session",requirementsRevision: 1 });
    const evidence = new WorkResultService(fixture.repository,new SqliteGoalEvidenceRepository(fixture.database));
    await evidence.read({ goalInputId: "goal",workbenchId,resultId: "result-1",receipt: { turnId: "retry-coverage",toolCallId: "read" } });
    const completion = { outcome: "RESULT_SYNTHESIZED" as const,completionSummary: "Rechecked delivery.",
      synthesisState: { version: 1 as const,claims: [{ statement: "Report delivered",requirementIds: ["report"],resultIds: ["result-1"] }],unresolved: [],conflicts: [] } };
    await expect(fixture.inbox.completeInput(coverageId,"retry-coverage",completion)).resolves.toMatchObject({ goalOutcomePersisted: true });
    await expect(fixture.inbox.completeInput(coverageId,"retry-coverage",completion)).resolves.toMatchObject({ goalOutcomePersisted: false });
    expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM dispatch_attempts").get())?.n).toBe(1);
  } finally { await fixture.close(); }
});

it.each(["valid","missing","withdrawn","recovered"])("applies the real coverage gate to a %s plain-text synthesis", async evidenceStatus => {
  const fixture = await createGoalEvidenceFixture([{}]);
  try {
    const { workbenchId } = fixture;
    const now = fixture.clock.now().toISOString();
    const draft = { version: 1,claims: [{ statement: "Report delivered",requirementIds: ["report"],resultIds: ["result-1"],verification: "VERIFIED" }],
      unresolved: [],conflicts: [],resultRevision: 1,requirementsRevision: 1,source: "MODEL" };
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO joi_goal_requirements VALUES ('goal',?,1,1)").run(workbenchId);
      db.prepare(`INSERT INTO joi_goal_requirement_sources (goal_input_id,source_revision,kind,body,body_chars,read_offset)
        VALUES ('goal',1,'USER','Deliver the report',18,18)`).run();
      db.prepare("INSERT INTO joi_goal_requirement_snapshots VALUES ('goal',1,?)").run(JSON.stringify([
        { id: "report",kind: "DELIVERABLE",mandatory: true,scope: "SCOPED",text: "Deliver the report",source: { sourceRevision: 1,start: 0,end: 1 } },
      ]));
      db.prepare("UPDATE partner_runs SET requirements_revision=1,requirement_ids_json=?").run('["report"]');
      db.prepare("UPDATE joi_inbox_messages SET requirements_revision=1 WHERE input_id=?").run(fixture.inputId);
      db.prepare(`INSERT INTO joi_goal_outcomes (input_id,result_revision,requirements_revision,disposition,completion_summary,completed_at,updated_at,synthesis_state_json)
        VALUES ('goal',1,1,'CONTINUE','Uncommitted coverage',?,?,?)`).run(now,now,JSON.stringify(draft));
    });
    const results = new WorkResultService(fixture.repository,new SqliteGoalEvidenceRepository(fixture.database));
    if (evidenceStatus === "valid" || evidenceStatus === "withdrawn") {
      await results.read({ goalInputId: "goal",workbenchId,resultId: "result-1",receipt: { turnId: "synthesis-turn",toolCallId: "prior-read" } });
    }
    fixture.database.transaction(db => {
      db.prepare("UPDATE joi_turns SET status='COMPLETED' WHERE turn_id='synthesis-turn'").run();
      if (evidenceStatus === "withdrawn") db.prepare("UPDATE work_result_verifications SET status='FAILED' WHERE result_id='result-1'").run();
    });
    const coordinator = new JoiCoordinator({
      clock: fixture.clock,ids: fixture.ids,workbenches: fixture.workbenches,
      store: {
        loadInput: id => fixture.inbox.loadInput(id),
        createTurn: ({ inputId,turnId,workbenchId,sessionId,createdAt,requirementsRevision }) =>
          fixture.inbox.createTurn({ inputId,turnId,workbenchId,sessionId,createdAt,
            ...(requirementsRevision === undefined ? {} : { requirementsRevision }) }),
        validateSynthesisState: (id,state,completing) => fixture.inbox.validateSynthesisState(id,state,completing),
        completeInput: (id,turnId,completion) => fixture.inbox.completeInput(id,turnId,completion),
        failTurn: (id,turnId,failure) => fixture.inbox.failTurn(id,turnId,failure),
        requireClarification: (id,reason) => fixture.inbox.requireClarification(id,reason),
      },
      requirements: new SqliteGoalRequirementsRepository(fixture.database),
      sources: { selectInitial: turnId => Promise.resolve({ turnId,modelId: "fake",modelRevisionId: "fake-r",sourceId: "fake",sourceRevisionId: "fake-r" }) },
      router: { decide: () => Promise.reject(new Error("Pre-bound workbench")) },
      runtime: {
        abort: () => undefined,followUp: () => undefined,steer: () => undefined,isRunning: () => false,
        restore: () => Promise.resolve(false),rollbackTurn: () => Promise.resolve(true),waitForIdle: () => Promise.resolve(),
        startTurn: async turn => {
          if (evidenceStatus === "recovered" && turn.repair === "synthesis-disposition") {
            await results.read({ goalInputId: "goal",workbenchId,resultId: "result-1",receipt: { turnId: turn.turnId,toolCallId: "recovery-read" } });
          }
          const delta = evidenceStatus === "missing" && turn.repair === "synthesis-disposition"
            ? "[joi synthesis outcome=RESULT_CONTINUE]\nThe report exists. The next review can read and verify it."
            : "[joi synthesis outcome=RESULT_SYNTHESIZED]\nComplete report.";
          turn.onEvent?.({ type: "text_delta",turnId: turn.turnId,delta });
          turn.onEvent?.({ type: "turn_finished",turnId: turn.turnId });
        },
      },
    });
    await coordinator.handle(fixture.inputId);
    const outcome = fixture.database.transaction(db => db.prepare("SELECT disposition,completion_summary FROM joi_goal_outcomes WHERE input_id='goal'").get());
    const covered = evidenceStatus === "valid" || evidenceStatus === "recovered";
    expect(outcome?.disposition).toBe(covered ? "COMPLETED" : evidenceStatus === "missing" ? "CONTINUE" : "BLOCKED");
    if (!covered) expect(outcome?.completion_summary).not.toBe("Complete report.");
    expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM dispatch_attempts").get())?.n).toBe(1);
    if (evidenceStatus === "missing") {
      const harness = new SqliteJoiHarnessRepository(fixture.database);
      await harness.createMap({ goalInputId: "goal", workbenchId, now });
      const [digest] = await harness.listReviewDigests();
      if (digest === undefined) throw new Error("Expected a continuation awaiting review");
      await expect(harness.enqueueReview({ digest, now })).resolves.toMatch(/^joi_harness_review:/u);
      expect((await harness.listReviewDigests())).toEqual([]);
    }
  } finally { await fixture.close(); }
});

it.each(["optional","resolved"])("keeps a %s conflict visible without blocking covered mandatory requirements", async kind => {
  const fixture = await createGoalEvidenceFixture([{},{}]);
  try {
    const { workbenchId } = fixture;
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO joi_goal_requirements VALUES ('goal',?,1,0)").run(workbenchId);
      db.prepare("INSERT INTO joi_goal_requirement_snapshots VALUES ('goal',1,?)").run(JSON.stringify(
        ["report","format"].map(id => ({ id,kind: "DELIVERABLE",mandatory: id === "report",scope: "SCOPED",
          text: id,source: { sourceRevision: 1,start: 0,end: 1 } }))));
      db.exec(`UPDATE partner_runs SET requirements_revision=1,requirement_ids_json='["report"]' WHERE run_id='run-1';
        UPDATE partner_runs SET requirements_revision=1,requirement_ids_json='["format"]' WHERE run_id='run-2';
        UPDATE joi_turns SET requirements_revision=1 WHERE turn_id='synthesis-turn';`);
      db.prepare("UPDATE joi_inbox_messages SET requirements_revision=1 WHERE input_id=?").run(fixture.inputId);
    });
    const results = new WorkResultService(fixture.repository,new SqliteGoalEvidenceRepository(fixture.database));
    await results.read({ goalInputId: "goal",workbenchId,resultId: "result-1",receipt: { turnId: "synthesis-turn",toolCallId: "read-1" } });
    await results.read({ goalInputId: "goal",workbenchId,resultId: "result-2",receipt: { turnId: "synthesis-turn",toolCallId: "read-2" } });
    const claim = { statement: "Report and format were checked.",requirementIds: ["report","format"],resultIds: ["result-1","result-2"] };
    const submit = (requirementIds: string[],resolution?: { rationale: string; resultIds: string[] }) =>
      fixture.inbox.completeInput(fixture.inputId,"synthesis-turn",{
        outcome: "RESULT_SYNTHESIZED",completionSummary: "The report is present.",
        synthesisState: { version: 1,claims: [claim],unresolved: [],conflicts: [
          { description: "Two formats were reported.",resultIds: ["result-1"],requirementIds,...(resolution === undefined ? {} : { resolution }) },
        ] },
      });
    await expect(submit(["report"])).rejects.toMatchObject({ code: "goal_synthesis_coverage_incomplete" });
    await expect(submit(["report"],{ rationale: "Different output verified.",resultIds: ["unknown"] })).rejects.toMatchObject({ code: "goal_synthesis_reference_invalid" });
    await expect(submit(["report"],{ rationale: "Only the optional format was checked.",resultIds: ["result-2"] }))
      .rejects.toMatchObject({ code: "goal_synthesis_coverage_incomplete" });
    const disposition = kind === "optional" ? submit(["format"])
      : submit(["report"],{ rationale: "The accepted report verifies the final format.",resultIds: ["result-1"] });
    await expect(disposition).resolves.toMatchObject({ disposition: "COMPLETED" });
    expect(String(fixture.database.transaction(db => db.prepare("SELECT synthesis_state_json FROM joi_goal_outcomes WHERE input_id='goal'").get())?.synthesis_state_json))
      .toContain("Two formats were reported.");
  } finally { await fixture.close(); }
});

it("REV-05 reuses a durable read for clearance and rejects a subsequently invalidated result", async () => {
  const fixture = await createGoalEvidenceFixture([{}]);
  try {
    const { workbenchId } = fixture;
    const now = fixture.clock.now().toISOString();
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO joi_goal_requirements (goal_input_id,workbench_id,revision,processed_source_revision) VALUES ('goal',?,1,0)").run(workbenchId);
      db.prepare("INSERT INTO joi_goal_requirement_snapshots (goal_input_id,revision,requirements_json) VALUES ('goal',1,?)")
        .run(JSON.stringify([{ id: "report",kind: "DELIVERABLE",mandatory: true,scope: "SCOPED",
          text: "Deliver a report",source: { sourceRevision: 1,start: 0,end: 1 } }]));
      db.exec(`UPDATE partner_runs SET requirements_revision=1,requirement_ids_json='["report"]';
        UPDATE joi_turns SET requirements_revision=1 WHERE turn_id='synthesis-turn';`);
      db.prepare("UPDATE joi_inbox_messages SET requirements_revision=1 WHERE input_id=?").run(fixture.inputId);
    });
    const completion = { outcome: "RESULT_SYNTHESIZED" as const,completionSummary: "The synthetic report is present.",
      synthesisState: { version: 1 as const,claims: [{ statement: "Report delivered",requirementIds: ["report"],resultIds: ["result-1"] }],
        unresolved: [],conflicts: [] } };
    await expect(fixture.inbox.completeInput(fixture.inputId,"synthesis-turn",completion))
      .rejects.toMatchObject({ code: "goal_synthesis_coverage_incomplete" });
    const results = new WorkResultService(fixture.repository,new SqliteGoalEvidenceRepository(fixture.database));
    await results.read({ goalInputId: "goal",workbenchId,resultId: "result-1",receipt: { turnId: "synthesis-turn",toolCallId: "read-1" } });
    await results.read({ goalInputId: "goal",workbenchId,resultId: "result-1",receipt: { turnId: "synthesis-turn",toolCallId: "read-1" } });
    const recoveredReader = new WorkResultService(fixture.repository,new SqliteGoalEvidenceRepository(fixture.database));
    const { entries,total } = await recoveredReader.readRoadmap({ goalInputId: "goal",workbenchId,section: "reads",resultId: "result-1" });
    expect(total).toBe(1);
    expect(entries[0]).toMatchObject({ resultId: "result-1",start: 0 });
    await expect(fixture.inbox.completeInput(fixture.inputId,"synthesis-turn",completion)).resolves.toMatchObject({ disposition: "COMPLETED" });
    const harness = new SqliteJoiHarnessRepository(fixture.database);
    await harness.createMap({ goalInputId: "goal",workbenchId,now });
    await harness.synchronizeWorkPaths({ now });
    const [digest] = await harness.listReviewDigests();
    if (digest === undefined) throw new Error("Expected review digest");
    const inputId = await harness.enqueueReview({ digest,now });
    if (inputId === null) throw new Error("Expected review");
    await fixture.inbox.createTurn({ inputId,turnId: "review",workbenchId,createdAt: now,sessionId: "review-session",requirementsRevision: 1 });
    fixture.database.transaction(db => db.prepare("UPDATE work_result_verifications SET status='FAILED' WHERE result_id='result-1'").run());
    expect(await harness.clearMap({ goalInputId: "goal",turnId: "review" })).toBe(false);
    fixture.database.transaction(db => db.prepare("UPDATE work_result_verifications SET status='PASSED' WHERE result_id='result-1'").run());
    expect(await harness.clearMap({ goalInputId: "goal",turnId: "review" })).toBe(true);
  } finally { await fixture.close(); }
});
