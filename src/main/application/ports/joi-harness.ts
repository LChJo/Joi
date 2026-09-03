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

/** Bounded digest handed to a harness review turn (limits enforced by the scan). */
export interface HarnessReviewDigest {
  workbenchId: string;
  completionSummary: string;
  decisionCount: number;
  decisions: { kind: HarnessDecisionKind; summary: string }[];
  destination: string | null;
  fogNotes: string[];
  goalInputId: string;
  openPaths: { layer: number; pathId: string; title: string }[];
  resultRevision: number;
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
export interface JoiHarnessScan {
  listFeedbackTargets(): Promise<HarnessFeedbackTarget[]>;
  listGoalsWithoutMap(): Promise<HarnessGoalSeed[]>;
  listReviewDigests(): Promise<HarnessReviewDigest[]>;
  listReviewRecoveries(): Promise<HarnessReviewRecoveryCandidate[]>;
  listTrivialMapCandidates(): Promise<{ goalInputId: string }[]>;
  loadGoalProjections(): Promise<HarnessGoalProjection[]>;
  listWorkRecoverySeeds?(): Promise<HarnessWorkRecoverySeed[]>;
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
