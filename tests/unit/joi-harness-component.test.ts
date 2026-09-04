/* eslint-disable @typescript-eslint/require-await */
import { JoiHarnessComponent } from "../../src/main/application/actors/components/joi-harness-component";
import type { ActorTickContext } from "../../src/main/application/ports/actor-runtime";
import type {
  HarnessFeedbackTarget,
  HarnessGoalSeed,
  HarnessReviewDigest,
  HarnessReviewRecoveryCandidate,
  HarnessWorkRecoverySeed,
} from "../../src/main/application/ports/joi-harness";

const BASE = "2026-08-05T10:00:00.000Z";

function ctxAt(offsetMillis: number): ActorTickContext {
  const now = new Date(new Date(BASE).getTime() + offsetMillis);
  return { clock: { now: () => now }, now, tickId: 1 };
}

interface Diagnostics {
  events: { name: string; payload: Record<string, unknown> }[];
}

function makeHarness(options?: { reconcileReturnsNull?: boolean; reviewEnabled?: boolean; scanEveryMillis?: number }) {
  const diagnostics: Diagnostics = { events: [] };
  const seeds: HarnessGoalSeed[] = [];
  const feedbackTargets: HarnessFeedbackTarget[] = [];
  const trivialCandidates: { goalInputId: string }[] = [];
  const reviewDigests: HarnessReviewDigest[] = [];
  const reviewRecoveries: HarnessReviewRecoveryCandidate[] = [];
  const workRecoverySeeds: HarnessWorkRecoverySeed[] = [];
  const createdMaps: string[] = [];
  const feedbackEntries: { entry: string; goalInputId: string }[] = [];
  const clearedTrivial: string[] = [];
  const enqueuedReviews: string[] = [];
  const enqueuedWorkRecoveries: string[] = [];
  let pathSync = { closed: 0, created: 0 };
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
    listReviewRecoveries: async () => [...reviewRecoveries],
    listWorkRecoverySeeds: async () => [...workRecoverySeeds],
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
    enqueueWorkRecovery: async (input: { seed: HarnessWorkRecoverySeed }) => {
      enqueuedWorkRecoveries.push(input.seed.sourceWorkId);
      const index = workRecoverySeeds.indexOf(input.seed);
      if (index >= 0) workRecoverySeeds.splice(index, 1);
      return `joi_recovery:goal:${input.seed.goalInputId}:work:${input.seed.sourceWorkId}:a${String(input.seed.attemptNo)}`;
    },
    reconcileReview: async (input: { candidate: HarnessReviewRecoveryCandidate }) => {
      if (options?.reconcileReturnsNull === true) return null;
      const index = reviewRecoveries.indexOf(input.candidate);
      if (index >= 0) reviewRecoveries.splice(index, 1);
      return input.candidate.action === "AUTO_CLEAR"
        ? { action: "AUTO_CLEARED" as const }
        : input.candidate.action === "REQUEUE"
        ? { action: "REQUEUED" as const, inputId: `joi_harness_review:goal:${input.candidate.digest.goalInputId}:r${String(input.candidate.digest.resultRevision)}` }
        : { action: "QUARANTINED" as const };
    },
    recordCompletionFeedback: async (input: { entry: string; goalInputId: string }) => {
      feedbackEntries.push({ entry: input.entry, goalInputId: input.goalInputId });
      return true;
    },
    synchronizeWorkPaths: async () => pathSync,
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
    enqueuedWorkRecoveries,
    feedbackEntries,
    feedbackTargets,
    reviewDigests,
    reviewRecoveries,
    workRecoverySeeds,
    setPathSync: (value: { closed: number; created: number }) => { pathSync = value; },
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

  it("records user-accepted gaps without claiming the destination was attained", async () => {
    const harness = makeHarness();
    harness.feedbackTargets.push({
      acceptedWithGaps: true,
      workbenchId: "workbench-1",
      completionSummary: "横评已形成，但近七天来源不足。",
      destination: "完成资讯横评",
      goalInputId: "goal-gaps",
    });
    await harness.component.update(ctxAt(0));
    expect(harness.feedbackEntries[0]?.entry)
      .toBe("[2026-08-05] 「完成资讯横评」接受当前结果（有缺口）：横评已形成，但近七天来源不足。");
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

  it("enqueues a bounded Work recovery and emits only stable identifiers", async () => {
    const harness = makeHarness();
    harness.workRecoverySeeds.push({
      attemptNo: 1, goalInputId: "goal-blocked", sourceWorkId: "work-failed", workbenchId: "workbench-1",
    });
    const ctx = ctxAt(0);
    await harness.component.update({ ...ctx, diagnostics: { emit: (name, payload) => harness.diagnostics.events.push({ name, payload }) } });
    expect(harness.enqueuedWorkRecoveries).toEqual(["work-failed"]);
    expect(harness.diagnostics.events).toContainEqual({
      name: "joi.harness.work_recovery_enqueued",
      payload: {
        attemptNo: 1,
        goalInputId: "goal-blocked",
        inputId: "joi_recovery:goal:goal-blocked:work:work-failed:a1",
        sourceWorkId: "work-failed",
      },
    });
  });

  it("skips Work recovery when only the scan side of the optional port is wired", async () => {
    const scanOnly = new JoiHarnessComponent({
      scan: {
        listFeedbackTargets: async () => [],
        listGoalsWithoutMap: async () => [],
        listReviewDigests: async () => [],
        listReviewRecoveries: async () => [],
        listTrivialMapCandidates: async () => [],
        listWorkRecoverySeeds: async () => [{
          attemptNo: 1, goalInputId: "goal", sourceWorkId: "work", workbenchId: "workbench-1",
        }],
        loadGoalProjections: async () => [],
      },
      writer: {
        clearTrivialMap: async () => false,
        createMap: async () => false,
        enqueueReview: async () => null,
        reconcileReview: async () => null,
        recordCompletionFeedback: async () => false,
        synchronizeWorkPaths: async () => ({ closed: 0, created: 0 }),
      },
    });
    await expect(scanOnly.update(ctxAt(0))).resolves.toBeUndefined();
  });

  it("reconciles stale reviews once and keeps bounded diagnostics", async () => {
    const harness = makeHarness({ reviewEnabled: true });
    harness.reviewRecoveries.push({ action: "REQUEUE", digest: digest("goal-recover"), reasonCode: "review_turn_failed_without_side_effect" });
    const ctx = ctxAt(0);
    await harness.component.update({ ...ctx, diagnostics: { emit: (name, payload) => harness.diagnostics.events.push({ name, payload }) } });
    expect(harness.reviewRecoveries).toEqual([]);
    expect(harness.diagnostics.events).toContainEqual({
      name: "joi.harness.review_requeued",
      payload: {
        goalInputId: "goal-recover",
        inputId: "joi_harness_review:goal:goal-recover:r1",
        reasonCode: "review_turn_failed_without_side_effect",
        resultRevision: 1,
      },
    });
  });

  it("quarantines unsafe stale reviews without exposing an input id", async () => {
    const harness = makeHarness({ reviewEnabled: true });
    harness.reviewRecoveries.push({ action: "QUARANTINE", digest: digest("goal-unsafe"), reasonCode: "review_side_effect_unknown" });
    const ctx = ctxAt(0);
    await harness.component.update({ ...ctx, diagnostics: { emit: (name, payload) => harness.diagnostics.events.push({ name, payload }) } });
    expect(harness.diagnostics.events).toContainEqual({
      name: "joi.harness.review_quarantined",
      payload: { goalInputId: "goal-unsafe", reasonCode: "review_side_effect_unknown", resultRevision: 1 },
    });
  });

  it("emits an automatic convergence diagnostic for completed historical facts", async () => {
    const harness = makeHarness({ reviewEnabled: true });
    harness.reviewRecoveries.push({ action: "AUTO_CLEAR", digest: digest("goal-auto-clear"), reasonCode: "review_facts_complete" });
    const ctx = ctxAt(0);
    await harness.component.update({ ...ctx, diagnostics: { emit: (name, payload) => harness.diagnostics.events.push({ name, payload }) } });
    expect(harness.diagnostics.events).toContainEqual({
      name: "joi.harness.review_auto_cleared",
      payload: { goalInputId: "goal-auto-clear", reasonCode: "review_facts_complete", resultRevision: 1 },
    });
  });

  it("ignores a recovery that loses its transaction race", async () => {
    const harness = makeHarness({ reconcileReturnsNull: true, reviewEnabled: true });
    harness.reviewRecoveries.push({ action: "REQUEUE", digest: digest("goal-race"), reasonCode: "review_turn_failed_without_side_effect" });
    const ctx = ctxAt(0);
    await harness.component.update({ ...ctx, diagnostics: { emit: (name, payload) => harness.diagnostics.events.push({ name, payload }) } });
    expect(harness.diagnostics.events).toEqual([]);
  });

  it("reports deterministic Work-path synchronization", async () => {
    const harness = makeHarness();
    harness.setPathSync({ closed: 2, created: 3 });
    const ctx = ctxAt(0);
    await harness.component.update({ ...ctx, diagnostics: { emit: (name, payload) => harness.diagnostics.events.push({ name, payload }) } });
    expect(harness.diagnostics.events).toContainEqual({
      name: "joi.harness.paths_synchronized", payload: { closed: 2, created: 3 },
    });
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
        listReviewRecoveries: async () => [],
        listTrivialMapCandidates: async () => [],
        loadGoalProjections: async () => [],
      },
      writer: {
        clearTrivialMap: async () => false,
        createMap: async () => false,
        enqueueReview: async () => null,
        reconcileReview: async () => null,
        recordCompletionFeedback: async () => false,
        synchronizeWorkPaths: async () => ({ closed: 0, created: 0 }),
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
        listReviewRecoveries: async () => [],
        listTrivialMapCandidates: async () => [{ goalInputId: "goal-duplicate" }],
        loadGoalProjections: async () => [],
      },
      writer: {
        clearTrivialMap: async () => false,
        createMap: async () => false,
        enqueueReview: async () => null,
        reconcileReview: async () => null,
        recordCompletionFeedback: async () => false,
        synchronizeWorkPaths: async () => ({ closed: 0, created: 0 }),
      },
    });
    const ctx = ctxAt(0);

    await component.update({ ...ctx, diagnostics: { emit: (name, payload) => diagnostics.events.push({ name, payload }) } });

    expect(diagnostics.events).toEqual([]);
  });
});
