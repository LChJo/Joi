/* Asynchronous ports use local deterministic doubles. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { DomainError } from "../../src/main/domain/errors.js";
import type { GoalRequirements } from "../../src/main/domain/work/goal-requirements.js";
import type { GoalRequirementsRepository } from "../../src/main/application/ports/goal-requirements.js";
import type { JoiTurnRetryState } from "../../src/main/application/ports/joi-task.js";
import type { JoiCoordinatorStore } from "../../src/main/application/ports/joi-coordinator.js";
import { TestClock,TestIds } from "../support/runtime-fixture.js";
import { PiReasoningFailureClassifier } from "../../src/main/infrastructure/pi/pi-reasoning-failure-classifier.js";

const workbench=createWorkbench({ workbenchId:"bench",createdAt:"2026-11-02T00:00:00.000Z",memoryNamespaceId:"memory",name:"Synthetic",personaRevisionId:"persona",personaSummary:"Synthetic",project:{label:"Synthetic"},scopeSummary:"Synthetic",taskContext:{activeWorkIds:[],summary:""} });

function setup(kind:"requirements"|"capability",corrected:boolean,fallback=false,retryState?:JoiTurnRetryState) {
  let calls=0;
  let ready=kind!=="requirements";
  const prompts:string[]=[];
  const contract=():GoalRequirements=>({goalInputId:"goal",workbenchId:"bench",revision:1,sourceRevision:2,processedSourceRevision:ready?2:1,status:ready?"READY":"DIRTY",requirements:[]});
  const complete=vi.fn(async()=>{if(!ready)throw new DomainError("goal_requirements_pending","Synthetic pending requirement");});
  const fail=vi.fn(async()=>undefined);
  const avoidSource=vi.fn();
  const createTurn=vi.fn(async(_input:Parameters<JoiCoordinatorStore["createTurn"]>[0])=>undefined);
  const selectFallback=vi.fn(async(input:{turnId:string})=>fallback?{turnId:input.turnId,modelId:"synthetic",modelRevisionId:"fallback-model",sourceId:"fallback",sourceRevisionId:"fallback-revision",modelCapability:"release-tested" as const}:null);
  const coordinator=new JoiCoordinator({clock:new TestClock(),ids:new TestIds(),workbenches:{getWorkbench:async()=>workbench,listSummaries:async()=>[]},
    failureClassifier:new PiReasoningFailureClassifier(),
    ...(kind==="requirements"?{requirements:{ensure:async()=>contract(),load:async()=>contract()} as unknown as GoalRequirementsRepository}:{}),
    router:{decide:async()=>{throw new Error("Synthetic bound goal");}},
    sources:{avoidSource,selectFallback,selectInitial:async turnId=>({turnId,modelId:"synthetic",modelRevisionId:"model",sourceId:"source",sourceRevisionId:"revision",modelCapability:kind==="capability"?"custom-unverified-tools" as const:"release-tested" as const})},
    store:{loadInput:async()=>({inputId:"goal",body:"Synthetic work",status:"PENDING" as const,workbenchId:"bench",...(retryState===undefined?{}:{retryState})}),createTurn,completeInput:complete,failTurn:fail,requireClarification:async()=>undefined},
    runtime:{abort:()=>undefined,followUp:()=>undefined,isRunning:()=>false,restore:async()=>false,rollbackTurn:async()=>true,steer:()=>undefined,waitForIdle:async()=>undefined,
      startTurn:async turn=>{
        calls++;prompts.push(turn.prompt);
        if(calls===2&&corrected||turn.sourceId==="fallback"){
          ready=true;
          const toolName="work_dispatch";
          turn.onEvent?.({type:"tool_started",turnId:turn.turnId,toolName,toolCallId:"dispatch"});
          turn.onEvent?.({type:"tool_finished",turnId:turn.turnId,toolName,toolCallId:"dispatch",isError:false});
        }
        turn.onEvent?.({type:"text_delta",turnId:turn.turnId,delta:"Synthetic visible answer"});
        turn.onEvent?.({type:"turn_finished",turnId:turn.turnId});
      }},
  });
  return{coordinator,complete,fail,prompts,avoidSource,selectFallback,createTurn,get calls(){return calls;}};
}

describe("bounded tool-less prerequisite repair (AC-26/46/53/67)",()=>{
  it("rotates persisted failed context and retains the successful generation in a fresh coordinator",async()=>{
    const failed=setup("capability",true,false,{failureCount:4,sessionGeneration:2,epoch:1,reasonCode:"temporary_failure"});
    await failed.coordinator.handle("goal");
    expect(failed.createTurn).toHaveBeenCalledWith(expect.objectContaining({sessionGeneration:3,sessionId:"joi_session:bench:goal#3"}));
    const restarted=setup("capability",true,false,{failureCount:0,sessionGeneration:3,epoch:2});
    await restarted.coordinator.handle("goal");
    expect(restarted.createTurn).toHaveBeenCalledWith(expect.objectContaining({sessionGeneration:3,sessionId:"joi_session:bench:goal#3"}));
  });
  it.each(["requirements","capability"] as const)("repairs %s once before abandoning an executable goal",async kind=>{
    const harness=setup(kind,true);
    await expect(harness.coordinator.handle("goal")).resolves.toBeUndefined();
    expect(harness.calls).toBe(2);
    expect(harness.complete).toHaveBeenCalledOnce();
    expect(harness.fail).not.toHaveBeenCalled();
    expect(harness.prompts[1]).toContain(kind==="requirements"?"goal_read_inputs":"partner_list_available");
  });
  it.each(["requirements","capability"] as const)("bounds a repeated %s refusal to two model passes",async kind=>{
    const harness=setup(kind,false);
    await expect(harness.coordinator.handle("goal")).rejects.toMatchObject({code:kind==="requirements"?"goal_requirements_pending":"custom_model_tool_capability_unverified"});
    expect(harness.calls).toBe(2);
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.fail).toHaveBeenCalledOnce();
    expect(harness.avoidSource).not.toHaveBeenCalled();
  });
  it("uses the ordered fallback after one exhausted capability repair without treating the source as globally broken",async()=>{
    const harness=setup("capability",false,true);
    await expect(harness.coordinator.handle("goal")).resolves.toBeUndefined();
    expect(harness.calls).toBe(3);
    expect(harness.selectFallback).toHaveBeenCalledWith(expect.objectContaining({currentSourceId:"source",failure:"protocol",sideEffectStarted:false}));
    expect(harness.avoidSource).not.toHaveBeenCalled();
    expect(harness.fail).not.toHaveBeenCalled();
  });
});
