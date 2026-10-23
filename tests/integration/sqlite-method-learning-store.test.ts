import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildLearningCases, type LearningCase } from "../../src/main/domain/evolution/learning-case";
import { SqliteMethodLearningStore } from "../../src/main/infrastructure/persistence/sqlite-method-learning-store";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("production method learning persistence", () => {
  let fixture: RuntimeFixture;
  let store: SqliteMethodLearningStore;
  beforeEach(async () => {
    fixture = await createRuntimeFixture();
    fixture.database.transaction(db => {
      for (const id of ["a", "b"]) db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES (?, 'A',?,'','','',?,'ACTIVE','2026-10-23','2026-10-23')`).run(id,id,id);
      db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES ('g','g','PRIVATE BODY','CONSUMED','a','2026-10-23','2026-10-23')`).run();
    });
    store = new SqliteMethodLearningStore(fixture.database);
  });
  afterEach(async () => { await fixture.close(); });
  async function authoritativeGoal(): Promise<void> {
    const partner = await fixture.partners.add({kind:"local-pi",displayName:"Fixture",capabilities:[],skills:[],tools:[]});
    fixture.database.transaction(db => {
      const revision = db.prepare("SELECT active_revision_id FROM partners WHERE partner_id=?").get(partner.partnerId)?.active_revision_id;
      if (typeof revision !== "string") throw new Error("Missing partner revision");
      db.prepare("INSERT INTO joi_turns(turn_id,input_id,workbench_id,session_id,status,created_at,updated_at) VALUES ('t','g','a','s','COMPLETED','2026-10-23','2026-10-23')").run();
      db.prepare("INSERT INTO dispatch_plans VALUES ('p','t','{}','{}','2026-10-23')").run();
      for (const [id,verification] of [["one","PASSED"],["two","FAILED"]] as const) {
        db.prepare("INSERT INTO work_items(work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at) VALUES (?,'a','g','Fixture','{}','READ','COMPLETED','2026-10-23','2026-10-23')").run(`w-${id}`);
        db.prepare("INSERT INTO dispatch_attempts(dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,status,created_at,updated_at) VALUES (?,'p',?,?,1,?,'COMPLETED','2026-10-23','2026-10-23')").run(`d-${id}`,`w-${id}`,revision,`a-${id}`);
        db.prepare("INSERT INTO partner_runs(run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at,requirements_revision,requirement_ids_json) VALUES (?,?,?,'a',?,?,'LOCAL_PI',?,'COMPLETED','2026-10-23','2026-10-23',1,?)").run(`run-${id}`,`d-${id}`,`a-${id}`,`w-${id}`,revision,`remote-${id}`,JSON.stringify([id]));
        db.prepare("INSERT INTO work_result_bodies VALUES (?,'PRIVATE RESULT','2026-10-23')").run(`body-${id}`);
        db.prepare("INSERT INTO work_results(result_id,run_id,action_id,workbench_id,work_id,partner_revision_id,status,summary,body_ref,is_authoritative,created_at) VALUES (?,?,?,'a',?,?,'COMPLETED','PRIVATE SUMMARY',?,1,'2026-10-23')").run(`r-${id}`,`run-${id}`,`a-${id}`,`w-${id}`,revision,`body-${id}`);
        db.prepare("INSERT INTO work_result_verifications VALUES (?,?,NULL,'2026-10-23')").run(`r-${id}`,verification);
      }
      db.prepare("INSERT INTO joi_goal_requirements VALUES ('g','a',1,0)").run();
      db.prepare("INSERT INTO joi_goal_requirement_snapshots VALUES ('g',1,?)").run(JSON.stringify([{id:"one",text:"PRIVATE REQUIREMENT"},{id:"two",text:"PRIVATE REQUIREMENT"}]));
      db.prepare("INSERT INTO joi_goal_outcomes(input_id,result_revision,completion_summary,completed_at,updated_at,disposition,requirements_revision,synthesis_state_json) VALUES ('g',1,'PRIVATE CONCLUSION','2026-10-23','2026-10-23','COMPLETED',1,?)").run(JSON.stringify({claims:[{statement:"PRIVATE CLAIM",verification:"VERIFIED",requirementIds:["one"],resultIds:["r-one"]}]}));
    });
  }
  it("uses one atomic daily budget and stable call identifiers across workbenches", () => {
    store.configureGlobal({ enabled: true, dailyCallLimit: 2 });
    for (const id of ["a", "b"]) store.configureParticipant(id, { enabled: true });
    const reserve = (callId: string, workbenchId = "a", day = "2026-10-23") => store.reserveCall({ callId, experimentId: "e", workbenchId, day, at: `${day}T00:00:00Z` });
    expect(reserve("one")).toBe("reserved");
    expect(reserve("one")).toBe("existing");
    expect(reserve("two", "b")).toBe("reserved");
    expect(reserve("three")).toBe("budget_exhausted");
    expect(reserve("four", "a", "2026-10-24")).toBe("reserved");
    store.completeCall("one", null, "2026-10-23T00:01:00Z");
    expect(store.usage("2026-10-23")).toEqual({ calls: 2, tokens: 0, tokensComplete: false });
    store.completeCall("two",20,"2026-10-23T00:01:00Z");
    expect(store.usage("2026-10-23","a")).toEqual({calls:1,tokens:0,tokensComplete:false});
    expect(store.usage("2026-10-23","b")).toEqual({calls:1,tokens:20,tokensComplete:true});
    expect(store.usage("2026-10-23")).toEqual({calls:2,tokens:20,tokensComplete:false});
    expect(store.usage("2026-10-24","a")).toEqual({calls:1,tokens:0,tokensComplete:false});
    expect(store.usage("2026-10-24","b")).toEqual({calls:0,tokens:0,tokensComplete:true});
  });
  it("commits a model reservation and its pending checkpoint atomically", () => {
    store.configureGlobal({enabled:true,dailyCallLimit:1});
    store.configureParticipant("a",{enabled:true});
    const checkpoint = {id:"e",workbenchId:"a",scope:"GLOBAL" as const,profile:"p",phase:"PROTOCOL" as const,status:"RUNNING" as const,createdAt:"2026-10-23",updatedAt:"2026-10-23",state:{sequence:1,pendingCall:"call-one"}};
    const call = {callId:"call-one",experimentId:"e",workbenchId:"a",day:"2026-10-23",at:"2026-10-23",checkpoint};
    expect(store.reserveCall(call)).toBe("reserved");
    expect(store.experiment("e")).toEqual(checkpoint);
    expect(store.reserveCall({...call,callId:"call-two",checkpoint:{...checkpoint,state:{sequence:2,pendingCall:"call-two"}}})).toBe("budget_exhausted");
    expect(store.experiment("e")).toEqual(checkpoint);
    expect(() => store.reserveCall({...call,callId:"invalid",checkpoint:{...checkpoint,id:"foreign"}})).toThrow();
    expect(store.usage(call.day).calls).toBe(1);
    store.configureGlobal({dailyCallLimit:2});
    expect(() => store.reserveCall({...call,callId:"conflicting",experimentId:"other",checkpoint:{...checkpoint,id:"other"}})).toThrow();
    expect(store.usage(call.day).calls).toBe(1);
    expect(store.experiment("other")).toBeNull();
    expect(fixture.database.transaction(db=>db.prepare("SELECT 1 FROM outbox WHERE outbox_id='conflicting'").get())).toBeUndefined();
  });
  it("pins baseline once and checks goal ownership", () => {
    const pin = { workbenchId: "a", goalId: "g", revisionId: null, policy: "{}", at: "2026-10-23" };
    expect(store.pinGoal(pin).revisionId).toBeNull();
    expect(store.pinGoal({ ...pin, revisionId: "new", policy: "new" }).policy).toBe("{}");
    expect(() => store.pinGoal({ ...pin, workbenchId: "b" })).toThrow();
    expect(() => store.goalPin("b", "g")).toThrow();
    expect(store.goalPins()).toHaveLength(1);
    expect(store.goalPins("new")).toEqual([]);
    expect(store.countGoalPins()).toBe(1);
    expect(store.countGoalPins("new")).toBe(0);
  });
  it("keeps new workbenches off and honors global pause and legacy sublimits", () => {
    const call = {callId:"one",experimentId:"e",workbenchId:"a",day:"2026-10-23",at:"2026-10-23"};
    expect(store.participant("a")).toMatchObject({enabled:false,paused:false});
    store.configureGlobal({enabled:true});
    expect(store.reserveCall(call)).toBe("disabled");
    store.configureParticipant("a",{enabled:true,dailyCallLimit:1});
    store.configureGlobal({paused:true});
    expect(store.reserveCall(call)).toBe("paused");
    expect(store.usage(call.day).calls).toBe(0);
    store.configureGlobal({paused:false});
    expect(store.reserveCall(call)).toBe("reserved");
    expect(store.reserveCall({...call,callId:"two"})).toBe("budget_exhausted");
    expect(() => store.reserveCall({...call,workbenchId:"b"})).toThrow();
    store.completeCall("one",10,"2026-10-23");
    store.completeCall("one",99,"2026-10-23");
    expect(store.usage(call.day)).toEqual({calls:1,tokens:10,tokensComplete:true});
  });
  it("upgrades an unknown completed call from a late known response exactly once", () => {
    store.configureGlobal({enabled:true});
    store.configureParticipant("a",{enabled:true});
    store.reserveCall({callId:"late",experimentId:"e",workbenchId:"a",day:"2026-10-23",at:"2026-10-23"});
    store.completeCall("late",null,"2026-10-23");
    expect(store.experimentUsage("e")).toEqual({calls:1,tokens:0,tokensComplete:false});
    store.completeCall("late",25,"2026-10-24");
    store.completeCall("late",99,"2026-10-24");
    expect(store.experimentUsage("e")).toEqual({calls:1,tokens:25,tokensComplete:true});
    expect(store.usage("2026-10-23")).toEqual({calls:1,tokens:25,tokensComplete:true});
  });
  it("excludes goals without authoritative Work verification", () => {
    expect(store.captureFacts()).toEqual([]);
    fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET updated_at = '2026-10-24' WHERE input_id = 'g'").run());
    const facts = store.captureFacts();
    expect(facts).toHaveLength(0);
    expect(JSON.stringify(facts)).not.toContain("PRIVATE BODY");
  });
  it("captures current authoritative completion failures and verified requirement coverage", async () => {
    await authoritativeGoal();
    const facts = store.captureFacts();
    expect(facts).toMatchObject([{goalId:"g",requirementsRevision:1,resultRevision:1,completed:true,verified:1,failed:1,requirementCount:2,coveredRequirementCount:1}]);
    const fact = facts[0];
    if (!fact) throw new Error("Missing captured facts");
    expect(buildLearningCases(fact).map(item=>item.defect)).toContain("false_completion");
    expect(JSON.stringify(facts)).not.toContain("PRIVATE");
  });
  it("does not relabel old acceptance as evidence for a new requirement version", async () => {
    await authoritativeGoal();
    fixture.database.transaction(db => {
      db.prepare("UPDATE joi_goal_requirements SET revision=2 WHERE goal_input_id='g'").run();
      db.prepare("INSERT INTO joi_goal_requirement_snapshots SELECT goal_input_id,2,requirements_json FROM joi_goal_requirement_snapshots WHERE goal_input_id='g' AND revision=1").run();
      db.prepare("UPDATE joi_goal_outcomes SET requirements_revision=2 WHERE input_id='g'").run();
    });
    expect(store.captureFacts()).toEqual([]);
  });
  it("keeps verification failure evidence when Work is failed but execution completed", async () => {
    await authoritativeGoal();
    fixture.database.transaction(db=>db.prepare("UPDATE work_items SET status='FAILED' WHERE work_id='w-two'").run());
    const failedCheck = store.captureFacts()[0];
    expect(failedCheck).toMatchObject({executionFailed:false,failed:1});
    if (!failedCheck) throw new Error("Missing failure facts");
    expect(buildLearningCases(failedCheck).some(item=>item.defect==="false_completion")).toBe(true);
    fixture.database.transaction(db=>db.prepare("UPDATE work_results SET status='FAILED' WHERE result_id='r-two'").run());
    const failedExecution = store.captureFacts()[0];
    expect(failedExecution).toMatchObject({executionFailed:true});
    if (!failedExecution) throw new Error("Missing execution facts");
    expect(buildLearningCases(failedExecution)).toEqual([]);
  });
  it("reevaluates current goal eligibility independently of captured historical cases", async () => {
    await authoritativeGoal();
    const facts = store.captureFacts();
    store.upsertCases(facts.flatMap(buildLearningCases));
    store.acknowledgeFacts(facts);
    expect(store.goalEvaluationEligible("g")).toBe(true);
    expect(store.captureFacts()).toEqual([]);
    fixture.database.transaction(db=>db.prepare("UPDATE work_items SET status='FAILED' WHERE work_id='w-two'").run());
    expect(store.goalEvaluationEligible("g")).toBe(true);
    fixture.database.transaction(db=>db.prepare("UPDATE work_results SET status='FAILED' WHERE result_id='r-two'").run());
    expect(store.goalEvaluationEligible("g")).toBe(false);
    fixture.database.transaction(db=> {
      db.prepare("UPDATE work_results SET status='COMPLETED' WHERE result_id='r-two'").run();
      db.prepare("INSERT INTO joi_goal_requirement_sources VALUES ('g',1,'USER','PRIVATE',7,NULL,0)").run();
    });
    expect(store.goalEvaluationEligible("g")).toBe(false);
    fixture.database.transaction(db=> {
      db.prepare("UPDATE joi_goal_requirements SET processed_source_revision=1 WHERE goal_input_id='g'").run();
      db.prepare("UPDATE joi_inbox_messages SET canceled_at='2026-10-23' WHERE input_id='g'").run();
    });
    expect(store.goalEvaluationEligible("g")).toBe(false);
    expect(store.goalEvaluationEligible("missing")).toBe(false);
  });
  it("persists exposure invalidation without changing the first policy pin", async () => {
    await authoritativeGoal();
    const facts = store.captureFacts();
    store.upsertCases(facts.flatMap(buildLearningCases));
    store.acknowledgeFacts(facts);
    const pin = {workbenchId:"a",goalId:"g",revisionId:"candidate",policy:"immutable",at:"2026-10-23"};
    store.pinGoal(pin);
    expect(store.goalEvaluationEligible("g")).toBe(true);
    expect(() => store.invalidateGoalExposure("b","g")).toThrow();
    store.invalidateGoalExposure("a","g");
    store.invalidateGoalExposure("a","g");
    const reloaded = new SqliteMethodLearningStore(fixture.database);
    expect(reloaded.goalEvaluationEligible("g")).toBe(false);
    expect(reloaded.goalPin("a","g")).toEqual(pin);
  });
  it("excludes stale case versions and unacknowledged factual changes from monitoring", async () => {
    await authoritativeGoal();
    expect(store.goalEvaluationEligible("g")).toBe(false);
    const originalFacts = store.captureFacts();
    const originalCases = originalFacts.flatMap(buildLearningCases);
    const original = originalCases[0];
    if (!original) throw new Error("Missing original case");
    store.upsertCases(originalCases);
    expect(store.goalEvaluationEligible("g")).toBe(false);
    store.acknowledgeFacts(originalFacts);
    expect(store.goalCaseMatchesCurrent("g",1,1,original.caseId)).toBe(true);
    fixture.database.transaction(db=>db.prepare("UPDATE work_result_verifications SET status='PASSED' WHERE result_id='r-two'").run());
    expect(store.goalEvaluationEligible("g")).toBe(false);
    const changedFacts = store.captureFacts();
    const changedCases = changedFacts.flatMap(buildLearningCases);
    store.upsertCases(changedCases);
    store.acknowledgeFacts(changedFacts);
    expect(store.goalEvaluationEligible("g")).toBe(true);
    expect(store.goalCaseMatchesCurrent("g",1,1,original.caseId)).toBe(false);
    fixture.database.transaction(db=> {
      db.prepare("UPDATE joi_goal_requirements SET revision=2 WHERE goal_input_id='g'").run();
      db.prepare("INSERT INTO joi_goal_requirement_snapshots SELECT goal_input_id,2,requirements_json FROM joi_goal_requirement_snapshots WHERE goal_input_id='g' AND revision=1").run();
      db.prepare("UPDATE joi_goal_outcomes SET requirements_revision=2 WHERE input_id='g'").run();
      db.prepare("UPDATE partner_runs SET requirements_revision=2").run();
    });
    expect(store.goalEvaluationEligible("g")).toBe(false);
    const revised = store.captureFacts();
    store.upsertCases(revised.flatMap(buildLearningCases));
    store.acknowledgeFacts(revised);
    expect(store.goalEvaluationEligible("g")).toBe(true);
    expect(store.goalCaseMatchesCurrent("g",1,1)).toBe(false);
    expect(store.goalCaseMatchesCurrent("g",2,1)).toBe(true);
  });
  it("batches current cases equivalently to individual freshness checks including archived owners", async () => {
    await authoritativeGoal();
    expect(store.currentEvaluationCases()).toEqual([]);
    const capture = () => {
      const facts = store.captureFacts();
      store.upsertCases(facts.flatMap(buildLearningCases));
      store.acknowledgeFacts(facts);
    };
    const individually = () => store.listCases().filter(item=>store.goalCaseMatchesCurrent(item.goalId,item.requirementsRevision,item.resultRevision,item.caseId));
    capture();
    expect(store.currentEvaluationCases()).toEqual(individually());
    fixture.database.transaction(db=>db.prepare("UPDATE work_result_verifications SET status='PASSED' WHERE result_id='r-two'").run());
    expect(store.currentEvaluationCases()).toEqual([]);
    capture();
    expect(store.currentEvaluationCases()).toEqual(individually());
    fixture.database.transaction(db=>db.prepare("UPDATE workbenches SET status='ARCHIVED' WHERE workbench_id='a'").run());
    expect(store.currentEvaluationCases()).toEqual(individually());
    expect(store.currentEvaluationCases().length).toBeGreaterThan(0);
    store.invalidateGoalExposure("a","g");
    expect(store.currentEvaluationCases()).toEqual([]);
  });
  it("measures production calls and complete known tokens without evolution or duplicate attribution", async () => {
    await authoritativeGoal();
    fixture.database.transaction(db => {
      for (const [id,goal,work,purpose] of [["goal","g",null,"orchestration"],["work",null,"w-one","partner"],["both","g","w-one","partner"],["evo","g",null,"evolution"]] as const) {
        db.prepare("INSERT INTO usage_invocations(invocation_id,started_at,status,engine,purpose,workbench_id,goal_id,work_id) VALUES (?,'2026-10-23','completed','pi',?,'a',?,?)").run(id,purpose,goal,work);
        for (const observation of ["first","second"]) db.prepare("INSERT INTO usage_observations(invocation_id,observation_key,observed_at,tokens_json) VALUES (?,?,'2026-10-23',?)").run(id,observation,JSON.stringify({input:10,output:5,cacheRead:null,cacheWrite:null,reasoning:null}));
      }
    });
    expect(store.goalMetrics("g")).toEqual({calls:6,tokens:90});
    expect(store.goalMetrics("missing")).toEqual({calls:0,tokens:null});
    fixture.database.transaction(db=>db.prepare("UPDATE usage_observations SET tokens_json=NULL WHERE invocation_id='work' AND observation_key='second'").run());
    expect(store.goalMetrics("g")).toEqual({calls:6,tokens:null});
    expect(store.goalRequirementCount("a","g")).toBe(2);
    expect(store.goalRequirementCount("b","g")).toBeNull();
    fixture.database.transaction(db=>db.prepare("INSERT INTO joi_goal_requirement_sources VALUES ('g',1,'USER','PRIVATE',7,NULL,0)").run());
    expect(store.goalRequirementCount("a","g")).toBeNull();
  });
  it("rejects unknown or fallback sources on either root or continuation Turns", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE joi_inbox_messages(input_id,goal_input_id);
        CREATE TABLE joi_turns(input_id,source_revision_id,model_revision_id);
        INSERT INTO joi_inbox_messages VALUES('g',NULL),('child','g'),('other',NULL);
        INSERT INTO joi_turns VALUES('g','source','model'),('other','unrelated','unrelated');`);
      const isolated = new SqliteMethodLearningStore({transaction: operation=>operation(db)});
      expect(isolated.goalSourceMatches("g","source","model")).toBe(true);
      db.exec("INSERT INTO joi_turns VALUES('child','fallback','model')");
      expect(isolated.goalSourceMatches("g","source","model")).toBe(false);
      db.exec("UPDATE joi_turns SET source_revision_id='source',model_revision_id=NULL WHERE input_id='child'");
      expect(isolated.goalSourceMatches("g","source","model")).toBe(false);
      db.exec("DELETE FROM joi_turns WHERE input_id IN ('g','child')");
      expect(isolated.goalSourceMatches("g","source","model")).toBe(true);
      expect(isolated.goalSourceMatches("missing","source","model")).toBe(false);
    } finally { db.close(); }
  });
  it("counts only repeated successful page identities in a single unchanged Turn", async () => {
    await authoritativeGoal();
    const read = {workbenchId:"a",goalId:"g",turnId:"t",toolCallId:"call-one",tool:"work_read_result" as const,resultId:"r-one",cursor:null,mode:null};
    store.recordEvidenceRead(read);
    store.recordEvidenceRead(read);
    expect(store.captureFacts()[0]?.redundantReads).toBe(0);
    store.recordEvidenceRead({...read,toolCallId:"call-two"});
    expect(store.captureFacts()[0]?.redundantReads).toBe(1);
    store.recordEvidenceRead({...read,toolCallId:"page-two",cursor:"page-two"});
    expect(store.captureFacts()[0]?.redundantReads).toBe(1);
    fixture.database.transaction(db=> {
      db.prepare("UPDATE joi_goal_requirements SET revision=2 WHERE goal_input_id='g'").run();
      db.prepare("INSERT INTO joi_goal_requirement_snapshots SELECT goal_input_id,2,requirements_json FROM joi_goal_requirement_snapshots WHERE goal_input_id='g' AND revision=1").run();
      db.prepare("UPDATE joi_goal_outcomes SET requirements_revision=2 WHERE input_id='g'").run();
    });
    store.recordEvidenceRead({...read,toolCallId:"new-version"});
    expect(store.captureFacts()).toEqual([]);
    fixture.database.transaction(db=> {
      db.prepare("UPDATE partner_runs SET requirements_revision=2").run();
      db.prepare("INSERT INTO joi_goal_result_sets(original_input_id,revision,updated_at) VALUES ('g',2,'2026-10-23')").run();
      db.prepare("UPDATE joi_goal_outcomes SET result_revision=2 WHERE input_id='g'").run();
      db.prepare("INSERT INTO joi_turns(turn_id,input_id,workbench_id,session_id,status,created_at,updated_at) VALUES ('other-turn','g','a','s','COMPLETED','2026-10-23','2026-10-23')").run();
    });
    store.recordEvidenceRead({...read,toolCallId:"new-result-version"});
    store.recordEvidenceRead({...read,turnId:"other-turn",toolCallId:"other-turn-call"});
    expect(store.captureFacts()[0]?.redundantReads).toBe(0);
    expect(fixture.database.transaction(db=>db.prepare("SELECT COUNT(*) AS n FROM method_learning_evidence_reads").get())?.n).toBe(6);
    fixture.database.transaction(db=>db.prepare("UPDATE joi_inbox_messages SET canceled_at='2026-10-23' WHERE input_id='g'").run());
    store.recordEvidenceRead({...read,toolCallId:"after-cancel"});
    expect(fixture.database.transaction(db=>db.prepare("SELECT COUNT(*) AS n FROM method_learning_evidence_reads").get())?.n).toBe(6);
  });
  it("keeps archived-owner global revisions and only one unfinished experiment", () => {
    const experiment = {id:"e",workbenchId:"a",scope:"GLOBAL" as const,profile:"p",phase:"PROTOCOL" as const,status:"RUNNING" as const,createdAt:"2026-10-23",updatedAt:"2026-10-23",state:{}};
    store.saveExperiment(experiment);
    expect(() => store.saveExperiment({...experiment,id:"other"})).toThrow();
    store.saveExperiment({...experiment,status:"COMPLETED"});
    store.saveExperiment({...experiment,id:"other"});
    store.saveRevision({id:"r",workbenchId:"a",scope:"GLOBAL",profile:"p",status:"ACTIVE",createdAt:"2026-10-23",updatedAt:"2026-10-23",state:{}});
    fixture.database.transaction(db => db.prepare("UPDATE workbenches SET status='ARCHIVED' WHERE workbench_id='a'").run());
    expect(store.revisions()).toHaveLength(1);
  });
  it("versions baseline cache across source, model, tool, evaluator, parent and attempt", () => {
    const key = {source:"s",model:"m",tool:"t",evaluator:"e",parent:"p",caseId:"c",attempt:1};
    store.saveTrial(key,{success:true,calls:2});
    store.saveTrial(key,{success:false,calls:3});
    expect(store.cacheTrial(key)).toEqual({success:true,calls:2});
    for (const field of ["source","model","tool","evaluator","parent","caseId"] as const) expect(store.cacheTrial({...key,[field]:"different"})).toBeNull();
    expect(store.cacheTrial({...key,attempt:2})).toBeNull();
  });
  it("migrates participation without unpausing failures and counts historical calls", () => {
    fixture.database.transaction(db => {
      db.prepare("INSERT INTO evolution_states VALUES ('a',?)").run(JSON.stringify({dailyCallLimit:400,paused:true,reason:"response_invalid"}));
      db.prepare("INSERT INTO evolution_states VALUES ('b',?)").run(JSON.stringify({dailyCallLimit:150,paused:false,reason:"idle"}));
      for (const table of ["method_learning_case_references","method_learning_experiments","method_learning_control","method_learning_participants","method_learning_calls","method_learning_fact_receipts","method_learning_cases","method_learning_revisions","method_learning_trial_cache","method_learning_goal_pins","method_learning_evidence_reads","method_learning_exposure_invalidations"]) db.exec(`DROP TABLE ${table}`);
      db.exec(readFileSync("resources/migrations/083_method_learning.sql","utf8"));
      db.prepare("INSERT INTO outbox(outbox_id,kind,payload_json,status,available_at,created_at) VALUES ('legacy','evolution.model','{\"workbenchId\":\"b\"}','DONE','2026-10-23','2026-10-23')").run();
    });
    expect(store.control()).toMatchObject({enabled:true,dailyCallLimit:150});
    expect(store.participant("a")).toMatchObject({enabled:true,paused:true,dailyCallLimit:400});
    expect(store.usage("2026-10-23")).toEqual({calls:1,tokens:0,tokensComplete:false});
    expect(store.usage("2026-10-23","a")).toEqual({calls:0,tokens:0,tokensComplete:true});
    expect(store.usage("2026-10-23","b")).toEqual({calls:1,tokens:0,tokensComplete:false});
    expect(store.usage("2026-10-24","b")).toEqual({calls:0,tokens:0,tokensComplete:true});
    store.configureGlobal({dailyCallLimit:1});
    expect(store.reserveCall({callId:"new",experimentId:"e",workbenchId:"b",day:"2026-10-23",at:"2026-10-23"})).toBe("budget_exhausted");
  });
  it("caps unreferenced cases and preserves experiments' immutable cases", () => {
    const cases: LearningCase[] = Array.from({length:201},(_,n) => ({caseId:`c-${String(n).padStart(3,"0")}`,groupId:"group",workbenchId:"a",goalId:"g",requirementsRevision:1,resultRevision:1,observedAt:"2026-10-23",profile:"p",defect:"false_completion",split:"development",expected:"continue",evidence:{requirements:"counts only"},requiredIds:["requirements"]}));
    const first = cases[0];
    if (!first) throw new Error("Missing test case");
    store.upsertCases([first]);
    store.saveExperiment({id:"e",workbenchId:"a",scope:"GLOBAL",profile:"p",phase:"PROTOCOL",status:"RUNNING",createdAt:"2026-10-23",updatedAt:"2026-10-23",state:{dataset:[{caseId:first.caseId}]}});
    store.upsertCases(cases);
    expect(store.listCases("a")).toHaveLength(201);
    store.upsertCases([{...first,caseId:"c-202"}]);
    expect(store.listCases("a")).toHaveLength(201);
    expect(store.listCases("a").some(item => item.caseId===first.caseId)).toBe(true);
    expect(store.listCases("b")).toEqual([]);
  });
  it("advances a bounded changed-fact scan past the oldest fifty goals", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE workbenches(workbench_id,status);
        CREATE TABLE joi_inbox_messages(input_id,workbench_id,goal_input_id,status,updated_at,canceled_at,dismissed_at,body);
        CREATE TABLE work_results(result_id,work_id,workbench_id,status,created_at,is_authoritative,is_late,run_id);
        CREATE TABLE partner_runs(run_id,requirements_revision,requirement_ids_json);
        CREATE TABLE work_result_verifications(result_id,status);
        CREATE TABLE work_items(work_id,input_id,workbench_id,status);
        CREATE TABLE joi_current_goal_outcomes(input_id,result_revision,updated_at,disposition,synthesis_state_json);
        CREATE TABLE joi_goal_requirements(goal_input_id,revision,processed_source_revision);
        CREATE TABLE joi_goal_requirement_snapshots(goal_input_id,revision,requirements_json);
        CREATE TABLE joi_goal_result_sets(original_input_id,revision,updated_at);
        CREATE TABLE work_dependencies(work_id,depends_on_work_id);
        CREATE TABLE joi_turns(input_id,status);
        CREATE TABLE joi_harness_maps(goal_input_id,status);
        CREATE TABLE joi_goal_requirement_sources(goal_input_id,kind,source_revision);
        CREATE TABLE method_learning_fact_receipts(goal_id PRIMARY KEY,fingerprint);
        CREATE TABLE method_learning_evidence_reads(goal_id,turn_id,requirements_revision,result_revision,tool,result_id,cursor,mode);
        INSERT INTO workbenches VALUES('a','ACTIVE');
      `);
      for (let n=0;n<55;n++) {
        db.prepare("INSERT INTO joi_inbox_messages VALUES (?,'a',NULL,'CONSUMED','2026-10-23',NULL,NULL,?)").run(`g${String(n)}`,n===0 ? "PRIVATE cafe\u0301\n  BODY" : n===1 ? "  PRIVATE café BODY  " : "PRIVATE BODY");
        db.prepare("INSERT INTO work_items VALUES (?,?,'a','COMPLETED')").run(`w${String(n)}`,`g${String(n)}`);
        db.prepare("INSERT INTO work_results VALUES (?,?,'a','COMPLETED','2026-10-23',1,0,?)").run(`r${String(n)}`,`w${String(n)}`,`run${String(n)}`);
        db.prepare("INSERT INTO partner_runs VALUES (?,1,'[]')").run(`run${String(n)}`);
        db.prepare("INSERT INTO joi_goal_requirements VALUES (?,1,0)").run(`g${String(n)}`);
        db.prepare("INSERT INTO joi_goal_requirement_snapshots VALUES (?,1,'[]')").run(`g${String(n)}`);
        db.prepare("INSERT INTO work_result_verifications VALUES (?,'PASSED')").run(`r${String(n)}`);
        db.prepare("INSERT INTO joi_current_goal_outcomes VALUES (?,1,'2026-10-23','COMPLETED',NULL)").run(`g${String(n)}`);
      }
      const isolated = new SqliteMethodLearningStore({transaction: operation => operation(db)});
      const first = isolated.captureFacts(100);
      expect(first).toHaveLength(50);
      expect(first[0]).toMatchObject({completed:true,verified:1,executionFailed:false,environmentFailed:false});
      const [original,formatted] = first;
      if (!original || !formatted) throw new Error("Missing duplicate fixture goals");
      expect(original.sourceGroupId).toMatch(/^[a-f0-9]{64}$/u);
      expect(original.sourceGroupId).toBe(formatted.sourceGroupId);
      expect(buildLearningCases(original)[0]?.groupId).toBe(buildLearningCases(formatted)[0]?.groupId);
      expect(buildLearningCases(original)[0]?.split).toBe(buildLearningCases(formatted)[0]?.split);
      expect(isolated.captureFacts()).toEqual(first);
      isolated.acknowledgeFacts(first);
      const second = isolated.captureFacts();
      expect(second).toHaveLength(5);
      isolated.acknowledgeFacts(second);
      expect(isolated.captureFacts()).toEqual([]);
      db.exec("UPDATE work_result_verifications SET status='FAILED' WHERE result_id='r0'");
      expect(isolated.captureFacts()).toMatchObject([{goalId:"g0",failed:1,verified:0}]);
      db.exec("UPDATE joi_goal_requirements SET revision=2 WHERE goal_input_id='g0'; INSERT INTO joi_goal_requirement_snapshots VALUES ('g0',2,'[]'); UPDATE partner_runs SET requirements_revision=2 WHERE run_id='run0'; UPDATE joi_current_goal_outcomes SET result_revision=2 WHERE input_id='g0';");
      const revised = isolated.captureFacts()[0];
      if (!revised) throw new Error("Missing revised duplicate fixture");
      expect(revised.sourceGroupId).toBe(original.sourceGroupId);
      expect(buildLearningCases(revised)[0]?.groupId).toBe(buildLearningCases(original)[0]?.groupId);
      expect(buildLearningCases(revised)[0]?.split).toBe(buildLearningCases(original)[0]?.split);
      expect(JSON.stringify(first)).not.toContain("PRIVATE");
    } finally { db.close(); }
  });
});
