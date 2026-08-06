/* eslint-disable @typescript-eslint/require-await */
import { JoiHarnessComponent } from "../../src/main/application/actors/components/joi-harness-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";
import type {
  HarnessFeedbackTarget,
  HarnessGoalSeed,
  HarnessReviewDigest,
} from "../../src/main/application/ports/joi-harness";

const BASE = "2026-08-05T10:00:00.000Z";

function ctxAt(offsetMillis: number): ActorTickContext {
  const now = new Date(new Date(BASE).getTime() + offsetMillis);
  return { clock: { now: () => now }, now, tickId: 1 };
}

interface Diagnostics {
  events: { name: string; payload: Record<string, unknown> }[];
}

function makeHarness(options?: { reviewEnabled?: boolean; scanEveryMillis?: number }) {
  const diagnostics: Diagnostics = { events: [] };
  const seeds: HarnessGoalSeed[] = [];
  const feedbackTargets: HarnessFeedbackTarget[] = [];
  const trivialCandidates: { goalInputId: string }[] = [];
  const reviewDigests: HarnessReviewDigest[] = [];
  const createdMaps: string[] = [];
  const feedbackEntries: { entry: string; goalInputId: string }[] = [];
  const clearedTrivial: string[] = [];
  const enqueuedReviews: string[] = [];
  let failStep: string | null = null;
  const scan = {
    listFeedbackTargets: async () => [...feedbackTargets],
    listGoalsWithoutMap: async () => {
      if (failStep === "adopt") throw new Error("adopt_boom");
      return [...seeds];
    },
    listReviewDigests: async () => {
      if (failStep === "review") throw new Error("review_boom");
      return [...reviewDigests];
    },
    listTrivialMapCandidates: async () => [...trivialCandidates],
    loadGoalProjections: async () => [],
  };
  const writer = {
    clearTrivialMap: async (input: { goalInputId: string }) => {
      clearedTrivial.push(input.goalInputId);
      return true;
    },
    createMap: async (input: { goalInputId: string }) => {
      createdMaps.push(input.goalInputId);
      // Mirror the real scan: an adopted goal no longer shows up as mapless.
      const index = seeds.findIndex((seed) => seed.goalInputId === input.goalInputId);
      if (index >= 0) seeds.splice(index, 1);
      return true;
    },
    enqueueReview: async (input: { digest: HarnessReviewDigest }) => {
      enqueuedReviews.push(input.digest.goalInputId);
      return `joi_harness_review:goal:${input.digest.goalInputId}:r${String(input.digest.resultRevision)}`;
    },
    recordCompletionFeedback: async (input: { entry: string; goalInputId: string }) => {
      feedbackEntries.push({ entry: input.entry, goalInputId: input.goalInputId });
      return true;
    },
  };
  const component = new JoiHarnessComponent({
    ...(options?.reviewEnabled === undefined ? {} : { reviewEnabled: options.reviewEnabled }),
    scan,
    ...(options?.scanEveryMillis === undefined ? {} : { scanEveryMillis: options.scanEveryMillis }),
    writer,
  });
  return {
    clearedTrivial,
    component,
    createdMaps,
    diagnostics,
    enqueuedReviews,
    feedbackEntries,
    feedbackTargets,
    reviewDigests,
    seeds,
    setFailStep: (step: string | null) => { failStep = step; },
    trivialCandidates,
  };
}

function digest(goalInputId: string): HarnessReviewDigest {
  return {
    workbenchId: "workbench-1",
    completionSummary: "第一层完成",
    decisionCount: 1,
    decisions: [{ kind: "APPROACH", summary: "先查资料" }],
    destination: "目标",
    fogNotes: [],
    goalInputId,
    openPaths: [],
    resultRevision: 1,
  };
}

describe("JoiHarnessComponent", () => {
  it("adopts goals without maps and records feedback for cleared maps", async () => {
    const harness = makeHarness();
    harness.seeds.push({ workbenchId: "workbench-1", goalInputId: "goal-1" });
    harness.feedbackTargets.push({
      workbenchId: "workbench-1", completionSummary: "全部完成", destination: "分析股票", goalInputId: "goal-2",
    });
    await harness.component.update(ctxAt(0));
    expect(harness.createdMaps).toEqual(["goal-1"]);
    expect(harness.feedbackEntries).toEqual([
      { entry: "[2026-08-05] 「分析股票」达成：全部完成", goalInputId: "goal-2" },
    ]);
  });

  it("falls back to a generic heading when the destination was never named", async () => {
    const harness = makeHarness();
    harness.feedbackTargets.push({ workbenchId: "workbench-1", completionSummary: "", destination: null, goalInputId: "goal-3" });
    await harness.component.update(ctxAt(0));
    expect(harness.feedbackEntries[0]?.entry).toBe("[2026-08-05] 「目标」达成：目标已收尾");
  });

  it("clears trivial maps", async () => {
    const harness = makeHarness();
    harness.trivialCandidates.push({ goalInputId: "goal-4" });
    await harness.component.update(ctxAt(0));
    expect(harness.clearedTrivial).toEqual(["goal-4"]);
  });

  it("throttles scans within the interval", async () => {
    const harness = makeHarness({ scanEveryMillis: 10_000 });
    harness.seeds.push({ workbenchId: "workbench-1", goalInputId: "goal-5" });
    await harness.component.update(ctxAt(0));
    await harness.component.update(ctxAt(5_000));
    expect(harness.createdMaps).toEqual(["goal-5"]);
    harness.seeds.push({ workbenchId: "workbench-1", goalInputId: "goal-6" });
    await harness.component.update(ctxAt(11_000));
    expect(harness.createdMaps).toEqual(["goal-5", "goal-6"]);
  });

  it("does not enqueue reviews until review is enabled", async () => {
    const harness = makeHarness();
    harness.reviewDigests.push(digest("goal-7"));
    await harness.component.update(ctxAt(0));
    expect(harness.enqueuedReviews).toEqual([]);
  });

  it("enqueues reviews when review is enabled", async () => {
    const harness = makeHarness({ reviewEnabled: true });
    harness.reviewDigests.push(digest("goal-8"));
    await harness.component.update(ctxAt(0));
    expect(harness.enqueuedReviews).toEqual(["goal-8"]);
  });

  it("isolates a failing step and reports it without breaking the traversal", async () => {
    const harness = makeHarness({ reviewEnabled: true });
    harness.setFailStep("adopt");
    harness.feedbackTargets.push({
      workbenchId: "workbench-1", completionSummary: "done", destination: "D", goalInputId: "goal-9",
    });
    await expect(harness.component.update(ctxAt(0))).resolves.toBeUndefined();
    expect(harness.diagnostics.events).toEqual([]);
    expect(harness.feedbackEntries).toHaveLength(1);
  });

  it("emits scan_failed diagnostics with the failing step", async () => {
    const diagnostics: Diagnostics = { events: [] };
    const component = new JoiHarnessComponent({
      scan: {
        listFeedbackTargets: async () => [],
        listGoalsWithoutMap: async () => { throw new Error("adopt_boom"); },
        listReviewDigests: async () => [],
        listTrivialMapCandidates: async () => [],
        loadGoalProjections: async () => [],
      },
      writer: {
        clearTrivialMap: async () => false,
        createMap: async () => false,
        enqueueReview: async () => null,
        recordCompletionFeedback: async () => false,
      },
    });
    const ctx = ctxAt(0);
    await component.update({ ...ctx, diagnostics: { emit: (name, payload) => diagnostics.events.push({ name, payload }) } });
    expect(diagnostics.events).toEqual([
      { name: "joi.harness.scan_failed", payload: { errorCode: "Error", step: "adopt" } },
    ]);
  });

  it("treats duplicate writer results as idempotent no-ops", async () => {
    const diagnostics: Diagnostics = { events: [] };
    const component = new JoiHarnessComponent({
      reviewEnabled: true,
      scan: {
        listFeedbackTargets: async () => [{
          workbenchId: "workbench-1", completionSummary: "done", destination: "D", goalInputId: "goal-duplicate",
        }],
        listGoalsWithoutMap: async () => [{ workbenchId: "workbench-1", goalInputId: "goal-duplicate" }],
        listReviewDigests: async () => [digest("goal-duplicate")],
        listTrivialMapCandidates: async () => [{ goalInputId: "goal-duplicate" }],
        loadGoalProjections: async () => [],
      },
      writer: {
        clearTrivialMap: async () => false,
        createMap: async () => false,
        enqueueReview: async () => null,
        recordCompletionFeedback: async () => false,
      },
    });
    const ctx = ctxAt(0);

    await component.update({ ...ctx, diagnostics: { emit: (name, payload) => diagnostics.events.push({ name, payload }) } });

    expect(diagnostics.events).toEqual([]);
  });
});
