import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MethodLearningService, METHOD_EVALUATOR_VERSION } from "../../src/main/application/evolution/method-learning-service";
import { EvolutionModelCallError, type EvolutionModel } from "../../src/main/application/ports/evolution";
import type { JsonObject, MethodExperiment, MethodRevision } from "../../src/main/application/ports/method-learning";
import { buildLearningCases, learningProfile, type LearningCase } from "../../src/main/domain/evolution/learning-case";
import { baselineMethodPolicy, policyKey } from "../../src/main/domain/evolution/learning-policy";
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
  it.each(["timeout","provider_error","generic"] as const)("preserves the experiment on %s and records unknown usage honestly", async kind => {
    const seeded=experiment([seedCase(`failure-${kind}`)]); const subject=service();
    call.mockRejectedValue(kind==="generic" ? new Error("Private provider detail") : new EvolutionModelCallError({kind,toolCallCount:0},null));
    await subject.handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"PAUSED",state:{reason:"call_failed",tokens:null}});
    expect(store.experimentUsage(seeded.id)).toEqual({calls:1,tokens:0,tokensComplete:false});
    expect(subject.status("a").failure?.kind).toBe(kind==="generic" ? undefined : kind);
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
  it("caps unfinished isolated trials and preserves a failed baseline as counterevidence", async () => {
    const item=seedCase("bounded"); const seeded=experiment([item],"DEVELOP",json({current:{...trial(item.caseId),calls:5,modelCalls:5}}));
    call.mockResolvedValue({value:{action:"read_evidence",evidenceId:"requirements"},tokens:1});
    await service().handle("evolution:a");
    expect(store.experiment(seeded.id)?.state).toMatchObject({current:null,trials:[{success:false,calls:6}]});
  });
  it("rejects malformed proposals without losing their production evidence", async () => {
    const item=seedCase("proposal"); const seeded=experiment([item],"PROPOSE");
    call.mockResolvedValue({value:null,tokens:5});
    await service().handle("evolution:a");
    expect(store.experiment(seeded.id)).toMatchObject({status:"REJECTED",state:{reason:"invalid_candidate"}});
    expect(store.listCases()).toHaveLength(1);
  });
  it("expires an under-sampled canary without issuing another model call", () => {
    const subject=service(); const old=revision("CANARY","2026-09-01T00:00:00.000Z");
    expect(subject.pending()).toEqual([]);
    subject.scan();
    expect(store.revision(old.id)).toMatchObject({status:"REJECTED",state:{reason:"insufficient_samples"}});
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
