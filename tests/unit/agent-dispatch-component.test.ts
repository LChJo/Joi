/* eslint-disable @typescript-eslint/require-await */
import { AgentDispatchComponent } from "../../src/main/application/actors/components/agent-dispatch-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";
import type {
  DispatchRunOutput,
  PartnerDispatchClaimRow,
  PartnerDispatchOrphanRow,
  PreparedDispatch,
} from "../../src/main/application/ports/partner-dispatch-delivery";

const BASE = "2026-08-05T10:00:00.000Z";

function ctxAt(offsetMillis: number): ActorTickContext {
  const now = new Date(new Date(BASE).getTime() + offsetMillis);
  return { clock: { now: () => now }, now, tickId: 1 };
}

const CLAIM: PartnerDispatchClaimRow = { attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" };
const PREPARED: PreparedDispatch = { actionId: "action_1", attemptCount: 0, dispatchAttemptId: "attempt_1", kind: "LOCAL_PI", outboxId: "outbox_1" };
const TERMINAL: DispatchRunOutput = { artifacts: [], body: "done", kind: "terminal", status: "COMPLETED" };

interface HarnessOptions {
  claims?: PartnerDispatchClaimRow[];
  orphans?: PartnerDispatchOrphanRow[];
  prepareResult?: PreparedDispatch | "skipped_terminal" | Error;
  runOutputs?: DispatchRunOutput[];
}

function makeHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const completed: string[] = [];
  const finalized: string[] = [];
  const released: string[] = [];
  let runCount = 0;
  const component = new AgentDispatchComponent({
    workbenchId: "workbench_1",
    claims: {
      listClaimable: async () => [...(options.claims ?? [])],
      listOrphanRuns: async () => [...(options.orphans ?? [])],
    },
    delivery: {
      complete: async (input) => {
        completed.push(input.prepared.dispatchAttemptId);
        calls.push("complete");
        return { isAuthoritative: true, resultId: "result_1" };
      },
      finalizeOrphan: async (orphan) => {
        finalized.push(orphan.dispatchAttemptId);
        return "completed" as const;
      },
      handle: async () => undefined,
      prepare: async () => {
        const result = options.prepareResult ?? PREPARED;
        if (result instanceof Error) throw result;
        return result;
      },
      run: async () => {
        calls.push("run");
        runCount += 1;
        return (options.runOutputs ?? [TERMINAL])[Math.min(runCount - 1, (options.runOutputs ?? [TERMINAL]).length - 1)] ?? TERMINAL;
      },
    },
    outbox: {
      claimOutboxById: async (input) => {
        const claim = (options.claims ?? []).find((entry) => entry.outboxId === input.outboxId);
        if (claim === undefined) return null;
        options.claims = (options.claims ?? []).filter((entry) => entry.outboxId !== input.outboxId);
        calls.push(`claim:${input.outboxId}`);
        return { attemptCount: 0, availableAt: BASE, createdAt: BASE, kind: "partner.dispatch", outboxId: input.outboxId, payload: {}, status: "CLAIMED" };
      },
      completeOutbox: async (outboxId) => {
        calls.push(`ack:${outboxId}`);
      },
      releaseOutbox: async (input) => {
        released.push(input.outboxId);
      },
    },
    owner: "agent_test",
    partnerId: "partner_1",
  });
  return { calls, completed, component, finalized, released };
}

describe("AgentDispatchComponent", () => {
  it("acks the outbox before firing the run and converges the terminal result on the next tick", async () => {
    const harness = makeHarness({ claims: [CLAIM] });
    await harness.component.update(ctxAt(0));
    expect(harness.calls.slice(0, 3)).toEqual(["claim:outbox_1", "ack:outbox_1", "run"]);
    expect(harness.completed).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.component.update(ctxAt(2_000));
    expect(harness.completed).toEqual(["attempt_1"]);
  });

  it("releases the claim with backoff when prepare fails", async () => {
    const harness = makeHarness({ claims: [CLAIM], prepareResult: new Error("workbench_workspace_not_ready") });
    await harness.component.update(ctxAt(0));
    expect(harness.released).toEqual(["outbox_1"]);
    expect(harness.calls).not.toContain("run");
  });

  it("acks skipped-terminal claims without running", async () => {
    const harness = makeHarness({ claims: [CLAIM], prepareResult: "skipped_terminal" });
    await harness.component.update(ctxAt(0));
    expect(harness.calls).toContain("ack:outbox_1");
    expect(harness.calls).not.toContain("run");
  });

  it("finalizes orphaned runs on the first tick before claiming", async () => {
    const harness = makeHarness({
      claims: [CLAIM],
      orphans: [{ dispatchAttemptId: "attempt_orphan", instanceStatus: "DISPOSED", kind: "LOCAL_PI", runId: "run_x" }],
    });
    await harness.component.update(ctxAt(0));
    expect(harness.finalized).toEqual(["attempt_orphan"]);
    expect(harness.calls[0]).toBe("claim:outbox_1");
    expect(harness.finalized.length).toBe(1);
  });

  it("retries waiting remote runs on a throttle until terminal", async () => {
    const harness = makeHarness({
      claims: [CLAIM],
      runOutputs: [{ kind: "waiting_remote" }, { kind: "waiting_remote" }, TERMINAL],
    });
    await harness.component.update(ctxAt(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.calls.filter((call) => call === "run")).toHaveLength(1);

    await harness.component.update(ctxAt(1_000));
    expect(harness.calls.filter((call) => call === "run")).toHaveLength(2);
    expect(harness.completed).toEqual([]);

    // Inside the throttle window no extra remote retry fires.
    await harness.component.update(ctxAt(10_000));
    expect(harness.calls.filter((call) => call === "run")).toHaveLength(2);

    await harness.component.update(ctxAt(32_000));
    expect(harness.calls.filter((call) => call === "run")).toHaveLength(3);
    expect(harness.completed).toEqual(["attempt_1"]);
  });
});
