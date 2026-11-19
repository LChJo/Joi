/* eslint-disable @typescript-eslint/require-await */
import { JoiTaskComponent } from "../../src/main/application/actors/components/joi-task-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";
import type { JoiTaskInbox, JoiTaskPendingInput, JoiTaskStaleTurn } from "../../src/main/application/ports/joi-task";

const BASE = "2026-08-05T10:00:00.000Z";

function ctxAt(offsetMillis: number): ActorTickContext {
  const now = new Date(new Date(BASE).getTime() + offsetMillis);
  return { clock: { now: () => now }, now, tickId: 1 };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  calls: string[];
  component: JoiTaskComponent;
  failTurns: string[];
  recoverReviews: ReturnType<typeof vi.fn>;
  parks: { failureCount: number; inputId: string; reasonCode: string }[];
  signals: Map<string, AbortSignal | undefined>;
  settle: (inputId: string, outcome?: "ok" | "fail") => void;
  state: { canceled: string[]; pending: JoiTaskPendingInput[]; stale: JoiTaskStaleTurn[] };
}

function makeHarness(options?: { ignoreAbort?: boolean; ready?: boolean; failureCode?: string;
  retry?: Pick<JoiTaskInbox, "getRetryState" | "deferRetry" | "recordSchedulingFailure"> }): Harness {
  const calls: string[] = [];
  const failTurns: string[] = [];
  const recoverReviews = vi.fn(async () => undefined);
  const parks: { failureCount: number; inputId: string; reasonCode: string }[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  const resolvers = new Map<string, { reject: (error: Error) => void; resolve: () => void }>();
  const state = {
    canceled: [] as string[],
    pending: [] as JoiTaskPendingInput[],
    stale: [] as JoiTaskStaleTurn[],
  };
  const component = new JoiTaskComponent({
    driver: {
      handle: (inputId, signal) => {
        calls.push(inputId);
        signals.set(inputId, signal);
        return new Promise<void>((resolve, reject) => {
          resolvers.set(inputId, { reject, resolve });
          if (!options?.ignoreAbort) signal?.addEventListener("abort", () => reject(new Error("turn_aborted")), { once: true });
        });
      },
    },
    gate: { hasReadySource: async () => options?.ready ?? true },
    inbox: {
      ...options?.retry,
      recoverInterruptedGoalReviews: recoverReviews,
      park: async (inputId, failure) => {
        state.pending = state.pending.filter((pending) => pending.inputId !== inputId);
        parks.push({ inputId, ...failure });
      },
      failTurn: async (_inputId, turnId) => {
        failTurns.push(turnId);
      },
      listPendingInputs: async () => [...state.pending],
      listStaleRunningTurns: async () => [...state.stale],
      isCanceled: async (inputId) => state.canceled.includes(inputId),
    },
  });
  return {
    calls,
    component,
    failTurns,
    recoverReviews,
    parks,
    signals,
    settle: (inputId, outcome = "ok") => {
      const entry = resolvers.get(inputId);
      if (entry === undefined) throw new Error(`no in-flight handle for ${inputId}`);
      if (outcome === "ok") entry.resolve();
      else entry.reject(Object.assign(new Error("safe summary"), { code: options?.failureCode ?? "turn_boom" }));
    },
    state,
  };
}

describe("JoiTaskComponent traversal scheduling", () => {
  it.each(["source_auth", "source_balance", "source_configuration", "source_access", "source_safety_refusal"])("parks %s without repeating an unchanged request", async failureCode => {
    const harness = makeHarness({ failureCode });
    const inputId = "goal";
    harness.state.pending = [{ createdAt: BASE, inputId }];
    await harness.component.update(ctxAt(0)); harness.settle(inputId, "fail"); await flush();
    await harness.component.update(ctxAt(1_000)); await harness.component.update(ctxAt(3_600_000));
    expect(harness.parks).toEqual([{ failureCount: 1, inputId, reasonCode: failureCode }]);
    expect(harness.calls).toEqual([inputId]);
  });

  it.each(["joi_turn_outcome_uncommitted", "joi_model_toolcall_leak", "custom_model_tool_capability_unverified", "goal_synthesis_reference_invalid", "goal_synthesis_state_invalid", "goal_synthesis_correction_exhausted"])("stops a synthesis after bounded model repair fails with %s", async failureCode => {
    const harness = makeHarness({ failureCode });
    const inputId = "joi_result_input:goal:goal:r1:q0";
    harness.state.pending = [{ createdAt: BASE, inputId }];
    await harness.component.update(ctxAt(0));
    harness.settle(inputId, "fail");
    await flush();
    await harness.component.update(ctxAt(1_000));
    await harness.component.update(ctxAt(3_600_000));
    expect(harness.parks).toEqual([{ failureCount: 1, inputId, reasonCode: failureCode }]);
    expect(harness.calls).toEqual([inputId]);
  });
  it("keeps a single serial slot until the in-flight turn settles", async () => {
    const harness = makeHarness();
    harness.state.pending = [
      { createdAt: BASE, inputId: "input_a" },
      { createdAt: BASE, inputId: "input_b" },
    ];
    await harness.component.update(ctxAt(0));
    await harness.component.update(ctxAt(1_000));
    expect(harness.calls).toEqual(["input_a"]);

    harness.settle("input_a");
    await flush();
    harness.state.pending = [{ createdAt: BASE, inputId: "input_b" }];
    await harness.component.update(ctxAt(2_000));
    expect(harness.calls).toEqual(["input_a", "input_b"]);
  });

  it("starts up to four independent syntheses alongside ordinary scheduling", async () => {
    const harness = makeHarness();
    const syntheses = Array.from({ length: 5 }, (_, index) => ({
      createdAt: BASE, goalInputId: `goal_${String(index)}`, inputId: `synthesis_${String(index)}`, synthesis: true,
    }));
    const [first] = syntheses;
    if (first === undefined) throw new Error("Missing synthetic input");
    harness.state.pending = [
      first,
      { createdAt: BASE, inputId: "review", goalInputId: first.goalInputId },
      { ...first, inputId: "new_synthesis" },
      { createdAt: BASE, inputId: "unrelated_input" },
      ...syntheses.slice(1),
    ];
    await harness.component.update(ctxAt(0));
    expect(harness.calls).toEqual(["synthesis_0", "unrelated_input", "synthesis_1", "synthesis_2", "synthesis_3"]);
    await harness.component.update(ctxAt(500));
    expect(harness.calls).toHaveLength(5);

    harness.settle("synthesis_1");
    await flush();
    harness.state.pending = harness.state.pending.filter(({ inputId }) => inputId !== "synthesis_1");
    await harness.component.update(ctxAt(1_000));
    expect(harness.calls.at(-1)).toBe("synthesis_4");
    expect(harness.calls).toHaveLength(6);

    harness.settle("synthesis_0");
    harness.settle("unrelated_input");
    await flush();
    harness.state.pending = harness.state.pending.filter(({ inputId }) => inputId !== "synthesis_0" && inputId !== "unrelated_input");
    await harness.component.update(ctxAt(2_000));
    expect(harness.calls.slice(6)).toEqual(["review"]);
  });

  it("defers background evolution while an independent synthesis is active", async () => {
    const harness = makeHarness();
    const background = { createdAt: BASE, inputId: "evolution:bench" };
    harness.state.pending = [{ createdAt: BASE, inputId: "synthesis", synthesis: true }, background,
      { createdAt: BASE, inputId: "foreground" }];
    await harness.component.update(ctxAt(0));
    expect(harness.calls).toEqual(["synthesis", "foreground"]);
    harness.settle("foreground");
    await flush();
    harness.state.pending = [background];
    await harness.component.update(ctxAt(1_000));
    expect(harness.calls).toHaveLength(2);
    harness.settle("synthesis");
    await flush();
    await harness.component.update(ctxAt(2_000));
    expect(harness.calls).toEqual(["synthesis", "foreground", background.inputId]);
  });

  it("honors a rejected persisted retry and parks rows that already exhausted their budget", async () => {
    const deferRetry = vi.fn<NonNullable<JoiTaskInbox["deferRetry"]>>().mockResolvedValue(false);
    const harness = makeHarness({ retry: { deferRetry } });
    harness.state.pending = [
      { createdAt: BASE, inputId: "exhausted", retryState: { failureCount: 8, epoch: 1, sessionGeneration: 1 } },
      { createdAt: BASE, inputId: "stale", retryState: { failedAt: BASE, failureCount: 1, epoch: 1, sessionGeneration: 1 } },
      { createdAt: BASE, inputId: "ready", retryState: { failureCount: 0, epoch: 2, sessionGeneration: 2 } },
    ];
    await harness.component.update(ctxAt(5_000));
    expect(harness.parks).toEqual([{ inputId: "exhausted", failureCount: 8, reasonCode: "joi_task_turn_failed" }]);
    expect(deferRetry).toHaveBeenCalledExactlyOnceWith("stale", { epoch: 1, failureCount: 1, retryAt: "2026-08-05T10:00:30.000Z" });
    expect(harness.calls).toEqual(["ready"]);
  });

  it("does not impose an in-memory backoff when persistence rejects an old attempt", async () => {
    const failed = { failedAt: BASE, failureCount: 1, epoch: 1, sessionGeneration: 1 };
    const getRetryState = vi.fn<NonNullable<JoiTaskInbox["getRetryState"]>>().mockResolvedValue(failed);
    const deferRetry = vi.fn<NonNullable<JoiTaskInbox["deferRetry"]>>().mockResolvedValue(false);
    const recordSchedulingFailure = vi.fn<NonNullable<JoiTaskInbox["recordSchedulingFailure"]>>().mockResolvedValue(undefined);
    const harness = makeHarness({ retry: { getRetryState, deferRetry, recordSchedulingFailure } });
    const original = { createdAt: BASE, inputId: "retry", retryState: { failureCount: 0, epoch: 1, sessionGeneration: 1 } };
    harness.state.pending = [original];
    await harness.component.update(ctxAt(0));
    harness.settle("retry", "fail");
    await flush();
    harness.state.pending = [{ ...original, retryState: { failureCount: 1, epoch: 2, sessionGeneration: 2 } }];
    await harness.component.update(ctxAt(5_000));
    expect(recordSchedulingFailure).toHaveBeenCalledExactlyOnceWith("retry", expect.objectContaining({ epoch: 1, reasonCode: "turn_boom" }));
    expect(deferRetry).toHaveBeenCalledExactlyOnceWith("retry", { epoch: 1, failureCount: 1, retryAt: "2026-08-05T10:00:30.000Z" });
    expect(harness.calls).toEqual(["retry", "retry"]);
  });

  it("retains a canceled synthesis reservation until it settles and recovers only orphaned turns", async () => {
    const harness = makeHarness({ ignoreAbort: true });
    const original = { createdAt: BASE, goalInputId: "goal", inputId: "synthesis", synthesis: true };
    harness.state.pending = [original, { ...original, goalInputId: "other", inputId: "other_synthesis" }];
    await harness.component.update(ctxAt(0));
    harness.state.canceled = ["synthesis"];
    harness.state.pending = [{ ...original, inputId: "replacement" }];
    harness.state.stale = [{ inputId: "synthesis", turnId: "active" }, { inputId: "orphan", turnId: "stale" }];
    await harness.component.update(ctxAt(31_000));
    expect(harness.signals.get("synthesis")?.aborted).toBe(true);
    expect(harness.signals.get("other_synthesis")?.aborted).toBe(false);
    expect(harness.failTurns).toEqual(["stale"]);
    expect(harness.calls).toEqual(["synthesis", "other_synthesis"]);

    harness.settle("synthesis");
    await flush();
    await harness.component.update(ctxAt(32_000));
    expect(harness.calls.at(-1)).toBe("replacement");
    expect(harness.parks).toEqual([]);
  });

  it("does not start work while no model source is READY", async () => {
    const harness = makeHarness({ ready: false });
    harness.state.pending = [{ createdAt: BASE, inputId: "input_a" }];
    await harness.component.update(ctxAt(0));
    await flush();
    expect(harness.calls).toEqual([]);
  });

  it("applies a resolved user action even while no model source is READY", async () => {
    const harness = makeHarness({ ready: false });
    harness.state.pending = [{ createdAt: BASE, inputId: "input_action", requiresModelSource: false }];
    await harness.component.update(ctxAt(0));
    await flush();
    expect(harness.calls).toEqual(["input_action"]);
  });

  it("converges a failed turn and picks the next pending input", async () => {
    const harness = makeHarness();
    harness.state.pending = [{ createdAt: BASE, inputId: "input_a" }];
    await harness.component.update(ctxAt(0));
    harness.settle("input_a", "fail");
    await flush();

    harness.state.pending = [{ createdAt: BASE, inputId: "input_b" }];
    await harness.component.update(ctxAt(1_000));
    expect(harness.calls).toEqual(["input_a", "input_b"]);
  });

  it("parks a crash-looping input after the consecutive-failure cap", async () => {
    const harness = makeHarness();
    harness.state.pending = [{ createdAt: BASE, inputId: "input_loop" }];
    // Each failure backs the next attempt off exponentially (30s doubling to a 10min cap):
    // one tick records the failure and starts the cooldown, the next starts past it.
    const settleDelay = 1_000;
    const backoffAfterFailure = [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000];
    let at = 0;
    for (const backoff of backoffAfterFailure) {
      await harness.component.update(ctxAt(at));
      harness.settle("input_loop", "fail");
      await flush();
      await harness.component.update(ctxAt(at + settleDelay));
      at += settleDelay + backoff;
    }
    await harness.component.update(ctxAt(at));
    harness.settle("input_loop", "fail");
    await flush();
    // The 8th consecutive failure converges here: park instead of retrying forever.
    await harness.component.update(ctxAt(at + settleDelay));
    expect(harness.calls.filter((entry) => entry === "input_loop")).toHaveLength(8);
    expect(harness.parks).toEqual([{ failureCount: 8, inputId: "input_loop", reasonCode: "turn_boom" }]);
    await harness.component.update(ctxAt(at + settleDelay + 2_000));
    expect(harness.calls.filter((entry) => entry === "input_loop")).toHaveLength(8);
  });

  it("backs a failed input off without blocking later pending inputs", async () => {
    const harness = makeHarness();
    harness.state.pending = [
      { createdAt: BASE, inputId: "input_slow" },
      { createdAt: BASE, inputId: "input_next" },
    ];
    await harness.component.update(ctxAt(0));
    harness.settle("input_slow", "fail");
    await flush();

    // The failed input is still cooling down, so the next claimable input starts instead.
    await harness.component.update(ctxAt(1_000));
    expect(harness.calls).toEqual(["input_slow", "input_next"]);

    harness.settle("input_next");
    await flush();
    await harness.component.update(ctxAt(31_000));
    expect(harness.calls).toEqual(["input_slow", "input_next", "input_slow"]);
  });

  it("drops a cooldown once the row leaves the queue, so a user retry starts at once", async () => {
    const harness = makeHarness();
    harness.state.pending = [{ createdAt: BASE, inputId: "input_retried" }];
    await harness.component.update(ctxAt(0));
    harness.settle("input_retried", "fail");
    await flush();

    // Still queued, so the cooldown holds it back: this is the scheduler throttling itself.
    await harness.component.update(ctxAt(1_000));
    expect(harness.calls).toEqual(["input_retried"]);

    // A failure that consumed the row (a side effect had started), a cancel, or a gate takes it
    // out of the queue. There is nothing left to throttle, so the window must not outlive it.
    harness.state.pending = [];
    await harness.component.update(ctxAt(2_000));

    // The user's retry re-queues the row; it must start now rather than wait out the stale window.
    harness.state.pending = [{ createdAt: BASE, inputId: "input_retried" }];
    await harness.component.update(ctxAt(3_000));
    expect(harness.calls).toEqual(["input_retried", "input_retried"]);
  });

  it("recovers orphaned RUNNING turns and throttles the scan", async () => {
    const harness = makeHarness();
    harness.state.stale = [{ inputId: "input_old", turnId: "turn_old" }];
    await harness.component.update(ctxAt(0));
    expect(harness.failTurns).toEqual(["turn_old"]);
    expect(harness.recoverReviews).toHaveBeenCalledTimes(1);

    await harness.component.update(ctxAt(5_000));
    expect(harness.failTurns).toEqual(["turn_old"]);

    await harness.component.update(ctxAt(31_000));
    expect(harness.failTurns).toEqual(["turn_old", "turn_old"]);
    expect(harness.recoverReviews).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing review-recovery scan from the traversal loop", async () => {
    const harness = makeHarness();
    harness.recoverReviews.mockRejectedValueOnce(Object.assign(new Error("database is locked"), { code: "sqlite_busy" }));
    harness.state.stale = [{ inputId: "input_old", turnId: "turn_old" }];
    await expect(harness.component.update(ctxAt(0))).resolves.toBeUndefined();
    expect(harness.failTurns).toEqual(["turn_old"]);
    expect(harness.recoverReviews).toHaveBeenCalledTimes(1);
    // The next scheduled scan retries and succeeds.
    await harness.component.update(ctxAt(31_000));
    expect(harness.recoverReviews).toHaveBeenCalledTimes(2);
  });

  it("honors explicit timing options over the defaults", async () => {
    const scans: string[] = [];
    const component = new JoiTaskComponent({
      driver: { handle: async () => undefined },
      gate: { hasReadySource: async () => true },
      inbox: {
        park: async () => undefined,
        failTurn: async (_inputId, turnId) => {
          scans.push(turnId);
        },
        listPendingInputs: async () => [],
        listStaleRunningTurns: async (olderThan) => {
          scans.push(`scan@${olderThan}`);
          return [];
        },
        isCanceled: async () => false,
      },
      orphanScanEveryMillis: 5_000,
      staleTurnOlderThanMillis: 60_000,
      stalledTurnAfterMillis: 60_000,
    });
    await component.update(ctxAt(0));
    await component.update(ctxAt(6_000));
    expect(scans.filter((entry) => entry.startsWith("scan@")).length).toBe(2);
    expect(scans[0]).toBe(`scan@${new Date(new Date(BASE).getTime() - 60_000).toISOString()}`);
  });

  it("cancels a stalled slot before a re-pended input can resume", async () => {
    const harness = makeHarness();
    harness.state.pending = [{ createdAt: BASE, inputId: "input_a" }];
    await harness.component.update(ctxAt(0));
    expect(harness.calls).toEqual(["input_a"]);

    await harness.component.update(ctxAt(16 * 60_000));
    expect(harness.calls).toEqual(["input_a"]);
    expect(harness.signals.get("input_a")?.aborted).toBe(true);

    await flush();
    harness.state.pending = [{ createdAt: BASE, inputId: "input_a" }];
    await harness.component.update(ctxAt(16 * 60_000 + 1_000));
    await harness.component.update(ctxAt(16 * 60_000 + 31_000));
    expect(harness.calls).toEqual(["input_a", "input_a"]);
  });

  it("does not repeat cancellation or start a retry while the provider promise is still pending", async () => {
    const harness = makeHarness({ ignoreAbort: true });
    harness.state.pending = [{ createdAt: BASE, inputId: "input_a" }];
    await harness.component.update(ctxAt(0));
    await harness.component.update(ctxAt(16 * 60_000));
    await harness.component.update(ctxAt(17 * 60_000));
    expect(harness.calls).toEqual(["input_a"]);
    expect(harness.signals.get("input_a")?.aborted).toBe(true);

    harness.settle("input_a");
    await flush();
    await harness.component.update(ctxAt(18 * 60_000 + 1_000));
    await harness.component.update(ctxAt(18 * 60_000 + 31_000));
    expect(harness.calls).toEqual(["input_a", "input_a"]);
  });

  it("aborts the in-flight turn once the goal is canceled and never parks it as a failure", async () => {
    const harness = makeHarness();
    harness.state.pending = [{ createdAt: BASE, inputId: "input_a" }];
    await harness.component.update(ctxAt(0));
    expect(harness.calls).toEqual(["input_a"]);
    expect(harness.signals.get("input_a")?.aborted).toBe(false);

    harness.state.canceled = ["input_a"];
    await harness.component.update(ctxAt(1_000));
    expect(harness.signals.get("input_a")?.aborted).toBe(true);
    // The serial slot stays occupied until the aborted driver promise settles.
    expect(harness.calls).toEqual(["input_a"]);

    await flush();
    harness.state.pending = [{ createdAt: BASE, inputId: "input_b" }];
    await harness.component.update(ctxAt(2_000));
    expect(harness.calls).toEqual(["input_a", "input_b"]);
    expect(harness.parks).toEqual([]);
  });
});
