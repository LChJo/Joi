/**
 * Persistent goal map (wayfinder harness): destination / paths / decisions / fog.
 * The map is an index over execution facts, never a second execution model —
 * work_items and dispatch_attempts remain the execution truth, paths only
 * reference work_id. Progression is delegated to joi reasoning turns through
 * PENDING rows in joi_inbox_messages; the harness never reasons or dispatches.
 */

export type HarnessDecisionKind = "APPROACH" | "WORKBENCH_REFINE" | "OUT_OF_SCOPE" | "SCOPE";
export type HarnessMapStatus = "ACTIVE" | "CLEARED";
export type HarnessPathStatus = "CLOSED" | "OPEN" | "OUT_OF_SCOPE";

export interface HarnessGoalSeed {
  workbenchId: string;
  goalInputId: string;
}

/** One persisted work result of the revision under review, bounded by the scan. */
export interface HarnessReviewResultRef {
  resultId: string;
  workId: string;
  title: string;
  status: string;
  verification: string;
  summary: string;
}

/** Bounded digest handed to a harness review turn (limits enforced by the scan). */
export interface HarnessReviewDigest {
  recoveryEpoch?: string;
  continuationRequested?: true;
  workbenchId: string;
  completionSummary: string;
  decisionCount: number;
  decisions: { kind: HarnessDecisionKind; summary: string }[];
  destination: string | null;
  fogNotes: string[];
  goalInputId: string;
  openPaths: { layer: number; pathId: string; title: string }[];
  resultRevision: number;
  results: HarnessReviewResultRef[];
}

export type HarnessReviewRecoveryAction = "AUTO_CLEAR" | "REQUEUE" | "QUARANTINE";

/** A bounded historical review candidate for deterministic recovery. */
export interface HarnessReviewRecoveryCandidate {
  action: HarnessReviewRecoveryAction;
  digest: HarnessReviewDigest;
  reasonCode: string;
}

export interface HarnessReviewRecoveryResult {
  action: "AUTO_CLEARED" | "REQUEUED" | "QUARANTINED";
  inputId?: string;
}

export interface HarnessFeedbackTarget {
  acceptedWithGaps?: true;
  workbenchId: string;
  completionSummary: string;
  destination: string | null;
  goalInputId: string;
}

export interface HarnessWorkRecoverySeed {
  attemptNo: number;
  goalInputId: string;
  sourceWorkId: string;
  workbenchId: string;
}

export interface HarnessContinuationDecisionSeed {
  goalInputId: string;
  resultRevision: number;
  workbenchId: string;
}

/** Bounded per-goal projection for the home feed goal card. */
export interface HarnessGoalProjection {
  currentLayer: number;
  decisionCount: number;
  destination: string | null;
  fogCount: number;
  goalInputId: string;
  mapStatus: HarnessMapStatus;
  openPathCount: number;
  reviewedRevision: number;
  revision: number;
  topFogNote: string | null;
  topPaths: { pathId: string; status: HarnessPathStatus; title: string }[];
}

/** Read-only traversal surface. Queries are transaction-wrapped, bounded, and stably ordered. */
/**
 * A goal whose Work is all terminal, whose result set moved on without a synthesis, and whose
 * synthesis input is already consumed: nothing else in the system will pick it up, so it sits in
 * "finalizing" forever. Detected and re-driven so that state cannot outlive the evidence that
 * explains it — every earlier one of these was only ever found by hand.
 */
export interface HarnessStalledSynthesisSeed {
  goalInputId: string;
  resultRevision: number;
}

/**
 * A goal whose map was closed while a newer evidence layer was still in flight. A Work reaches
 * its terminal state a few milliseconds before its result joins the goal's result set, and the
 * close-out reads the second fact through the first: in that window every "facts complete"
 * predicate holds while a result is still on its way. The map is then CLEARED, and the synthesis
 * that lands immediately after can only publish a revision the map has already outrun. Both
 * surfaces that could arrange that layer (review and continuation) require an ACTIVE map, so the
 * goal idles behind a "reviewing" badge forever. Re-opened so the ordinary review path adopts it.
 */
export interface HarnessUnreviewedMapSeed {
  goalInputId: string;
  resultRevision: number;
  workbenchId: string;
}

/**
 * A goal the review has finished, whose route map still has paths left open.
 *
 * `REVIEW_FACTS_COMPLETE_SQL` requires every path closed before a map may clear, and only a review
 * turn can close one — but a review is queued when a new revision arrives, and `enqueueReview`
 * advances `reviewed_revision` as it queues. So a review that finishes while a route it superseded
 * is still open has no successor: the path stays OPEN, "facts complete" never holds, and the goal
 * idles behind a "reviewing" badge with nothing left for any scan to do. A route still open at
 * this point is a plan the work moved past rather than work outstanding — nothing is running, and
 * the goal's own outcome already says COMPLETED.
 */
export interface HarnessFinishedGoalSeed {
  goalInputId: string;
  openPaths: number;
  workbenchId: string;
}

export interface JoiHarnessScan {
  listFeedbackTargets(): Promise<HarnessFeedbackTarget[]>;
  listGoalsWithoutMap(): Promise<HarnessGoalSeed[]>;
  listReviewDigests(): Promise<HarnessReviewDigest[]>;
  listReviewRecoveries(): Promise<HarnessReviewRecoveryCandidate[]>;
  listTrivialMapCandidates(): Promise<{ goalInputId: string }[]>;
  loadGoalProjections(): Promise<HarnessGoalProjection[]>;
  listWorkRecoverySeeds?(): Promise<HarnessWorkRecoverySeed[]>;
  listContinuationDecisionSeeds?(): Promise<HarnessContinuationDecisionSeed[]>;
  listStalledSyntheses?(input: { now: string; cooldownMillis: number }): Promise<HarnessStalledSynthesisSeed[]>;
  listUnreviewedClearedMaps?(): Promise<HarnessUnreviewedMapSeed[]>;
  listFinishedGoalsWithOpenPaths?(): Promise<HarnessFinishedGoalSeed[]>;
}

/** Deterministic write surface used by the traversal. Never reasons and never dispatches. */
export interface JoiHarnessWriter {
  clearTrivialMap(input: { goalInputId: string; now: string }): Promise<boolean>;
  createMap(input: { workbenchId: string; goalInputId: string; now: string }): Promise<boolean>;
  enqueueReview(input: { digest: HarnessReviewDigest; now: string }): Promise<string | null>;
  reconcileReview(input: { candidate: HarnessReviewRecoveryCandidate; now: string }): Promise<HarnessReviewRecoveryResult | null>;
  recordCompletionFeedback(input: { workbenchId: string; entry: string; goalInputId: string; now: string }): Promise<boolean>;
  synchronizeWorkPaths(input: { now: string }): Promise<{ closed: number; created: number }>;
  enqueueWorkRecovery?(input: { now: string; seed: HarnessWorkRecoverySeed }): Promise<string | null>;
  requestContinuationDecision?(input: { now: string; seed: HarnessContinuationDecisionSeed }): Promise<boolean>;
  redriveSynthesis?(input: { now: string; seed: HarnessStalledSynthesisSeed }): Promise<boolean>;
  reopenUnreviewedMap?(input: { now: string; seed: HarnessUnreviewedMapSeed }): Promise<boolean>;
  closeFinishedGoalPaths?(input: { now: string; seed: HarnessFinishedGoalSeed }): Promise<number>;
}

/** Reasoning-side write surface injected into the harness tools; always goal-scoped. */
export interface JoiHarnessStore {
  chartPath(input: {
    close?: { pathId: string; status: "CLOSED" | "OUT_OF_SCOPE" };
    goalInputId: string;
    open?: { layer: number; title: string; workId?: string };
    turnId: string;
  }): Promise<{ pathId: string; status: HarnessPathStatus }>;
  clearMap(input: { goalInputId: string; turnId: string }): Promise<boolean>;
  graduateFog(input: {
    fogId: string;
    goalInputId: string;
    layer: number;
    title: string;
    turnId: string;
    workId?: string;
  }): Promise<{ fogId: string; pathId: string }>;
  nameDestination(input: { destination: string; goalInputId: string; turnId: string }): Promise<{ destination: string; revision: number }>;
  noteFog(input: { goalInputId: string; note: string; turnId: string }): Promise<{ fogId: string }>;
  recordDecision(input: {
    closePathId?: string;
    detail?: string;
    goalInputId: string;
    kind: HarnessDecisionKind;
    summary: string;
    turnId: string;
  }): Promise<{ decisionId: string }>;
}
