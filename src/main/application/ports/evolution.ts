import type { EvolutionModule, EvolutionPhase, EvolutionReason, EvolutionStrategy, EvolutionVersionDto } from "../../../shared/evolution.js";

export interface EvolutionEvidence {
  goalId: string;
  workbenchId: string;
  revisionId: string | null;
  outcome: "VERIFIED" | "VERIFICATION_FAILED" | "ACCEPTED_WITH_GAPS" | "CANCELED" | "ENVIRONMENT_FAILED" | "UNEVALUABLE";
  observedAt: string;
}
export interface EvolutionSourcePin {
  modelId: string;
  modelRevisionId: string;
  sourceId: string;
  sourceRevisionId: string;
}
export interface EvolutionRollout {
  scenarioId: string;
  variant: "baseline" | "candidate";
  attempt: number;
  calls: number;
  observations: string[];
  actions: string[];
  success?: boolean;
  violation?: boolean;
}
export interface EvolutionRevision extends EvolutionVersionDto {
  monitoredGoals: string[];
  evaluation?: { scenarioId: string; baseline: boolean[]; candidate: boolean[]; baselineCalls: number; candidateCalls: number; violations: number }[];
  evaluatorVersion: string;
  strategy: EvolutionStrategy;
  pin: EvolutionSourcePin;
  evidenceIds: string[];
  prediction: { fixes: string[]; risks: string[] };
}
export interface EvolutionBatch {
  evaluatorVersion: string;
  parentStrategy: EvolutionStrategy;
  id: string;
  parentRevisionId: string | null;
  strategy: EvolutionStrategy;
  pin: EvolutionSourcePin;
  phase: EvolutionPhase;
  evidenceIds: string[];
  rollouts: EvolutionRollout[];
  revisionId?: string;
}
export interface EvolutionCall {
  id: string;
  state: "PENDING" | "RUNNING" | "DONE";
  createdAt: string;
}
export interface EvolutionState {
  callSequence: number;
  developmentHistory: EvolutionRollout[];
  dailyCallLimit: number;
  usage: Record<string, number>;
  activeRevisionId: string | null;
  reason: EvolutionReason;
  lastCandidateDay: string | null;
  revisions: EvolutionRevision[];
  batch: EvolutionBatch | null;
  call: EvolutionCall | null;
  paused: boolean;
  /** Consecutive infrastructure failures against the current batch; capped before the batch is abandoned. Optional: absent in state persisted before this field existed. */
  callFailures?: number;
  /** UTC day parked after a failure; the batch (if any) resumes on a later day. */
  parkedDay?: string | null;
  /** When the last batch reached a verdict. Verdicts consume the evidence trigger; infrastructure aborts do not. */
  lastBatchFinishedAt?: string | null;
}
export interface EvolutionEvidenceSeed {
  goalId: string;
  workbenchId: string;
  observedAt: string;
  canceled: boolean;
  disposition: string | null;
  verified: number;
  failed: number;
  unverified: number;
  workFailed: number;
}
export interface EvolutionStore {
  listWorkbenchIds(): string[];
  read(workbenchId: string): EvolutionState;
  update<T>(workbenchId: string, operation: (state: EvolutionState) => T): T;
  evidence(workbenchId: string): EvolutionEvidence[];
  /**
   * Aggregate evaluable evidence across every workbench, restricted to what was observed after
   * `since`. Batches are triggered from this pool because evaluation uses fixed synthetic scenarios
   * shared by all workbenches; the resulting revision is still bound to a single workbench.
   */
  evidenceTotals(since: string | null): { evaluable: number; verificationFailed: number };
  evidenceSeeds(): EvolutionEvidenceSeed[];
  /**
   * Returns the classification actually persisted, or null when nothing changed. A re-scan may only
   * upgrade a goal's outcome, so the persisted value can differ from the one passed in — callers
   * that report what happened must report this, not their own input.
   */
  recordEvidence(evidence: EvolutionEvidence): EvolutionEvidence["outcome"] | null;
  bindGoal(workbenchId: string, goalId: string, revisionId: string | null, sourcePin?: EvolutionSourcePin): string | null;
  goalRevision(workbenchId: string, goalId: string): string | null | undefined;
  idle(): boolean;
}
export interface EvolutionModel {
  pin(): Promise<EvolutionSourcePin>;
  call(input: { pin: EvolutionSourcePin; systemPrompt: string; prompt: string; mode: "proposal" | "simulation"; signal?: AbortSignal; idempotencyId: string; workbenchId?: string }): Promise<unknown>;
}
export interface EvolutionCandidate {
  module: EvolutionModule;
  strategy: EvolutionStrategy;
  fixes: string[];
  risks: string[];
}
