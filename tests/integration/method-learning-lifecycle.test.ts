import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MethodLearningService, METHOD_EVALUATOR_VERSION } from "../../src/main/application/evolution/method-learning-service";
import { EvolutionModelCallError, type EvolutionModel } from "../../src/main/application/ports/evolution";
import type { JsonObject, MethodExperiment, MethodRevision } from "../../src/main/application/ports/method-learning";
import { buildLearningCases, learningProfile, type LearningCase } from "../../src/main/domain/evolution/learning-case";
import { baselineMethodPolicy, policyKey } from "../../src/main/domain/evolution/learning-policy";
import type { DecisionFragmentResult } from "../../src/main/domain/evolution/learning-decision-fragment";
import { evolutionScenarios } from "../../src/main/domain/evolution/scenarios";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { SqliteMethodLearningStore } from "../../src/main/infrastructure/persistence/sqlite-method-learning-store";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

const originalPin = {modelId:"model",modelRevisionId:"m1",sourceId:"source",sourceRevisionId:"s1"};
const candidate = {version:2,context:[],planning:[],completion:["acceptance_matrix"]};
const json = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const trial = (scenarioId: string, variant = "baseline", attempt = 0) => ({scenarioId,variant,attempt,calls:0,modelCalls:0,tokens:0,tokensComplete:true,observations:[] as string[],actions:[] as string[]});

describe("method learning lifecycle recovery", () => {
  let fixture: RuntimeFixture;
  let store: SqliteMethodLearningStore;
  let legacy: SqliteEvolutionStore;
  let now: string;
  let pin: typeof originalPin;
  let sequence: number;
  const call = vi.fn<EvolutionModel["call"]>();
  const diagnostics = {emit:vi.fn()};
  beforeEach(async () => {
    fixture = await createRuntimeFixture();
    now="2026-10-23T01:00:00.000Z"; pin={...originalPin}; sequence=0;
    fixture.database.transaction(db=> {
      for (const id of ["a","b"]) db.prepare(`INSERT INTO workbenches(workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES (?, 'Fixture',?,'','','',?,'ACTIVE',?,?)`).run(id,id,id,now,now);
    });
    store=new SqliteMethodLearningStore(fixture.database); legacy=new SqliteEvolutionStore(fixture.database);
    store.configureGlobal({enabled:true,dailyCallLimit:150});
    store.configureParticipant("a",{enabled:true,dailyCallLimit:150});
    call.mockReset(); diagnostics.emit.mockReset();
  });
  afterEach(async () => { vi.restoreAllMocks(); await fixture.close(); });
  function service(defaultSteps = false) {
    return new MethodLearningService({store,legacyStore:legacy,model:{pin:()=>Promise.resolve(pin),call},now:()=>now,id:()=>`lifecycle-${String(++sequence)}`,diagnostics,
      ...(defaultSteps ? {} : {stepsPerHandle:1})});
  }
  function seedCase(id: string, split: LearningCase["split"] = "development", workbenchId = "a", healthy = false): LearningCase {
    fixture.database.transaction(db=>db.prepare("INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,workbench_id,created_at,updated_at) VALUES (?,?,'PRIVATE','CONSUMED',?,?,?)").run(id,id,workbenchId,now,now));
    const cases=buildLearningCases({goalId:id,workbenchId,requirementsRevision:1,resultRevision:1,observedAt:now,completed:true,canceled:false,
      verified:healthy ? 2 : 1,failed:healthy ? 0 : 1,unverified:0,requirementCount:2,coveredRequirementCount:healthy ? 2 : 1,foreignEvidenceCount:0,dependencyViolationCount:0,redundantReads:0,environmentFailed:false,executionFailed:false});
    const selected=cases.find(item=>item.defect===(healthy ? "healthy" : "false_completion"));
    if (!selected) throw new Error("Missing fixture case");
    const result={...selected,split}; store.upsertCases([result]); return result;
  }
  function experiment(dataset: LearningCase[], phase: MethodExperiment["phase"] = "PROTOCOL", patch: JsonObject = {}, id = "experiment"): MethodExperiment {
    const first=evolutionScenarios("development")[0];
    if (!first) throw new Error("Missing protocol scenario");
    const result: MethodExperiment={id,workbenchId:"a",scope:"WORKBENCH",profile:learningProfile(2),phase,status:"RUNNING",createdAt:now,updatedAt:now,state:json({
      version:2,evaluator:METHOD_EVALUATOR_VERSION,pin:originalPin,parent:baselineMethodPolicy,candidate:null,parentRevisionId:null,dataset,trials:[],current:null,
      protocol:trial(first.id),sequence:0,calls:0,tokens:0,invalidStreak:0,failure:null,reason:"evaluating",benefit:null,pendingCall:null,fixes:[],...patch})};
    store.saveExperiment(result); return result;
  }
  function revision(status: MethodRevision["status"]="CANARY", createdAt=now): MethodRevision {
    const result: MethodRevision={id:"method",workbenchId:"a",scope:"WORKBENCH",profile:learningProfile(2),status,createdAt,updatedAt:now,state:json({
      version:2,evaluator:METHOD_EVALUATOR_VERSION,pin:originalPin,policy:candidate,parentRevisionId:null,module:"completion",benefit:"quality",baselineSuccesses:5,candidateSuccesses:10,
      evaluatedRuns:30,candidateGoals:[],controlGoals:[],reason:status==="ACTIVE" ? "promoted" : "canary",datasetIds:[],defect:"false_completion"})};
    store.saveRevision(result); return result;
  }
  it("restores participation defaults and rejects disabled recovery without spending", async () => {
    const subject=service();
    subject.configure("a",0);
    expect(()=>subject.resumeWorkbench("a")).toThrow();
    subject.configureParticipation("a",true);
    expect(store.participant("a").dailyCallLimit).toBe(150);
    subject.configureGlobal({dailyCallLimit:0});
    expect(()=>subject.resumeGlobal()).toThrow();
    for (const limit of [-1,1.5,10_001]) expect(()=>subject.configureGlobal({dailyCallLimit:limit})).toThrow();
    await subject.handle("ordinary-input");
    const controller=new AbortController(); controller.abort();
    await subject.handle("evolution:a",controller.signal);
    expect(call).not.toHaveBeenCalled();
    subject.emergencyStop();
    expect(subject.canceled("evolution:a")).toBe(true);
    expect(subject.canceled("evolution:missing")).toBe(true);
  });
  it("runs six isolated shadow trials within the call limit even when no sealed cases exist", async () => {
    const receipt = {receiptId:"read-1",resultId:"result",sourceRef:"body",start:0,end:2,digest:"page-digest",
      verification:"PASSED",authority:null,residentReceipts:null};
    const manifest = {status:"ready",fragment:{version:1,id:"manifest",sourceGroup:"source-group",workbenchId:"a",goalId:"goal",
      turnId:"turn",requirementsRevision:1,resultRevision:2,sourceRevisionId:"s1",modelRevisionId:"m1",
      parentRevisionId:null,parent:{...baselineMethodPolicy},requirements:[{id:"private-id",mandatory:true}],
      reads:[receipt,{...receipt,receiptId:"read-2"}]},grade:{disposition:"complete",citedResultIds:["result"]}} satisfies DecisionFragmentResult;
    vi.spyOn(store,"decisionFragments").mockReturnValue([manifest]);
    const read = vi.spyOn(store,"readDecisionPage").mockReturnValue("中🧭");
    let callsInTrial = 0;
    call.mockImplementation(input=>{
      expect(input.contract).toBe("METHOD_SHADOW_V1");
      expect(input.prompt).not.toContain("private-id");
      expect(input.prompt).not.toContain("citedResultIds");
      callsInTrial++;
      if (callsInTrial <= 2) return Promise.resolve({value:{action:"read_evidence",evidenceId:"page-1"},tokens:9});
      callsInTrial=0;
      return Promise.resolve({value:{action:"finish",decision:"complete",evidenceIds:["page-1"]},tokens:9});
    });
    const subject=service(true);
    subject.requestShadow("a",18);
    expect(store.usage("2026-10-23").calls).toBe(0);
    expect(subject.pending()).toMatchObject([{ inputId:"evolution:a" }]);
    await subject.handle("evolution:a");
    expect(subject.status("a").learning?.shadow).toMatchObject({ status:"completed", verdict:"candidate",
      baseline:{ trials:3, success:3, backingReads:6, toolRequests:6, modelCalls:9,tokens:81 },
      candidate:{ trials:3, success:3, backingReads:3, toolRequests:6, modelCalls:9,tokens:81 } });
    expect(read).toHaveBeenCalledTimes(9);
    expect(store.revisions()).toEqual([]);
  });
  it("keeps a global experiment waiting when every sealed source is from one workbench", () => {
    const origin = seedCase("global-development","development","b");
    const sealed = Array.from({length:5},(_,i)=>seedCase(`global-one-bench-${String(i)}`,"sealed"));
    const item=experiment([origin,...sealed],"PROPOSE",{reason:"insufficient_samples"});
    store.saveExperiment({...item,scope:"GLOBAL",status:"PAUSED"});
    const subject=service();
    subject.scan();
    expect(store.experiment(item.id)?.status).toBe("PAUSED");
    seedCase("global-second-bench","sealed","b");
    subject.scan();
    expect(store.experiment(item.id)).toMatchObject({status:"RUNNING",phase:"PROPOSE"});
  });
  it("does not retrieve a prior development comparison from the same source group", async () => {
    const item=seedCase("experience-same-root");
    const scores=[0,1,2].flatMap(attempt=>[
      {...trial(item.caseId,"baseline",attempt),success:true,modelCalls:3,tokens:9},
      {...trial(item.caseId,"candidate",attempt),success:false,modelCalls:3,tokens:9},
    ]);
    experiment([item],"VALIDATE",json({candidate,trials:scores}),"first-compare");
    const subject=service();
    await subject.handle("evolution:a");
    expect(subject.status("a").learning?.cases.experiences).toBe(1);
    const same={...item,caseId:"same-root-edited",requirementsRevision:2};
    store.upsertCases([same]);
    experiment([same],"PROPOSE",{},"second-compare");
    call.mockImplementation(input=>{
      expect((JSON.parse(input.prompt) as {experiences:unknown[]}).experiences).toEqual([]);
      return Promise.resolve({value:{strategy:{version:2,context:["requirements_map"],planning:[],completion:[]},fixes:[same.caseId]},tokens:3});
    });
    await subject.handle("evolution:a");
    expect(store.experiment("second-compare")).toMatchObject({phase:"VALIDATE"});
  });
  it("compares development proposals with and without retrieval and runs the selected method again", async () => {
    const item=seedCase("independent-study-source");
    const measured=experiment([],"DEVELOP",json({shadow:{contextVersion:1,fragment:{sourceGroup:"other-source"},verdict:"candidate"},
      trials:[{...trial("shadow","baseline"),success:true,toolRequests:4},{...trial("shadow","candidate"),success:true,toolRequests:2}]}),"measured-shadow");
    store.saveExperiment({...measured,status:"COMPLETED"});
    const baseline=[0,1,2].map(attempt=>({...trial(item.caseId,"baseline",attempt),success:true,modelCalls:4,tokens:12}));
    const next=experiment([item],"PROPOSE",json({splitVersion:1,trials:baseline}),"retrieval-trials");
    const considered:boolean[]=[];
    let candidateFinishes=0;
    call.mockImplementation(input=>{
      if (input.mode==="proposal") {
        const payload=JSON.parse(input.prompt) as {evidenceReuseComparisons:unknown[]};
        const usesExperience=payload.evidenceReuseComparisons.length>0;
        considered.push(usesExperience);
        return Promise.resolve({value:{strategy:{version:2,context:[usesExperience ? "requirements_map" : "handoff_first"],planning:[],completion:[]},
          fixes:[item.caseId]},tokens:3});
      }
      const actions=input.prompt.split("Previous actions: ")[1] ?? "";
      const evidenceIds=["requirements","verification","workflow"];
      const id=evidenceIds.find(value=>!actions.includes(`read:${value}`));
      if (id!==undefined) return Promise.resolve({value:{action:"read_evidence",evidenceId:id},tokens:3});
      candidateFinishes+=1;
      return Promise.resolve({value:{action:"finish",decision:item.expected,evidenceIds},tokens:3});
    });
    const subject=service(true);
    for (let step=0;step<4;step++) await subject.handle("evolution:a");
    expect(considered.sort()).toEqual([false,true]);
    expect(candidateFinishes).toBe(9);
    expect(store.experiment(next.id)).toMatchObject({state:{experienceStudy:{selected:"without",reports:[
      expect.objectContaining({accepted:true,calls:13}),expect.objectContaining({accepted:true,calls:13}),
    ]}}});
  });
  it("registers future canary exposures and records insufficient traffic at the fixed decision time", () => {
    const preexisting=seedCase("before-canary", "development","a",true);
    now="2026-10-24T01:00:00.000Z";
    const canary=revision();
    const decisionAt="2026-11-23T01:00:00.000Z";
    store.saveRevision({...canary,state:{...canary.state,cohort:{decisionAt,minimumPairs:5,experimentId:"sealed-run"}}});
    const subject=service();
    subject.strategyForGoal("a",preexisting.goalId,originalPin,{requirementsReady:true,requirementCount:2});
    for (let i=0;i<6;i++) {
      const item=seedCase(`in-window-${String(i)}`,"development","a",true);
      subject.strategyForGoal("a",item.goalId,originalPin,{requirementsReady:true,requirementCount:2});
    }
    expect(store.cohortGoalPins(canary.id,now,decisionAt)).toHaveLength(6);
    subject.scan();
    expect(store.revision(canary.id)).toMatchObject({status:"CANARY",state:{production:{verdict:"observing",decisionAt}}});
    now=decisionAt;
    subject.scan();
    expect(store.revision(canary.id)).toMatchObject({status:"REJECTED",state:{production:{verdict:"traffic_insufficient",minimumPairs:5}}});
  });
  it.each(["abort","off"] as const)("accounts a paid response when %s happens during the call", async change => {
    const item=seedCase("paid"); const seeded=experiment([item]); const subject=service(true);
    const controller=new AbortController();
    call.mockImplementation(async input=> {
      await Promise.resolve();
      expect(input.signal).toBe(controller.signal);
      expect(subject.pending()).toEqual([]);
      if (change==="abort") controller.abort(); else subject.configureParticipation("a",false);
      return {value:{action:"read_evidence",evidenceId:"record-11"},tokens:12};
    });
    await subject.handle("evolution:a",controller.signal);
    expect(store.experiment(seeded.id)?.state.protocol).toMatchObject({calls:0,actions:[]});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:1,tokens:12,tokensComplete:true});
    expect(diagnostics.emit).toHaveBeenCalledWith("joi.evolution.batch_step_started",expect.objectContaining({workbenchId:"a"}));
  });
  it("pauses before a changed source is called and explicitly resumes with a fresh protocol", async () => {
    const item=seedCase("repin"); const seeded=experiment([item]); const subject=service();
    pin={...pin,sourceRevisionId:"s2"};
    await subject.handle("evolution:a");
    expect(call).not.toHaveBeenCalled();
    expect(store.experiment(seeded.id)).toMatchObject({status:"PAUSED",state:{reason:"model_changed"}});
    expect(subject.status("a").learning?.blockers).toContain("model_changed");
    subject.resumeGlobal();
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"record-11"},tokens:4});
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)?.state).toMatchObject({pin,parent:baselineMethodPolicy,parentRevisionId:null,allowRepin:false,protocol:{calls:1},generation:1});
  });
  it("charges a response whose source changed before it could be accepted", async () => {
    const seeded=experiment([seedCase("after-pin")]); const subject=service();
    call.mockImplementation(async ()=> {await Promise.resolve(); pin={...pin,modelRevisionId:"m2"}; return {value:{action:"read_evidence",evidenceId:"record-11"},tokens:8};});
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"PAUSED",state:{reason:"model_changed",protocol:{calls:0}}});
    expect(store.experimentUsage(seeded.id).tokens).toBe(8);
  });
  it("retries temporary failures after persisted backoff and requires explicit recovery after three failures", async () => {
    const seeded=experiment([seedCase("temporary")]);
    call.mockRejectedValue(new EvolutionModelCallError({kind:"timeout",toolCallCount:0},null));
    await service().handle("evolution:a");
    expect(store.control().paused).toBe(false);
    expect(service().pending()).toEqual([]);
    expect(service().status("a").learning?.blockers).toContain("retry_wait");
    now="2026-10-23T01:01:00.000Z";
    await service().handle("evolution:a");
    expect(call).toHaveBeenCalledTimes(2);
    now="2026-10-23T01:03:00.000Z";
    await service().handle("evolution:a");
    expect(store.control()).toMatchObject({paused:true,pause:{reason:"call_failed",at:now,workbenchId:"a"}});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:3,tokens:0,tokensComplete:false});
    now="2026-10-24T01:00:00.000Z";
    expect(service().pending()).toEqual([]);
  });
  it("does not turn a user opt-out during an aborted call into a global failure", async () => {
    const seeded=experiment([seedCase("opt-out-abort")]); const subject=service();
    call.mockImplementation(()=>{
      subject.configureParticipation("a",false);
      return Promise.reject(new EvolutionModelCallError({kind:"aborted",toolCallCount:0},null));
    });
    await subject.handle("evolution:a");
    expect(store.control().paused).toBe(false);
    expect(store.participant("a").enabled).toBe(false);
    expect(store.experimentUsage(seeded.id)).toEqual({calls:1,tokens:0,tokensComplete:false});
  });
  it.each(["unsupported_tool", "no_tool_call", "response_truncated"] as const)("ends a %s experiment without globally pausing or consuming its defect evidence", async kind => {
    const seeded=experiment([seedCase("protocol-recovery")]); const subject=service();
    revision("ACTIVE");
    store.configureGlobal({lastCandidateDay:now.slice(0,10)});
    call.mockRejectedValue(new EvolutionModelCallError({kind,toolCallCount:kind === "unsupported_tool" ? 1 : 0},6));
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)?.status).toBe("RUNNING");
    await subject.handle("evolution:a");
    expect(store.control().paused).toBe(false);
    expect(store.participant("a").paused).toBe(false);
    expect(store.experiment(seeded.id)).toMatchObject({status:"REJECTED",state:{reason:"model_response_invalid",invalidStreak:2,failure:{kind}}});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:2,tokens:12,tokensComplete:true});
    expect(subject.status("a").learning?.stage).not.toBe("PAUSED");
    expect(store.revision("method")?.status).toBe("ACTIVE");
    expect(diagnostics.emit).toHaveBeenCalledWith("joi.evolution.response_invalid",expect.objectContaining({failure:{kind,toolCallCount:kind === "unsupported_tool" ? 1 : 0}}));
    expect(call.mock.calls[1]?.[0].systemPrompt).toContain("The previous response was rejected");
    subject.resumeGlobal();
    expect(store.experiment(seeded.id)?.status).toBe("REJECTED");
    expect(service().pending()).toEqual([]);
    await service().handle("evolution:a");
    expect(call).toHaveBeenCalledTimes(2);
    now="2026-10-24T01:00:00.000Z";
    expect(service().pending()).toEqual([{inputId:"evolution:a",createdAt:now}]);
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"record-11"},tokens:4});
    await service().handle("evolution:a");
    expect(call).toHaveBeenCalledTimes(3);
    expect(store.experiments().find(item=>item.status === "RUNNING")?.state).toMatchObject({invalidStreak:0,failure:null});
    expect(store.experiment(seeded.id)?.status).toBe("REJECTED");
  });
  it("bounds malformed simulation responses without requiring a global resume", async () => {
    const seeded=experiment([seedCase("malformed-protocol")]); const subject=service();
    store.configureGlobal({lastCandidateDay:now.slice(0,10)});
    call.mockResolvedValue(null);
    await subject.handle("evolution:a");
    await subject.handle("evolution:a");
    expect(store.control().paused).toBe(false);
    expect(store.experiment(seeded.id)).toMatchObject({status:"REJECTED",state:{reason:"model_response_invalid",failure:{kind:"invalid_tool_arguments",toolCallCount:1}}});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:2,tokens:0,tokensComplete:false});
    expect(subject.pending()).toEqual([]);
  });
  it.each([
    ["record-13", "record-11", "complete"],
    ["record-11", "record-13", "wait"],
  ])("preflights registered tools in either evidence order without grading the %s/%s/%s decision", async (first, second, decision) => {
    const seeded=experiment([seedCase("protocol-shape")]); const subject=service();
    call.mockResolvedValueOnce({value:{action:"read_evidence",evidenceId:first},tokens:2})
      .mockResolvedValueOnce({value:{action:"read_evidence",evidenceId:second},tokens:2})
      .mockResolvedValueOnce({value:{action:"finish",decision,evidenceIds:[first,second]},tokens:2});
    for (let index=0; index<3; index+=1) await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"RUNNING",phase:"DEVELOP",state:{invalidStreak:0,failure:null}});
    expect(store.control().paused).toBe(false);
    expect(call.mock.calls.map(([input])=>input.mode)).toEqual(["protocol","protocol","protocol"]);
    expect(store.experimentUsage(seeded.id)).toEqual({calls:3,tokens:6,tokensComplete:true});
  });
  it("distinguishes a finish before reading evidence from an unregistered tool", async () => {
    const seeded=experiment([seedCase("protocol-sequence")]); const subject=service();
    call.mockResolvedValue({value:{action:"finish",decision:"complete",evidenceIds:["record-11","record-13"]},tokens:7});
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({phase:"PROTOCOL",state:{failure:{kind:"protocol_sequence_invalid"}}});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:1,tokens:7,tokensComplete:true});
  });
  it("rejects a non-string protocol decision without coercing it into a supported value", async () => {
    const seeded=experiment([seedCase("protocol-argument")],"PROTOCOL",json({protocol:{...trial("development:unit-test-repair"),calls:2,actions:["read:record-11","read:record-13"]}}));
    call.mockResolvedValue({value:{action:"finish",decision:["complete"],evidenceIds:["record-11","record-13"]},tokens:3});
    await service().handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({phase:"PROTOCOL",state:{failure:{kind:"invalid_tool_arguments"}}});
  });
  it("preserves the experiment on an unclassified failure and records unknown usage honestly", async () => {
    const seeded=experiment([seedCase("failure-generic")]); const subject=service();
    call.mockRejectedValue(new Error("Private provider detail"));
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"PAUSED",state:{reason:"call_failed",tokens:null}});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:1,tokens:0,tokensComplete:false});
    expect(subject.status("a").failure).toBeUndefined();
    expect(JSON.stringify(diagnostics.emit.mock.calls)).not.toContain("Private provider detail");
    subject.resumeGlobal();
    expect(store.experiment(seeded.id)).toMatchObject({status:"RUNNING",phase:"PROTOCOL",state:{failure:null,allowRepin:true}});
  });
  it("accepts an unwrapped action while retaining unknown token completeness", async () => {
    const seeded=experiment([seedCase("unknown")]); const subject=service();
    call.mockResolvedValueOnce(null).mockResolvedValueOnce({action:"read_evidence",evidenceId:"record-11"});
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)?.state.reason).toBe("model_response_invalid");
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)?.state).toMatchObject({tokens:null,invalidStreak:0,protocol:{calls:1,tokensComplete:false}});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:2,tokens:0,tokensComplete:false});
  });
  it("recovers a reserved interrupted trial without replaying its old observations", async () => {
    const item=seedCase("restart"); const current={...trial(item.caseId),calls:1,modelCalls:1,actions:["read:verification"],observations:["old fixture observation"]};
    store.reserveCall({callId:"interrupted",experimentId:"experiment",workbenchId:"a",day:now.slice(0,10),at:now});
    const seeded=experiment([item],"DEVELOP",json({pendingCall:"interrupted",sequence:1,calls:1,current}));
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"requirements"},tokens:3});
    await service().handle("evolution:a");
    expect(store.experiment(seeded.id)?.state.current).toMatchObject({calls:1,modelCalls:2,actions:["read:requirements"],tokensComplete:false});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:2,tokens:3,tokensComplete:false});
  });
  it("keeps its checkpoint intact when a workbench cap denies a call and resumes next day", async () => {
    const seeded=experiment([seedCase("daily")]); const subject=service();
    store.configureParticipant("a",{dailyCallLimit:1});
    store.reserveCall({callId:"already-paid",experimentId:"older",workbenchId:"a",day:now.slice(0,10),at:now});
    await subject.handle("evolution:a");
    expect(call).not.toHaveBeenCalled();
    expect(store.experiment(seeded.id)?.state.sequence).toBe(0);
    now="2026-10-24T01:00:00.000Z";
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"record-11"},tokens:7});
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)?.state.protocol).toMatchObject({calls:1});
    expect(store.usage(now.slice(0,10)).calls).toBe(1);
  });
  it("selects a new defect ahead of tried cases and inherits a compatible global parent", async () => {
    const old=seedCase("old"); const prior=experiment([old]); prior.status="REJECTED"; store.saveExperiment(prior);
    now="2026-10-24T01:00:00.000Z";
    const fresh=seedCase("fresh"); seedCase("cross-workbench","sealed","b");
    const parent=revision("ACTIVE"); parent.scope="GLOBAL"; store.saveRevision(parent);
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"record-11"},tokens:1});
    const subject=service();
    await subject.handle("evolution:a");
    const active=store.experiments().find(item=>item.status==="RUNNING");
    expect(active).toMatchObject({scope:"GLOBAL",state:{parentRevisionId:parent.id,parent:candidate}});
    expect(active?.state.dataset).toEqual(expect.arrayContaining([expect.objectContaining({caseId:fresh.caseId})]));
    const dataset=active?.state.dataset;
    expect(Array.isArray(dataset) && dataset[0]).toMatchObject({caseId:fresh.caseId});
    if (!active) throw new Error("Missing new experiment");
    active.status="REJECTED"; store.saveExperiment(active);
    expect(subject.pending()).toEqual([]);
    subject.requestRun("a");
    now="2026-10-24T01:01:00.000Z";
    await subject.handle("evolution:a");
    expect(store.experiments().filter(item=>item.status==="RUNNING")).toHaveLength(1);
  });
  it("does not reuse a baseline cache entry as a candidate trial", async () => {
    const item=seedCase("cache"); const subject=service();
    const cached={...trial(item.caseId),calls:3,modelCalls:3,success:false};
    store.saveTrial({source:pin.sourceRevisionId,model:pin.modelRevisionId,tool:"isolated-evidence-v1",evaluator:METHOD_EVALUATOR_VERSION,parent:policyKey(baselineMethodPolicy),caseId:item.caseId,attempt:0},json(cached));
    const seeded=experiment([item],"VALIDATE",json({candidate}));
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"requirements"},tokens:2});
    await subject.handle("evolution:a");
    expect(call).toHaveBeenCalledOnce();
    expect(store.experiment(seeded.id)?.state.current).toMatchObject({variant:"candidate",actions:["read:requirements"]});
    seeded.status="REJECTED"; store.saveExperiment(seeded);
    const baseline=experiment([item],"DEVELOP",{},"cached-baseline");
    await subject.handle("evolution:a");
    expect(call).toHaveBeenCalledOnce();
    expect(store.experiment(baseline.id)?.state.trials).toEqual([cached]);
  });
  it("keeps the same candidate parked while the held-out sample is insufficient", async () => {
    const item=seedCase("waiting");
    const trials=[0,1,2].flatMap(attempt=>["baseline","candidate"].map(variant=>({...trial(item.caseId,variant,attempt),success:true,modelCalls:3,tokensComplete:false})));
    const seeded=experiment([item],"VALIDATE",json({candidate,trials,tokens:null}));
    const subject=service();
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"PAUSED",state:{reason:"insufficient_samples",candidate}});
    seedCase("one-held-out","sealed"); seedCase("foreign-held-out","sealed","b");
    expect(subject.pending()).toEqual([]);
    expect(store.experiment(seeded.id)).toMatchObject({status:"PAUSED",phase:"VALIDATE",state:{candidate}});
    expect(call).not.toHaveBeenCalled();
  });
  it("allows another workbench to learn while a candidate waits for samples, without replacing that candidate", async () => {
    const item=seedCase("parked");
    const waiting=experiment([item],"VALIDATE",json({candidate,reason:"insufficient_samples"}));
    waiting.status="PAUSED"; store.saveExperiment(waiting);
    seedCase("independent","development","b");
    store.configureParticipant("b",{enabled:true,dailyCallLimit:150});
    const subject=service();
    expect(subject.pending()).toEqual([{inputId:"evolution:b",createdAt:now}]);
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"record-11"},tokens:3});
    await subject.handle("evolution:b");
    expect(store.experiment(waiting.id)).toMatchObject({status:"PAUSED",state:{candidate}});
    expect(store.experiments().find(e=>e.workbenchId==="b")).toMatchObject({status:"RUNNING"});
    for (let i=0;i<5;i++) seedCase(`held-out-while-busy-${String(i)}`,"sealed");
    subject.scan();
    expect(store.experiment(waiting.id)?.status).toBe("PAUSED");
    const other=store.experiments().find(e=>e.workbenchId==="b");
    if (!other) throw new Error("Missing independent experiment");
    store.saveExperiment({...other,status:"REJECTED"});
    subject.pending();
    expect(store.experiment(waiting.id)).toMatchObject({status:"RUNNING",phase:"EVALUATE",state:{candidate}});
  });
  it("caps unfinished isolated trials and preserves a failed baseline as counterevidence", async () => {
    const item=seedCase("bounded"); const seeded=experiment([item],"DEVELOP",json({current:{...trial(item.caseId),calls:5,modelCalls:5}}));
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"requirements"},tokens:1});
    await service().handle("evolution:a");
    expect(store.experiment(seeded.id)?.state).toMatchObject({current:null,trials:[{success:false,calls:6}]});
  });
  it("distinguishes source groups and baseline reproduction from immutable defect snapshots", () => {
    const item=seedCase("metrics");
    store.upsertCases([{...item,caseId:"another-snapshot"}]);
    experiment([item],"DEVELOP",json({trials:[0,1,2].map(attempt=>({...trial(item.caseId,"baseline",attempt),success:attempt===2}))}));
    expect(service().status("a").learning?.cases).toMatchObject({development:2,defects:2,developmentGroups:1,sealedGroups:0,reproduced:1});
  });
  it("shows the executing experiment ahead of a waiting candidate in another input profile", () => {
    const waiting=experiment([seedCase("waiting-profile")],"VALIDATE",json({candidate,reason:"insufficient_samples"}));
    waiting.status="PAUSED"; store.saveExperiment(waiting);
    now="2026-10-24T01:00:00.000Z";
    const running=experiment([],"PROTOCOL",{},"executing-profile");
    running.profile=learningProfile(11); store.saveExperiment(running);
    expect(service().status("a").learning).toMatchObject({stage:"PROTOCOL",experiment:{id:running.id,waitingForSamples:false}});
  });
  it("explains the daily candidate cap for another workbench even while a candidate waits for samples", () => {
    const waiting=experiment([seedCase("daily-wait")],"PROPOSE",json({reason:"insufficient_samples"}));
    waiting.status="PAUSED"; store.saveExperiment(waiting);
    seedCase("daily-other","development","b");
    store.configureParticipant("b",{enabled:true,dailyCallLimit:150});
    store.configureGlobal({lastCandidateDay:now.slice(0,10)});
    const subject=service();
    expect(subject.pending()).toEqual([]);
    expect(subject.status("b").learning?.blockers).toContain("daily_candidate_limit");
  });
  it("waits for five independent samples before paying for a proposal and resumes the measured baseline", async () => {
    const item=seedCase("readiness");
    const trials=[0,1,2].map(attempt=>({...trial(item.caseId,"baseline",attempt),success:attempt===2,modelCalls:4}));
    const seeded=experiment([item],"DEVELOP",json({trials}));
    const subject=service();
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"PAUSED",phase:"PROPOSE",state:{reason:"insufficient_samples",candidate:null,trials}});
    expect(call).not.toHaveBeenCalled();
    for (let i=0;i<5;i++) seedCase(`ready-sealed-${String(i)}`,"sealed");
    subject.scan();
    expect(store.experiment(seeded.id)).toMatchObject({status:"RUNNING",phase:"PROPOSE",state:{trials}});
  });
  it("rejects an excessive development cost before paying for independent evaluation", async () => {
    const item=seedCase("cost-gate");
    const trials=[0,1,2].flatMap(attempt=>["baseline","candidate"].map(variant=>({...trial(item.caseId,variant,attempt),
      success:variant==="candidate" || attempt===0,modelCalls:variant==="candidate" ? 6 : 4,tokens:10})));
    const seeded=experiment([item],"VALIDATE",json({candidate,trials}));
    await service().handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"REJECTED",state:{reason:"cost_regression",experience:{baselineCalls:12,candidateCalls:18}}});
    expect(call).not.toHaveBeenCalled();
  });
  it("rejects malformed proposals without losing their production evidence", async () => {
    const item=seedCase("proposal"); const seeded=experiment([item],"PROPOSE");
    call.mockResolvedValue({value:null,tokens:5});
    await service().handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"REJECTED",state:{reason:"invalid_candidate"}});
    expect(store.listCases()).toHaveLength(1);
  });
  it("retains development counterexamples for compatible proposals and rejects an unchanged harmful method", async () => {
    const item=seedCase("experience");
    const trials=[0,1,2].flatMap(attempt=>["baseline","candidate"].map(variant=>({...trial(item.caseId,variant,attempt),
      success:variant==="baseline" || attempt===0,modelCalls:4,tokens:10})));
    const previous=experiment([item],"VALIDATE",json({candidate,trials}));
    const subject=service();
    await subject.handle("evolution:a");
    expect(store.experiment(previous.id)).toMatchObject({status:"REJECTED",state:{reason:"quality_regression"}});
    expect(subject.status("a").learning?.cases.experiences).toBe(1);
    now="2026-10-24T01:00:00.000Z";
    const nextItem=seedCase("next-experience");
    const next=experiment([nextItem],"PROPOSE",{},"next");
    call.mockImplementation(input=> {
      const prompt=JSON.parse(input.prompt) as {experiences:unknown[]};
      expect(prompt.experiences).toEqual([expect.objectContaining({outcome:"quality_regression",baselineSuccesses:3,candidateSuccesses:1})]);
      return Promise.resolve({value:{strategy:candidate,fixes:[nextItem.caseId]},tokens:5});
    });
    await subject.handle("evolution:a");
    expect(store.experiment(next.id)).toMatchObject({status:"REJECTED",state:{reason:"invalid_candidate"}});
  });
  it.each(["workbench","model"] as const)("keeps incompatible %s comparisons out of a proposal", async mismatch => {
    const item=seedCase("private-experience");
    const trials=[0,1,2].flatMap(attempt=>["baseline","candidate"].map(variant=>({...trial(item.caseId,variant,attempt),
      success:variant==="baseline" || attempt===0,modelCalls:4,tokens:10})));
    experiment([item],"VALIDATE",json({candidate,trials}));
    await service().handle("evolution:a");
    now="2026-10-24T01:00:00.000Z";
    const workbenchId=mismatch==="workbench" ? "b" : "a";
    store.configureParticipant(workbenchId,{enabled:true,dailyCallLimit:150});
    if (mismatch==="model") pin={...pin,modelRevisionId:"m2"};
    const nextItem=seedCase("isolated-next","development",workbenchId);
    const next=experiment([nextItem],"PROPOSE",json({pin}),"isolated-next-experiment");
    next.workbenchId=workbenchId; store.saveExperiment(next);
    call.mockImplementation(input=>{
      expect((JSON.parse(input.prompt) as {experiences:unknown[]}).experiences).toEqual([]);
      return Promise.resolve({value:{strategy:candidate,fixes:[nextItem.caseId]},tokens:5});
    });
    await service().handle(`evolution:${workbenchId}`);
    expect(store.experiment(next.id)).toMatchObject({status:"RUNNING",phase:"VALIDATE"});
  });
  it("does not match unrelated defects merely because both datasets contain a healthy control", async () => {
    const item=seedCase("first-defect"), healthy=seedCase("healthy-control","development","a",true);
    const trials=[item,healthy].flatMap(row=>[0,1,2].flatMap(attempt=>["baseline","candidate"].map(variant=>({...trial(row.caseId,variant,attempt),
      success:row.defect==="healthy" || variant==="baseline" || attempt===0,modelCalls:4,tokens:10}))));
    experiment([item,healthy],"VALIDATE",json({candidate,trials}));
    await service().handle("evolution:a");
    const nextItem={...seedCase("different-defect"),defect:"dependency_order" as const};
    const next=experiment([nextItem,healthy],"PROPOSE",{},"different-defect-experiment");
    call.mockImplementation(input=>{
      expect((JSON.parse(input.prompt) as {experiences:unknown[]}).experiences).toEqual([]);
      return Promise.resolve({value:{strategy:candidate,fixes:[nextItem.caseId]},tokens:5});
    });
    await service().handle("evolution:a");
    expect(store.experiment(next.id)).toMatchObject({status:"RUNNING",phase:"VALIDATE"});
  });
  it("blocks a previously hard-violating method even when its incomplete comparison produced no experience", async () => {
    const item=seedCase("hard-counterexample");
    const previous=experiment([item],"VALIDATE",json({candidate,current:trial(item.caseId,"candidate")}));
    call.mockResolvedValue({value:{action:"finish",decision:"complete",evidenceIds:[]},tokens:5});
    await service().handle("evolution:a");
    expect(store.experiment(previous.id)).toMatchObject({status:"REJECTED",state:{reason:"hard_violation"}});
    const nextItem=seedCase("hard-repeat");
    const next=experiment([nextItem],"PROPOSE",{},"hard-repeat-experiment");
    call.mockResolvedValue({value:{strategy:candidate,fixes:[nextItem.caseId]},tokens:5});
    await service().handle("evolution:a");
    expect(store.experiment(next.id)).toMatchObject({status:"REJECTED",state:{reason:"invalid_candidate"}});
  });
  it("expires an under-sampled canary without issuing another model call", () => {
    const subject=service(); const old=revision("CANARY","2026-09-01T00:00:00.000Z");
    expect(subject.pending()).toEqual([]);
    subject.scan();
    expect(store.revision(old.id)).toMatchObject({status:"REJECTED",state:{reason:"insufficient_samples"}});
    expect(call).not.toHaveBeenCalled();
  });
  it("expires a candidate after thirty days of insufficient samples without spending", () => {
    const waiting=experiment([seedCase("expired-wait")],"VALIDATE",json({candidate,reason:"insufficient_samples"}));
    waiting.status="PAUSED"; store.saveExperiment(waiting);
    now="2026-11-24T01:00:00.000Z";
    service().scan();
    expect(store.experiment(waiting.id)).toMatchObject({status:"REJECTED",state:{reason:"insufficient_samples",candidate}});
    expect(call).not.toHaveBeenCalled();
  });
  it("keeps a production canary pending until independent matched controls exist", () => {
    const subject=service(); const current=revision(); const item=seedCase("canary-only","development","a",true);
    store.pinGoal({workbenchId:"a",goalId:item.goalId,revisionId:current.id,policy:JSON.stringify({pin,evaluatorVersion:METHOD_EVALUATOR_VERSION,cohortRevisionId:current.id}),at:now});
    vi.spyOn(store,"currentEvaluationCases").mockReturnValue([item]);
    vi.spyOn(store,"goalSourceMatches").mockReturnValue(true);
    subject.scan();
    expect(store.revision(current.id)).toMatchObject({status:"CANARY",state:{candidateGoals:[item.goalId],controlGoals:[]}});
    expect(call).not.toHaveBeenCalled();
  });
});
