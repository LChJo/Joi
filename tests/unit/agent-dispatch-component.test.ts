/* eslint-disable @typescript-eslint/require-await */
import { AgentDispatchComponent } from "../../src/main/application/actors/components/agent-dispatch-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";
import type {
  DispatchRunOutput,
  PartnerDispatchClaimRow,
  PartnerDispatchOrphanRow,
  PreparedDispatch,
} from "../../src/main/application/ports/partner-dispatch-delivery";
import { LocalDispatchCapacityController } from "../../src/main/application/work/local-dispatch-capacity";

const BASE = "2026-08-05T10:00:00.000Z";

function ctxAt(offsetMillis: number): ActorTickContext {
  const now = new Date(new Date(BASE).getTime() + offsetMillis);
  return { clock: { now: () => now }, now, tickId: 1 };
}

const CLAIM: PartnerDispatchClaimRow = { attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" };
const PREPARED: PreparedDispatch = { actionId: "action_1", attemptCount: 0, dispatchAttemptId: "attempt_1", kind: "LOCAL_PI", outboxId: "outbox_1", workId: "work_1" };
const TERMINAL: DispatchRunOutput = { artifacts: [], body: "done", kind: "terminal", status: "COMPLETED" };

interface HarnessOptions {
  abandonError?: Error;
  capacity?: LocalDispatchCapacityController;
  claims?: PartnerDispatchClaimRow[];
  leaseRenew?: (input: { workId: string; workspaceRef: string }) => Promise<{ expiresAt: string } | null>;
  orphans?: PartnerDispatchOrphanRow[];
  prepareResult?: PreparedDispatch | "skipped_terminal" | Error;
  prepareOverride?: (claim: PartnerDispatchClaimRow) => Promise<PreparedDispatch | "skipped_terminal">;
  runError?: Error;
  runOutputs?: DispatchRunOutput[];
  runOverride?: () => Promise<DispatchRunOutput>;
  watchdogMillis?: number;
  workCanceled?: (workId: string) => Promise<boolean>;
}

function makeHarness(options: HarnessOptions = {}) {
  const abandoned: { dispatchAttemptId: string; reasonCode: string }[] = [];
  const calls: string[] = [];
  const completed: string[] = [];
  const completionOutputs: (DispatchRunOutput & { kind: "terminal" })[] = [];
  const diagnosticEvents: { event: string; fields: Record<string, unknown> }[] = [];
  const finalized: string[] = [];
  const released: string[] = [];
  const releaseAvailableAt: string[] = [];
  const runSignals: (AbortSignal | undefined)[] = [];
  const progressCallbacks: (() => void)[] = [];
  let runCount = 0;
  const component = new AgentDispatchComponent({
    workbenchId: "workbench_1",
    claims: {
      listClaimable: async () => [...(options.claims ?? [])],
      listOrphanRuns: async () => [...(options.orphans ?? [])],
    },
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.leaseRenew === undefined ? {} : { leases: { renew: options.leaseRenew } }),
    delivery: {
      abandon: async (input) => {
        if (options.abandonError !== undefined) throw options.abandonError;
        abandoned.push({ dispatchAttemptId: input.claim.dispatchAttemptId, reasonCode: input.reasonCode });
        calls.push("abandon");
      },
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
      prepare: async (claim) => {
        if (options.prepareOverride !== undefined) return options.prepareOverride(claim);
        const result = options.prepareResult ?? PREPARED;
        if (result instanceof Error) throw result;
        return result;
      },
      run: async (_prepared, runOptions) => {
        calls.push("run");
        runCount += 1;
        runSignals.push(runOptions?.signal);
        progressCallbacks.push(runOptions?.onProgress ?? (() => undefined));
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
        return { attemptCount: claim.attemptCount, availableAt: BASE, createdAt: BASE, kind: "partner.dispatch", outboxId: input.outboxId, payload: {}, status: "CLAIMED" };
      },
      completeOutbox: async (outboxId) => {
        calls.push(`ack:${outboxId}`);
      },
      releaseOutbox: async (input) => {
        released.push(input.outboxId);
        releaseAvailableAt.push(input.availableAt);
      },
    },
    owner: "agent_test",
    partnerId: "partner_1",
    ...(options.watchdogMillis === undefined ? {} : { watchdogMillis: options.watchdogMillis }),
    ...(options.workCanceled === undefined ? {} : { workCanceled: options.workCanceled }),
  });
  return { abandoned, calls, completed, completionOutputs, component, diagnosticEvents, finalized, releaseAvailableAt, released, runSignals, progressCallbacks };
}

function diagnosticsSink(events: { event: string; fields: Record<string, unknown> }[]) {
  return { emit: (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); } };
}

function ctxWithDiagnostics(offsetMillis: number, events: { event: string; fields: Record<string, unknown> }[]) {
  const now = new Date(new Date(BASE).getTime() + offsetMillis);
  return { clock: { now: () => now }, diagnostics: diagnosticsSink(events), now, tickId: 1 };
}

describe("AgentDispatchComponent", () => {
  it("starts independent dispatch slots for the same partner without waiting for the first run", async () => {
    const claims = [
      { attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" },
      { attemptCount: 0, dispatchAttemptId: "attempt_2", outboxId: "outbox_2", payloadJson: "{}" },
    ];
    const pending: (() => void)[] = [];
    const harness = makeHarness({
      claims,
      prepareOverride: async (claim) => ({ ...PREPARED, dispatchAttemptId: claim.dispatchAttemptId, outboxId: claim.outboxId, workId: `work_${claim.dispatchAttemptId}` }),
      runOverride: () => new Promise<DispatchRunOutput>((resolve) => pending.push(() => resolve(TERMINAL))),
    });

    await harness.component.update(ctxAt(0));
    expect(harness.calls.filter((call) => call === "run")).toHaveLength(2);

    pending.forEach((resolve) => resolve());
  });

  it("continues to another claim when the first Work is waiting on a resource lease", async () => {
    const conflict = Object.assign(new Error("busy"), { code: "workspace_lease_conflict" });
    const claims = [
      { attemptCount: 0, dispatchAttemptId: "attempt_busy", outboxId: "outbox_busy", payloadJson: "{}" },
      { attemptCount: 0, dispatchAttemptId: "attempt_ready", outboxId: "outbox_ready", payloadJson: "{}" },
    ];
    const harness = makeHarness({
      claims,
      prepareOverride: async (claim) => {
        if (claim.dispatchAttemptId === "attempt_busy") throw conflict;
        return { ...PREPARED, dispatchAttemptId: claim.dispatchAttemptId, outboxId: claim.outboxId, workId: "work_ready" };
      },
    });

    await harness.component.update(ctxAt(0));
    expect(harness.released).toEqual(["outbox_busy"]);
    expect(harness.calls).toContain("claim:outbox_ready");
    expect(harness.calls).toContain("run");
  });

  it("keeps a paused goal queued with the generic resource reason", async () => {
    const harness = makeHarness({
      claims: [CLAIM],
      prepareResult: Object.assign(new Error("paused"), { code: "goal_execution_paused" }),
    });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    expect(harness.released).toEqual(["outbox_1"]);
    expect(harness.diagnosticEvents.map((entry) => entry.event)).toEqual(["joi.agent.resource_queued"]);
    expect(harness.diagnosticEvents[0]?.fields.reasonCode).toBe("goal_execution_paused");
  });

  it("reserves and releases shared local capacity for a completed slot", async () => {
    const capacity = new LocalDispatchCapacityController();
    const harness = makeHarness({ capacity, claims: [{ ...CLAIM, kind: "LOCAL_PI" }] });
    await harness.component.update(ctxAt(0));
    expect(capacity.snapshot().global).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.component.update(ctxAt(2_000));
    expect(capacity.snapshot().global).toBe(0);
  });

  it("leaves a local claim untouched when the partner capacity is full", async () => {
    const capacity = new LocalDispatchCapacityController();
    for (let index = 0; index < 4; index += 1) {
      capacity.reserve({ dispatchAttemptId: `held-${String(index)}`, partnerId: "partner_1" });
    }
    const harness = makeHarness({ capacity, claims: [{ ...CLAIM, kind: "LOCAL_PI" }] });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    expect(harness.calls).not.toContain("claim:outbox_1");
    expect(harness.diagnosticEvents).toEqual([expect.objectContaining({ event: "joi.agent.capacity_queued" })]);
  });

  it("keeps A2A dispatch serial within one partner actor", async () => {
    const claims = [
      { ...CLAIM, kind: "A2A" as const },
      { ...CLAIM, dispatchAttemptId: "attempt_2", kind: "A2A" as const, outboxId: "outbox_2" },
    ];
    const harness = makeHarness({
      claims,
      prepareOverride: async (claim) => ({
        ...PREPARED, dispatchAttemptId: claim.dispatchAttemptId, kind: "A2A", outboxId: claim.outboxId,
      }),
      runOverride: () => new Promise<DispatchRunOutput>(() => undefined),
    });
    await harness.component.update(ctxAt(0));
    expect(harness.calls.filter((call) => call === "run")).toHaveLength(1);
    expect(harness.calls).not.toContain("claim:outbox_2");
  });

  it("cancels only the matching running slot while another slot keeps running", async () => {
    const claims = [
      { attemptCount: 0, dispatchAttemptId: "attempt_1", outboxId: "outbox_1", payloadJson: "{}" },
      { attemptCount: 0, dispatchAttemptId: "attempt_2", outboxId: "outbox_2", payloadJson: "{}" },
    ];
    const canceled = new Set<string>();
    const harness = makeHarness({
      claims,
      prepareOverride: async (claim) => ({
        ...PREPARED,
        dispatchAttemptId: claim.dispatchAttemptId,
        outboxId: claim.outboxId,
        workId: claim.dispatchAttemptId === "attempt_1" ? "work_1" : "work_2",
      }),
      runOverride: () => new Promise<DispatchRunOutput>(() => undefined),
      workCanceled: async (workId) => canceled.has(workId),
    });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    expect(harness.runSignals).toHaveLength(2);

    canceled.add("work_1");
    await harness.component.update(ctxWithDiagnostics(2_000, harness.diagnosticEvents));
    expect(harness.runSignals[0]?.aborted).toBe(true);
    expect(harness.runSignals[1]?.aborted).toBe(false);
    expect(harness.completed).toEqual(["attempt_1"]);
  });

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
    expect(harness.runSignals[0]?.aborted).toBe(true);
    await harness.component.update(ctxWithDiagnostics(32_000, harness.diagnosticEvents));
    expect(harness.completed).toEqual(["attempt_1"]);
    expect(harness.completionOutputs[0]).toMatchObject({
      failure: { phase: "EXECUTION", reasonCode: "workspace_lease_lost", retryable: false, sideEffectState: "UNKNOWN" },
      kind: "terminal",
      status: "UNKNOWN",
    });
  });

  it("aborts an in-flight run once its goal is canceled and converges it as goal_canceled", async () => {
    let canceled = false;
    const harness = makeHarness({
      claims: [CLAIM],
      runOverride: () => new Promise<DispatchRunOutput>(() => undefined),
      workCanceled: async (workId) => workId === "work_1" && canceled,
    });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    expect(harness.runSignals[0]?.aborted).toBe(false);

    canceled = true;
    await harness.component.update(ctxWithDiagnostics(2_000, harness.diagnosticEvents));
    expect(harness.runSignals[0]?.aborted).toBe(true);
    expect(harness.diagnosticEvents.map((entry) => entry.event)).toContain("joi.agent.run_canceled");
    // The terminal settle converges on the same tick; the delivery adapter no-ops it
    // against the FAILED attempt the cancel already wrote.
    expect(harness.completed).toEqual(["attempt_1"]);
    expect(harness.completionOutputs[0]).toMatchObject({
      failure: { phase: "EXECUTION", reasonCode: "goal_canceled", retryable: false, sideEffectState: "UNKNOWN" },
      kind: "terminal",
      status: "UNKNOWN",
    });
    // A later tick neither re-converges nor claims a new run for the canceled goal.
    await harness.component.update(ctxWithDiagnostics(4_000, harness.diagnosticEvents));
    expect(harness.completed).toHaveLength(1);
    expect(harness.calls.filter((call) => call === "run")).toHaveLength(1);
  });

  it("keeps workspace contention queued with a short retry even after the generic preparation budget", async () => {
    const exhaustedClaim: PartnerDispatchClaimRow = { ...CLAIM, attemptCount: 6 };
    const harness = makeHarness({
      claims: [exhaustedClaim],
      prepareResult: Object.assign(new Error("The workspace lease could not be acquired."), { code: "workspace_lease_conflict" }),
    });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    expect(harness.abandoned).toEqual([]);
    expect(harness.calls).not.toContain("ack:outbox_1");
    expect(harness.released).toEqual(["outbox_1"]);
    expect(harness.releaseAvailableAt).toEqual(["2026-08-05T10:00:05.000Z"]);
    expect(harness.calls).not.toContain("run");
    expect(harness.diagnosticEvents.map((entry) => entry.event)).toContain("joi.agent.workspace_contended");
    expect(harness.diagnosticEvents.map((entry) => entry.event)).not.toContain("joi.agent.prepare_exhausted");
  });

  it("still abandons an exhausted non-contention preparation failure", async () => {
    const exhaustedClaim: PartnerDispatchClaimRow = { ...CLAIM, attemptCount: 6 };
    const harness = makeHarness({
      claims: [exhaustedClaim],
      prepareResult: Object.assign(new Error("Partner configuration is invalid."), { code: "partner_configuration_invalid" }),
    });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    expect(harness.abandoned).toEqual([{ dispatchAttemptId: "attempt_1", reasonCode: "partner_configuration_invalid" }]);
    expect(harness.calls).toContain("ack:outbox_1");
    expect(harness.released).toEqual([]);
    expect(harness.calls).not.toContain("run");
    expect(harness.diagnosticEvents.map((entry) => entry.event)).toContain("joi.agent.prepare_exhausted");
  });

  it("falls back to a bounded backoff when the exhaustion attempt itself fails", async () => {
    const exhaustedClaim: PartnerDispatchClaimRow = { ...CLAIM, attemptCount: 6 };
    const harness = makeHarness({
      abandonError: new Error("abandon_failed"),
      claims: [exhaustedClaim],
      prepareResult: new Error("workspace_lease_conflict"),
    });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    expect(harness.released).toEqual(["outbox_1"]);
    expect(harness.diagnosticEvents.map((entry) => entry.event)).toContain("joi.agent.prepare_failed");
    expect(harness.diagnosticEvents.map((entry) => entry.event)).not.toContain("joi.agent.prepare_exhausted");
  });

  it("keeps retrying a failing preparation while the attempt budget remains", async () => {
    const harness = makeHarness({
      claims: [{ ...CLAIM, attemptCount: 3 }],
      prepareResult: new Error("workspace_lease_conflict"),
    });
    await harness.component.update(ctxAt(0));
    expect(harness.abandoned).toEqual([]);
    expect(harness.released).toEqual(["outbox_1"]);
  });

  it("AC-52: keeps a progressing run alive beyond 32 minutes, then bounds a stalled run", async () => {
    let now = new Date(BASE);
    const harness = makeHarness({ claims: [CLAIM], runOverride: () => new Promise(() => undefined) });
    const tick = async (minutes: number) => {
      now = new Date(Date.parse(BASE) + minutes * 60_000);
      await harness.component.update({ clock: { now: () => now }, now, tickId: 1 });
    };
    await tick(0);
    for (const minute of [15, 30, 45, 60]) {
      now = new Date(Date.parse(BASE) + minute * 60_000);
      harness.progressCallbacks[0]?.();
      await tick(minute);
      expect(harness.runSignals[0]?.aborted).toBe(false);
      expect(harness.completed).toEqual([]);
    }
    await tick(93);
    expect(harness.runSignals[0]?.aborted).toBe(true);
    expect(harness.completionOutputs[0]).toMatchObject({ status: "UNKNOWN", failure: { retryable: false } });
  });

  it("aborts and converges a hung run once the watchdog passes its limit", async () => {
    const harness = makeHarness({
      claims: [CLAIM],
      runOverride: () => new Promise<DispatchRunOutput>(() => undefined),
      watchdogMillis: 60_000,
    });
    await harness.component.update(ctxWithDiagnostics(0, harness.diagnosticEvents));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.runSignals[0]?.aborted).toBe(false);

    // Inside the watchdog window nothing happens.
    await harness.component.update(ctxWithDiagnostics(59_000, harness.diagnosticEvents));
    expect(harness.diagnosticEvents.map((entry) => entry.event)).not.toContain("joi.agent.watchdog_abort");

    // Past it the run is aborted and converged as a non-replayable UNKNOWN.
    await harness.component.update(ctxWithDiagnostics(61_000, harness.diagnosticEvents));
    expect(harness.diagnosticEvents.map((entry) => entry.event)).toContain("joi.agent.watchdog_abort");
    expect(harness.runSignals[0]?.aborted).toBe(true);
    await harness.component.update(ctxWithDiagnostics(62_000, harness.diagnosticEvents));
    expect(harness.completed).toEqual(["attempt_1"]);
    expect(harness.completionOutputs[0]).toMatchObject({
      failure: { phase: "EXECUTION", reasonCode: "dispatch_watchdog_timed_out", retryable: false, sideEffectState: "UNKNOWN" },
      kind: "terminal",
      status: "UNKNOWN",
    });
  });
});
