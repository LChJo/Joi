/* eslint-disable @typescript-eslint/require-await */
import { JoiTaskComponent } from "../../src/main/application/actors/components/joi-task-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";
import type { JoiTaskPendingInput, JoiTaskStaleTurn } from "../../src/main/application/ports/joi-task";

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

function makeHarness(options?: { ignoreAbort?: boolean; ready?: boolean; failureCode?: string }): Harness {
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
  it.each(["joi_turn_outcome_uncommitted", "joi_model_toolcall_leak", "custom_model_tool_capability_unverified"])("stops a synthesis after bounded model repair fails with %s", async failureCode => {
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
