/* Synthetic model and persistence ports keep every side effect inside the fixture. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { DomainError } from "../../src/main/domain/errors.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiHarnessRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-harness-repository.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { createJoiReasoningTools } from "../../src/main/infrastructure/pi/joi-reasoning-tools.js";
import type { JoiCoordinatorStore } from "../../src/main/application/ports/joi-coordinator.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import type { WorkOrchestrationService } from "../../src/main/application/work/work-orchestration-service.js";
import { createRuntimeFixture, TestIds } from "../support/runtime-fixture.js";

async function setup() {
  const fixture = await createRuntimeFixture();
  const workbench = await fixture.workbenchRegistry.create({ name: "Synthetic", personaSummary: "Synthetic", projectLabel: "Synthetic", scopeSummary: "Synthetic" });
  const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
  const now = fixture.clock.now().toISOString();
  await inbox.create({ inputId: "goal", idempotencyKey: "goal", body: "Synthetic task", workbenchId: workbench.workbenchId, status: "PENDING", createdAt: now, updatedAt: now });
  await inbox.createTurn({ inputId: "goal", turnId: "historical-turn", sessionId: "history", workbenchId: workbench.workbenchId, createdAt: now });
  fixture.database.transaction(db => {
    db.prepare("UPDATE joi_turns SET status='COMPLETED' WHERE turn_id='historical-turn'").run();
    db.prepare(`INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
      VALUES ('completed-work',?,'goal','Synthetic','{}','READ','COMPLETED',?,?)`).run(workbench.workbenchId,now,now);
    db.prepare(`INSERT INTO joi_harness_maps (goal_input_id,workbench_id,status,revision,reviewed_revision,created_at,updated_at)
      VALUES ('goal',?,'ACTIVE',1,0,?,?)`).run(workbench.workbenchId,now,now);
    db.prepare(`INSERT INTO joi_goal_result_sets (original_input_id,revision,synthesized_revision,updated_at)
      VALUES ('goal',1,1,?)`).run(now);
    db.prepare(`INSERT INTO joi_goal_outcomes (input_id,result_revision,disposition,completion_summary,completed_at,updated_at)
      VALUES ('goal',1,'COMPLETED','Synthetic established result',?,?)`).run(now,now);
  });
  fixture.clock.advance(1_000);
  fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET status='PENDING',reopened_at=? WHERE input_id='goal'").run(fixture.clock.now().toISOString()));
  return { fixture, workbench, inbox };
}

async function dispatchScenario(corrected: boolean) {
  const { fixture, workbench, inbox } = await setup();
  try {
    let attempts = 0, commits = 0, indexReads = 0;
    const snapshots = new Map<string,JoiReasoningSessionSnapshot>();
    const faux = fauxProvider({ provider: `stability-${String(corrected)}` });
    const dispatch = (resultId: string) => fauxAssistantMessage([fauxToolCall("work_dispatch", {
      work: [{ key: "remaining", partnerId: "synthetic-partner", title: "Synthetic remaining task", accessMode: "READ", executionNeeds: [],
        instructions: "Synthetic remaining work", acceptanceChecks: [{ kind: "BODY_PRESENT" }], evidenceResultIds: [resultId] }],
    })], { stopReason: "toolUse" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("harness_name_destination", { destination: "Synthetic destination" })], { stopReason: "toolUse" }),
      dispatch("missing-result"),
      ...(corrected ? [fauxAssistantMessage([fauxToolCall("work_read_evidence", { mode: "index" })], { stopReason: "toolUse" })] : []),
      dispatch(corrected ? "known-result" : "missing-result"),
      fauxAssistantMessage([fauxText("Synthetic completion")]),
    ]);
    const models = createModels(); models.setProvider(faux.provider);
    const runtime = new PiReasoningRuntime({ model: faux.getModel(), models, thinkingLevel: "off",
      sessionStore: { load: async id => snapshots.get(id) ?? null, save: async snapshot => { snapshots.set(snapshot.sessionId, structuredClone(snapshot)); } },
      tools: turn => createJoiReasoningTools({ workbenchId: workbench.workbenchId,inputId: "goal",turnId: turn.turnId,
        workbenchChanges: {} as never,workbenchWorkspaces: {} as never,directoryPicker: async () => null,workbenches: {} as never,
        clarifications: inbox,instances: {} as never,memory: {} as never,models: {} as never,partners: {} as never,skills: {} as never,
        harness: new SqliteJoiHarnessRepository(fixture.database),results: { index: async () => { indexReads++; return { results: [{ resultId: "known-result" }] }; } } as never,
        work: { plan: async (input: Parameters<WorkOrchestrationService["plan"]>[0]) => {
          attempts++;
          if (input.work.some(item => item.evidenceResultIds?.includes("missing-result"))) throw new DomainError("work_evidence_reference_invalid","Synthetic missing reference");
          input.onCommitStart?.(); commits++;
          fixture.database.transaction(db => db.prepare(`INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
            VALUES ('remaining-work',?,'goal','Synthetic','{}','READ','READY',?,?)`).run(workbench.workbenchId,fixture.clock.now().toISOString(),fixture.clock.now().toISOString()));
          return { dispatchPlanId: "synthetic-plan",denied: [],queued: [],waves: [["remaining-work"]] };
        } } as never,
      }),
    });
    const coordinator = new JoiCoordinator({ workbenches: { getWorkbench: async () => workbench,listSummaries: async () => [] },clock: fixture.clock,ids: new TestIds(),
      router: { decide: async () => { throw new Error("Synthetic unused router"); } },runtime,
      sources: { selectInitial: async turnId => ({ modelId: "synthetic",modelRevisionId: "synthetic",sourceId: "synthetic",sourceRevisionId: "synthetic",turnId }) },
      store: { loadInput: inbox.loadInput.bind(inbox),createTurn: input => inbox.createTurn({ inputId: input.inputId,turnId: input.turnId,sessionId: input.sessionId,workbenchId: input.workbenchId,createdAt: input.createdAt }),
        recordTurnProgress: inbox.recordTurnProgress.bind(inbox),failTurn: inbox.failTurn.bind(inbox),completeInput: inbox.completeInput.bind(inbox),requireClarification: inbox.requireClarification.bind(inbox) } satisfies JoiCoordinatorStore,
    });
    if (corrected) await expect(coordinator.handle("goal")).resolves.toBeUndefined();
    else await expect(coordinator.handle("goal")).rejects.toMatchObject({ code: "work_evidence_reference_invalid" });
    expect(attempts).toBe(2);
    expect(commits).toBe(corrected ? 1 : 0);
    expect(indexReads).toBe(corrected ? 1 : 0);
    expect(fixture.database.transaction(db => db.prepare("SELECT status FROM work_items WHERE work_id='completed-work'").get())).toEqual({ status: "COMPLETED" });
    if (!corrected) {
      expect((await inbox.list()).find(row => row.inputId === "goal")).toMatchObject({ status: "CONSUMED",failureReasonCode: "work_evidence_reference_invalid",failureCount: 1 });
      expect((await new SqliteJoiHomeFeedRepository(fixture.database).loadGoalDetail("goal",{}))?.harness?.progress?.state).toBe("FAILED");
      expect(await inbox.retry("goal",{})).toMatchObject({ status: "PENDING" });
    }
  } finally { await fixture.close(); }
}

describe("continued goal orchestration stability (AC-46/53/64/67)", () => {
  it("keeps a protected-context capacity question authoritative after internal planning writes",async()=>{
    const {fixture,workbench,inbox}=await setup();
    try{
      const coordinator=new JoiCoordinator({clock:fixture.clock,ids:new TestIds(),workbenches:{getWorkbench:async()=>workbench,listSummaries:async()=>[]},
        router:{decide:async()=>{throw new Error("Synthetic bound goal");}},sources:{selectInitial:async turnId=>({turnId,modelId:"synthetic",modelRevisionId:"model",sourceId:"source",sourceRevisionId:"revision"})},
        runtime:{abort:()=>undefined,followUp:()=>undefined,isRunning:()=>false,restore:async()=>false,rollbackTurn:async()=>false,steer:()=>undefined,waitForIdle:async()=>undefined,
          startTurn:async turn=>{turn.onEvent?.({type:"tool_started",toolName:"harness_name_destination",toolCallId:"internal",turnId:turn.turnId});throw new DomainError("goal_requirements_capacity_exceeded","Synthetic capacity failure");}},
        store:{loadInput:inbox.loadInput.bind(inbox),createTurn:input=>inbox.createTurn({inputId:input.inputId,turnId:input.turnId,sessionId:input.sessionId,workbenchId:input.workbenchId,createdAt:input.createdAt}),recordTurnProgress:inbox.recordTurnProgress.bind(inbox),completeInput:inbox.completeInput.bind(inbox),failTurn:inbox.failTurn.bind(inbox),requireClarification:inbox.requireClarification.bind(inbox)},
      });
      await expect(coordinator.handle("goal")).rejects.toMatchObject({code:"goal_requirements_capacity_exceeded"});
      const row=(await inbox.list()).find(item=>item.inputId==="goal");
      expect(row).toMatchObject({status:"CLARIFICATION_REQUIRED",clarificationReasonCode:"goal_requirements_capacity_exceeded"});
      expect(row?.failedAt).toBeUndefined();
    }finally{await fixture.close();}
  });
  it("repairs a precommit evidence reference once in the same real SDK turn after internal map writes", async () => { await dispatchScenario(true); });
  it("persists an actionable stop after evidence correction is exhausted without replaying internal or completed work", async () => { await dispatchScenario(false); });

  it.each(["orphan","stale-action","live-work","question","canceled","answer"] as const)("reconciles a historical stopped planning turn while preserving %s ownership",async state => {
    const { fixture,workbench,inbox } = await setup();
    try {
      const now=fixture.clock.now().toISOString();
      await inbox.createTurn({ inputId: "goal",turnId: "stopped",sessionId: "stopped-session",workbenchId: workbench.workbenchId,createdAt: now });
      fixture.database.transaction(db => {
        db.prepare("UPDATE joi_turns SET status='FAILED',side_effect_started=1,failure_replay_safe=0 WHERE turn_id='stopped'").run();
        db.prepare("UPDATE joi_inbox_messages SET status='CONSUMED' WHERE input_id='goal'").run();
        if(state==="live-work") db.prepare(`INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
          VALUES ('live',?,'goal','Synthetic','{}','READ','RUNNING',?,?)`).run(workbench.workbenchId,now,now);
        if(state==="answer") db.prepare(`INSERT INTO joi_turn_completions (input_id,turn_id,outcome_kind,completion_summary,completed_at,updated_at)
          VALUES ('goal','stopped','DIRECT_ANSWER','Synthetic answer',?,?)`).run(now,now);
        if(state==="stale-action"){
          const prior=new Date(fixture.clock.now().getTime()-1_000).toISOString();
          db.prepare(`INSERT INTO joi_user_action_requests(action_id,input_id,result_revision,kind,status,reason_code,prompt,decision,created_at,updated_at)
            VALUES ('old-action','goal',1,'GOAL_CONTINUATION','RESOLVED','goal_continuation_required','Synthetic historical action','CONTINUE',?,?)`).run(prior,prior);
        }
      });
      if(state==="question") await inbox.requireClarification("goal","question_required","Synthetic question");
      if(state==="canceled") await inbox.cancel("goal");
      fixture.clock.advance(60_000);
      await inbox.recoverInterruptedGoalReviews();
      const row=(await inbox.list()).find(item=>item.inputId==="goal");
      if(state==="orphan"||state==="stale-action") {
        expect(row).toMatchObject({ status:"CONSUMED",failureReasonCode:"joi_planning_interrupted",failureCount:1 });
        const failedAt=row?.failedAt;
        expect(failedAt).toBeDefined();
        await inbox.recoverInterruptedGoalReviews();
        expect((await inbox.list()).find(item=>item.inputId==="goal")?.failedAt).toBe(failedAt);
      } else expect(row?.failedAt).toBeUndefined();
    } finally { await fixture.close(); }
  });
});
