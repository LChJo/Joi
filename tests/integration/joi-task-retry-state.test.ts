/* Disposable SQLite owns the durable scheduler state. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiTaskComponent } from "../../src/main/application/actors/components/joi-task-component.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteJoiTaskReader } from "../../src/main/infrastructure/persistence/sqlite-joi-task-reader.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

async function setup() {
  const fixture=await createRuntimeFixture();
  const workbench=await fixture.workbenchRegistry.create({name:"Retry",personaSummary:"Synthetic",projectLabel:"Synthetic",scopeSummary:"Synthetic"});
  const inbox=new SqliteJoiInboxRepository(fixture.database,fixture.clock);
  const now=fixture.clock.now().toISOString();
  await inbox.create({inputId:"retry-goal",idempotencyKey:"retry-goal",body:"Synthetic task",status:"PENDING",workbenchId:workbench.workbenchId,createdAt:now,updatedAt:now});
  const reader=()=>new SqliteJoiTaskReader({database:fixture.database,failTurn:inbox.failTurn.bind(inbox),park:async(id,failure)=>{await inbox.park(id,failure);}});
  const fail=async(index:number)=>{
    fixture.clock.advance(1_000);
    await inbox.createTurn({inputId:"retry-goal",turnId:`failed-${String(index)}`,sessionId:"retry-session",workbenchId:workbench.workbenchId,createdAt:fixture.clock.now().toISOString()});
    await inbox.failTurn("retry-goal",`failed-${String(index)}`,{reasonCode:"temporary_failure",replaySafe:true});
  };
  return{fixture,workbench,inbox,reader,fail};
}

describe("durable JOI retry ownership (AC-10/46/53/67)",()=>{
  it("does not let a settled old actor failure delay an explicit continuation",async()=>{
    const {fixture,workbench,inbox,reader}=await setup();
    try{
      let rejectOld:(error:Error)=>void=()=>undefined;
      let calls=0;
      const actor=new JoiTaskComponent({driver:{handle:async()=>{
        if(++calls>1)return await new Promise<void>(()=>undefined);
        await inbox.createTurn({inputId:"retry-goal",turnId:"old-actor-turn",sessionId:"old",workbenchId:workbench.workbenchId,createdAt:fixture.clock.now().toISOString()});
        await inbox.recordTurnProgress("old-actor-turn",{formalOutputStarted:false,sideEffectStarted:true});
        await inbox.failTurn("retry-goal","old-actor-turn",{reasonCode:"temporary_failure"});
        await new Promise<void>((_resolve,reject)=>{rejectOld=reject;});
      }},gate:{hasReadySource:async()=>true},inbox:reader()});
      await actor.update({clock:fixture.clock,now:fixture.clock.now(),tickId:1});
      await new Promise(resolve=>setTimeout(resolve,0));
      expect(await inbox.retry("retry-goal",{})).toMatchObject({status:"PENDING"});
      rejectOld(Object.assign(new Error("Synthetic late settlement"),{code:"temporary_failure"}));
      await new Promise(resolve=>setTimeout(resolve,0));
      await actor.update({clock:fixture.clock,now:fixture.clock.now(),tickId:2});
      expect(await reader().getRetryState("retry-goal")).toMatchObject({failureCount:0});
      expect((await reader().getRetryState("retry-goal"))?.retryAt).toBeUndefined();
      expect(calls).toBe(2);
    }finally{await fixture.close();}
  });
  it("persists failures before a reasoning turn can be created",async()=>{
    const {fixture,reader}=await setup();
    try{
      const actor=new JoiTaskComponent({driver:{handle:async()=>{throw Object.assign(new Error("Synthetic source unavailable"),{code:"source_not_ready"});}},gate:{hasReadySource:async()=>true},inbox:reader()});
      await actor.update({clock:fixture.clock,now:fixture.clock.now(),tickId:1});
      await new Promise(resolve=>setTimeout(resolve,0));
      await actor.update({clock:fixture.clock,now:fixture.clock.now(),tickId:2});
      expect(await reader().getRetryState("retry-goal")).toMatchObject({failureCount:1,reasonCode:"source_not_ready"});
    }finally{await fixture.close();}
  });
  it("records each failed turn once and preserves its cooldown across reader and actor restarts",async()=>{
    const {fixture,inbox,reader,fail}=await setup();
    try{
      await fail(1);await fail(2);await fail(3);
      await inbox.failTurn("retry-goal","failed-3",{reasonCode:"temporary_failure",replaySafe:false});
      const retryAt=new Date(fixture.clock.now().getTime()+120_000).toISOString();
      expect(await reader().getRetryState("retry-goal")).toMatchObject({failureCount:3,reasonCode:"temporary_failure"});
      expect(await reader().deferRetry("retry-goal",{failureCount:3,retryAt})).toBe(true);
      const restarted=reader();
      expect((await restarted.listPendingInputs())[0]?.retryState).toMatchObject({failureCount:3,retryAt});
      const handle=vi.fn(async()=>undefined);
      const actor=new JoiTaskComponent({driver:{handle},gate:{hasReadySource:async()=>true},inbox:restarted});
      const tick=()=>actor.update({clock:fixture.clock,now:fixture.clock.now(),tickId:1});
      await tick();expect(handle).not.toHaveBeenCalled();
      fixture.clock.advance(120_000);await tick();expect(handle).toHaveBeenCalledOnce();
    }finally{await fixture.close();}
  });

  it("reconstructs a missing cooldown after a crash between failure commit and actor settlement",async()=>{
    const {fixture,reader,fail}=await setup();
    try{
      await fail(1);
      const handle=vi.fn(async()=>undefined);
      const inbox=reader();
      const actor=new JoiTaskComponent({driver:{handle},gate:{hasReadySource:async()=>true},inbox});
      await actor.update({clock:fixture.clock,now:fixture.clock.now(),tickId:1});
      expect(handle).not.toHaveBeenCalled();
      expect(await inbox.getRetryState("retry-goal")).toMatchObject({failureCount:1,retryAt:new Date(fixture.clock.now().getTime()+30_000).toISOString()});
    }finally{await fixture.close();}
  });

  it("parks an exhausted input after restart instead of resetting its failure budget",async()=>{
    const {fixture,inbox,reader,fail}=await setup();
    try{
      for(let n=1;n<=8;n++)await fail(n);
      const handle=vi.fn(async()=>undefined);
      const actor=new JoiTaskComponent({driver:{handle},gate:{hasReadySource:async()=>true},inbox:reader()});
      await actor.update({clock:fixture.clock,now:fixture.clock.now(),tickId:1});
      expect(handle).not.toHaveBeenCalled();
      expect((await inbox.list()).find(row=>row.inputId==="retry-goal")).toMatchObject({status:"CONSUMED",failureCount:8,failureReasonCode:"temporary_failure"});
      expect((await inbox.list()).find(row=>row.inputId==="retry-goal")?.failedAt).toBeDefined();
    }finally{await fixture.close();}
  });

  it("resets an explicit retry's budget while retaining its persisted session generation and rejects stale cooldown writes",async()=>{
    const {fixture,workbench,inbox,reader,fail}=await setup();
    try{
      await inbox.createTurn({inputId:"retry-goal",turnId:"generation-turn",sessionId:"retry-session#2",sessionGeneration:2,workbenchId:workbench.workbenchId,createdAt:fixture.clock.now().toISOString()});
      await inbox.failTurn("retry-goal","generation-turn",{reasonCode:"temporary_failure",replaySafe:true});
      await inbox.park("retry-goal",{failureCount:1,reasonCode:"temporary_failure"});
      expect(await inbox.retry("retry-goal",{})).toMatchObject({status:"PENDING"});
      expect(await reader().getRetryState("retry-goal")).toMatchObject({failureCount:0,sessionGeneration:2,epoch:1});
      expect(await reader().deferRetry("retry-goal",{failureCount:1,retryAt:new Date(fixture.clock.now().getTime()+60_000).toISOString()})).toBe(false);
      expect((await inbox.loadInput("retry-goal"))?.retryState).toMatchObject({failureCount:0,sessionGeneration:2});
      await fail(99);
      expect(await reader().deferRetry("retry-goal",{failureCount:1,epoch:0,retryAt:new Date(fixture.clock.now().getTime()+60_000).toISOString()})).toBe(false);
    }finally{await fixture.close();}
  });
});
