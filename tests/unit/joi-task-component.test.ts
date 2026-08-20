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
  parks: { failureCount: number; inputId: string; reasonCode: string }[];
  signals: Map<string, AbortSignal | undefined>;
  settle: (inputId: string, outcome?: "ok" | "fail") => void;
  state: { pending: JoiTaskPendingInput[]; stale: JoiTaskStaleTurn[] };
}

function makeHarness(options?: { ignoreAbort?: boolean; ready?: boolean }): Harness {
  const calls: string[] = [];
  const failTurns: string[] = [];
  const parks: { failureCount: number; inputId: string; reasonCode: string }[] = [];
  const signals = new Map<string, AbortSignal | undefined>();
  const resolvers = new Map<string, { reject: (error: Error) => void; resolve: () => void }>();
  const state = {
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
      park: async (inputId, failure) => {
        state.pending = state.pending.filter((pending) => pending.inputId !== inputId);
        parks.push({ inputId, ...failure });
      },
      failTurn: async (_inputId, turnId) => {
        failTurns.push(turnId);
      },
      listPendingInputs: async () => [...state.pending],
      listStaleRunningTurns: async () => [...state.stale],
    },
  });
  return {
    calls,
    component,
    failTurns,
    parks,
    signals,
    settle: (inputId, outcome = "ok") => {
      const entry = resolvers.get(inputId);
      if (entry === undefined) throw new Error(`no in-flight handle for ${inputId}`);
      if (outcome === "ok") entry.resolve();
      else entry.reject(Object.assign(new Error("safe summary"), { code: "turn_boom" }));
    },
    state,
  };
}

describe("JoiTaskComponent traversal scheduling", () => {
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
    for (let tick = 0; tick < 8; tick += 1) {
      await harness.component.update(ctxAt(tick * 2_000));
      harness.settle("input_loop", "fail");
      await flush();
    }
    expect(harness.calls.filter((entry) => entry === "input_loop")).toHaveLength(8);
    // The 8th consecutive failure converges here: park instead of retrying forever.
    await harness.component.update(ctxAt(16_000));
    expect(harness.parks).toEqual([{ failureCount: 8, inputId: "input_loop", reasonCode: "turn_boom" }]);
    await harness.component.update(ctxAt(18_000));
    expect(harness.calls.filter((entry) => entry === "input_loop")).toHaveLength(8);
  });

  it("recovers orphaned RUNNING turns and throttles the scan", async () => {
    const harness = makeHarness();
    harness.state.stale = [{ inputId: "input_old", turnId: "turn_old" }];
    await harness.component.update(ctxAt(0));
    expect(harness.failTurns).toEqual(["turn_old"]);

    await harness.component.update(ctxAt(5_000));
    expect(harness.failTurns).toEqual(["turn_old"]);

    await harness.component.update(ctxAt(31_000));
    expect(harness.failTurns).toEqual(["turn_old", "turn_old"]);
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
    await harness.component.update(ctxAt(16 * 60_000 + 1));
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
    await harness.component.update(ctxAt(18 * 60_000));
    expect(harness.calls).toEqual(["input_a", "input_a"]);
  });
});
