/* eslint-disable @typescript-eslint/require-await */
import { WorkbenchAgentComponent } from "../../src/main/application/actors/components/workbench-agent-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";
import type {
  WorkbenchPartnerKey,
  WorkbenchUnsynthesizedResult,
} from "../../src/main/application/ports/workbench-agent-scan";
import type {
  DispatchRunOutput,
  PartnerDispatchClaimRow,
  PartnerDispatchClaims,
  PartnerDispatchDelivery,
  PreparedDispatch,
} from "../../src/main/application/ports/partner-dispatch-delivery";
import type { RuntimeStore } from "../../src/main/application/ports/runtime-store";
import type { RuntimeDiagnostics } from "../../src/main/application/ports/runtime-diagnostics";

const BASE = "2026-08-05T10:00:00.000Z";

function ctxAt(offsetMillis: number, diagnostics?: RuntimeDiagnostics): ActorTickContext {
  const now = new Date(new Date(BASE).getTime() + offsetMillis);
  return {
    clock: { now: () => now },
    ...(diagnostics === undefined ? {} : { diagnostics }),
    now,
    tickId: 1,
  };
}

interface HarnessState {
  keys: WorkbenchPartnerKey[];
  unsynthesized: WorkbenchUnsynthesizedResult[];
}

function makeHarness(state: HarnessState, options?: {
  enqueueRefused?: boolean;
  memoryReject?: boolean;
  sweepEveryMillis?: number;
  withDispatch?: boolean;
  claims?: PartnerDispatchClaimRow[];
  prepared?: PreparedDispatch;
  run?: Promise<DispatchRunOutput>;
}) {
  const enqueued: { eventId: string; resultId: string }[] = [];
  const recorded: { partnerId: string; resultId?: string | undefined; workId?: string | undefined }[] = [];
  const sweeps: number[] = [];
  const attentionRepairs: string[] = [];
  const completed: string[] = [];
  const dispatch = {
    claims: {
      listClaimable: async () => options?.claims ?? [],
      listOrphanRuns: async () => [],
    } satisfies PartnerDispatchClaims,
    delivery: {
      complete: async (input) => { completed.push(input.prepared.dispatchAttemptId); return { isAuthoritative: true, resultId: "result_unused" }; },
      finalizeOrphan: async () => "completed" as const,
      handle: async () => undefined,
      prepare: async () => options?.prepared ?? "skipped_terminal" as const,
      run: async () => options?.run ?? { artifacts: [], body: "", kind: "terminal" as const, status: "COMPLETED" as const },
    } satisfies PartnerDispatchDelivery,
    outbox: {
      claimOutboxById: async (input) => options?.claims?.some((claim) => claim.outboxId === input.outboxId)
        ? { attemptCount: 0, availableAt: BASE, createdAt: BASE, kind: "partner.dispatch", outboxId: input.outboxId, payload: {}, status: "CLAIMED" }
        : null,
      completeOutbox: async () => undefined,
      releaseOutbox: async () => undefined,
    } satisfies Pick<RuntimeStore, "claimOutboxById" | "completeOutbox" | "releaseOutbox">,
    owner: "actor-test",
  };
  const component = new WorkbenchAgentComponent({
    attention: { reconcile: async (input) => { attentionRepairs.push(input.reasonCode); return 0; } },
    workbenchId: "workbench_1",
    ...(options?.withDispatch === true ? { dispatch } : {}),
    instances: { sweepIdleFor: async (workbenchId: string, now: Date) => { sweeps.push(now.getTime()); return { disposed: 0, evicted: 0 }; } },
    memory: { recordResult: async (input: { partnerId: string; resultId?: string; workId?: string }) => {
      recorded.push({ partnerId: input.partnerId, resultId: input.resultId, workId: input.workId });
      if (options?.memoryReject === true) throw new Error("memory_unavailable");
    } },
    scan: {
      listPartnerKeys: async () => [...state.keys],
      listUnsynthesizedResults: async () => [...state.unsynthesized],
    },
    synthesis: {
      enqueuePartnerResult: async (event: { eventId: string; resultId: string }) => {
        enqueued.push({ eventId: event.eventId, resultId: event.resultId });
        return options?.enqueueRefused === true ? null : "joi_result_input:goal:input_1";
      },
    },
    ...(options?.sweepEveryMillis === undefined ? {} : { sweepEveryMillis: options.sweepEveryMillis }),
  });
  return { attentionRepairs, completed, component, enqueued, recorded, sweeps };
}

const RESULT: WorkbenchUnsynthesizedResult = {
  workbenchId: "workbench_1",
  eventId: "partner_result:run_1:COMPLETED",
  partnerId: "partner_1",
  resultId: "work_result:run_1:COMPLETED",
  sessionDataSource: "partner_instance_messages:inst_1",
  status: "COMPLETED",
  summary: "done",
  title: "create file",
  workId: "work_1",
};

describe("WorkbenchAgentComponent", () => {
  it("retains an in-flight actor until its terminal result has been acknowledged", async () => {
    const state: HarnessState = { keys: [{ partnerId: "partner_1" }], unsynthesized: [] };
    let finish!: (output: DispatchRunOutput) => void;
    const run = new Promise<DispatchRunOutput>((resolve) => { finish = resolve; });
    const claims: PartnerDispatchClaimRow[] = [{ attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" }];
    const harness = makeHarness(state, { withDispatch: true, claims, run, prepared: {
      actionId: "action_1", attemptCount: 0, dispatchAttemptId: "attempt_1", kind: "LOCAL_PI", outboxId: "outbox_1", workId: "work_1",
    } });
    await harness.component.update(ctxAt(0));
    const actor = harness.component.agentActors[0];
    if (actor === undefined) throw new Error("agent_missing");
    await actor.update(ctxAt(0));
    state.keys = [];
    claims.length = 0;
    await harness.component.update(ctxAt(1_000));
    expect(harness.component.agentActors).toEqual([actor]);
    finish({ artifacts: [], body: "done", kind: "terminal", status: "COMPLETED" });
    await run;
    await actor.update(ctxAt(2_000));
    await harness.component.update(ctxAt(3_000));
    expect(harness.completed).toEqual(["attempt_1"]);
    expect(harness.component.agentActors).toEqual([]);
  });
  it("folds unsynthesized results into synthesis and memory exactly once", async () => {
    const state: HarnessState = { keys: [], unsynthesized: [RESULT] };
    const harness = makeHarness(state);
    await harness.component.update(ctxAt(0));
    expect(harness.enqueued).toEqual([{ eventId: RESULT.eventId, resultId: RESULT.resultId }]);
    expect(harness.recorded).toEqual([{ partnerId: "partner_1", resultId: RESULT.resultId, workId: "work_1" }]);

    // The member row written by enqueue removes the result from the next traversal.
    state.unsynthesized = [];
    await harness.component.update(ctxAt(1_000));
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.recorded).toHaveLength(1);
  });

  it("does not report an enqueue the store refused", async () => {
    const state: HarnessState = { keys: [], unsynthesized: [RESULT] };
    const harness = makeHarness(state, { enqueueRefused: true });
    const emitted: string[] = [];

    await harness.component.update(ctxAt(0, { emit: (event) => { emitted.push(event); } }));

    // The store declines a result it cannot admit yet and leaves it for a later tick. Reporting
    // that as an enqueue made the diagnostics claim progress on every refused retry.
    expect(harness.enqueued).toHaveLength(1);
    expect(emitted).not.toContain("joi.workbench.synthesis_enqueued");
  });

  it("reconciles leaf agent actors from partner keys", async () => {
    const state: HarnessState = { keys: [{ partnerId: "partner_1" }], unsynthesized: [] };
    const harness = makeHarness(state);
    await harness.component.update(ctxAt(0));
    expect(harness.component.agentActors.map((actor) => actor.partnerId)).toEqual(["partner_1"]);

    state.keys = [{ partnerId: "partner_2" }];
    await harness.component.update(ctxAt(1_000));
    expect(harness.component.agentActors.map((actor) => actor.partnerId)).toEqual(["partner_2"]);
  });

  it("reconciles durable attention requests and throttles the idle sweep", async () => {
    const state: HarnessState = { keys: [], unsynthesized: [] };
    const harness = makeHarness(state);
    await harness.component.update(ctxAt(0));
    expect(harness.attentionRepairs).toEqual(["partner_waiting_recovery_required"]);
    expect(harness.sweeps).toHaveLength(1);

    await harness.component.update(ctxAt(5_000));
    expect(harness.sweeps).toHaveLength(1);

    await harness.component.update(ctxAt(61_000));
    expect(harness.sweeps).toHaveLength(2);
  });

  it("retains discoverable results when durable memory recording fails", async () => {
    const state: HarnessState = {
      keys: [{ partnerId: "partner_1" }],
      unsynthesized: [RESULT],
    };
    const harness = makeHarness(state, { memoryReject: true, sweepEveryMillis: 1, withDispatch: true });

    await expect(harness.component.update(ctxAt(0))).rejects.toThrow("memory_unavailable");
    expect(harness.enqueued).toHaveLength(0);
    state.unsynthesized = [];
    await harness.component.update(ctxAt(2));

    expect(harness.component.agentActors.map((actor) => actor.partnerId)).toEqual(["partner_1"]);
    expect(harness.recorded).toHaveLength(1);
    expect(harness.sweeps).toHaveLength(1);
  });
});
