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
  leaseRenew?: (input: { workId: string; workspaceRef: string }) => Promise<{ expiresAt: string } | null>;
  orphans?: PartnerDispatchOrphanRow[];
  prepareResult?: PreparedDispatch | "skipped_terminal" | Error;
  runError?: Error;
  runOutputs?: DispatchRunOutput[];
  runOverride?: () => Promise<DispatchRunOutput>;
}

function makeHarness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const completed: string[] = [];
  const completionOutputs: (DispatchRunOutput & { kind: "terminal" })[] = [];
  const diagnosticEvents: { event: string; fields: Record<string, unknown> }[] = [];
  const finalized: string[] = [];
  const released: string[] = [];
  let runCount = 0;
  const component = new AgentDispatchComponent({
    workbenchId: "workbench_1",
    claims: {
      listClaimable: async () => [...(options.claims ?? [])],
      listOrphanRuns: async () => [...(options.orphans ?? [])],
    },
    ...(options.leaseRenew === undefined ? {} : { leases: { renew: options.leaseRenew } }),
    delivery: {
      complete: async (input) => {
        completed.push(input.prepared.dispatchAttemptId);
        completionOutputs.push(input.output);
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
        if (options.runError !== undefined) throw options.runError;
        if (options.runOverride !== undefined) return options.runOverride();
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
  return { calls, completed, completionOutputs, component, diagnosticEvents, finalized, released };
}

function diagnosticsSink(events: { event: string; fields: Record<string, unknown> }[]) {
  return { emit: (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); } };
}

function ctxWithDiagnostics(offsetMillis: number, events: { event: string; fields: Record<string, unknown> }[]) {
  const now = new Date(new Date(BASE).getTime() + offsetMillis);
  return { clock: { now: () => now }, diagnostics: diagnosticsSink(events), now, tickId: 1 };
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
    expect(harness.finalized.length).toBe(1);
    expect(harness.calls).not.toContain("claim:outbox_1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.component.update(ctxAt(1_000));
    expect(harness.calls[0]).toBe("claim:outbox_1");
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.component.update(ctxAt(34_000));
    expect(harness.completed).toEqual(["attempt_1"]);
  });

  it("starts a waiting-remote retry without awaiting external I/O in the actor tick", async () => {
    let resolveRetry: ((value: DispatchRunOutput) => void) | undefined;
    let calls = 0;
    const harness = makeHarness({
      claims: [CLAIM],
      runOverride: async () => {
        calls += 1;
        if (calls === 1) return { kind: "waiting_remote" };
        return new Promise<DispatchRunOutput>((resolve) => { resolveRetry = resolve; });
      },
    });
    await harness.component.update(ctxAt(0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const retryTick = harness.component.update(ctxAt(1_000));
    const outcome = await Promise.race([
      retryTick.then(() => "returned"),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 25)),
    ]);
    expect(outcome).toBe("returned");

    resolveRetry?.(TERMINAL);
    await retryTick;
  });

  it("preserves a safe, structured transient failure instead of a generic terminal-output message", async () => {
    const runError = Object.assign(new Error("PRIVATE upstream body must never escape"), {
      code: "ETIMEDOUT",
      partnerRunFailure: {
        phase: "MODEL" as const,
        reasonCode: "ETIMEDOUT",
        retryable: true,
        sideEffectState: "NONE" as const,
      },
    });
    const harness = makeHarness({ claims: [CLAIM], runError });
    await harness.component.update(ctxAt(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.component.update(ctxAt(2_000));

    expect(harness.completionOutputs[0]).toMatchObject({
      failure: { phase: "MODEL", reasonCode: "ETIMEDOUT", retryable: true, sideEffectState: "NONE" },
      kind: "terminal",
      status: "FAILED",
    });
    expect(harness.completionOutputs[0]?.body).toContain("ETIMEDOUT");
    expect(harness.completionOutputs[0]?.body).not.toContain("PRIVATE upstream body");
    expect(harness.completionOutputs[0]?.body).not.toContain("terminal output");
  });

  it("marks unclassified run failures as non-replayable with unknown side effects", async () => {
    const harness = makeHarness({ claims: [CLAIM], runError: new Error("PRIVATE") });
    await harness.component.update(ctxAt(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.component.update(ctxAt(2_000));

    expect(harness.completionOutputs[0]).toMatchObject({
      failure: { reasonCode: "unknown_error", retryable: false, sideEffectState: "UNKNOWN" },
      status: "UNKNOWN",
    });
  });

  it("heartbeats the workspace lease only inside the renewal margin while a run is in flight", async () => {
    const prepared: PreparedDispatch = {
      ...PREPARED,
      workspaceLease: { expiresAt: new Date(new Date(BASE).getTime() + 5 * 60_000).toISOString(), workId: "work_1", workspaceRef: "workspace_ref" },
    };
    const renewCalls: { workId: string; workspaceRef: string }[] = [];
    const harness = makeHarness({
      claims: [CLAIM],
      leaseRenew: async (input) => {
        renewCalls.push(input);
        return { expiresAt: new Date(new Date(BASE).getTime() + 10 * 60_000).toISOString() };
      },
      prepareResult: prepared,
      runOverride: () => new Promise<DispatchRunOutput>(() => undefined),
    });
    await harness.component.update(ctxAt(0));
    expect(renewCalls).toEqual([]);

    // Well inside the lease lifetime: no renewal.
    await harness.component.update(ctxAt(2 * 60_000));
    expect(renewCalls).toEqual([]);

    // 30s left, below the 60s margin: exactly one renewal with the lease identity.
    await harness.component.update(ctxAt(4 * 60_000 + 30_000));
    expect(renewCalls).toEqual([{ workId: "work_1", workspaceRef: "workspace_ref" }]);

    // The renewed expiry (10 min from BASE) is now far away again.
    await harness.component.update(ctxAt(5 * 60_000));
    expect(renewCalls).toHaveLength(1);
  });

  it("converges a run to non-replayable UNKNOWN when its workspace lease is lost", async () => {
    const prepared: PreparedDispatch = {
      ...PREPARED,
      workspaceLease: { expiresAt: new Date(new Date(BASE).getTime() + 90_000).toISOString(), workId: "work_1", workspaceRef: "workspace_ref" },
    };
    const harness = makeHarness({
      claims: [CLAIM],
      leaseRenew: async () => null,
      prepareResult: prepared,
      runOverride: () => new Promise<DispatchRunOutput>(() => undefined),
    });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Next tick enters the renewal margin and the renewal reports the lease gone.
    await harness.component.update(ctxWithDiagnostics(31_000, harness.diagnosticEvents));
    expect(harness.diagnosticEvents.map((entry) => entry.event)).toContain("joi.agent.lease_lost");
    await harness.component.update(ctxWithDiagnostics(32_000, harness.diagnosticEvents));
    expect(harness.completed).toEqual(["attempt_1"]);
    expect(harness.completionOutputs[0]).toMatchObject({
      failure: { phase: "EXECUTION", reasonCode: "workspace_lease_lost", retryable: false, sideEffectState: "UNKNOWN" },
      kind: "terminal",
      status: "UNKNOWN",
    });
  });
});
