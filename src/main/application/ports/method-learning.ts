import type { LearningCase, LearningFacts } from "../../domain/evolution/learning-case.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
// Recursive JSON values require an interface boundary.
export interface JsonObject { [key: string]: JsonValue; }
export interface MethodLearningControl { enabled: boolean; paused: boolean; dailyCallLimit: number; lastCandidateDay: string | null; }
export interface MethodLearningParticipant { enabled: boolean; paused: boolean; dailyCallLimit: number; reason: string; }
export interface MethodExperiment {
  id: string; workbenchId: string; scope: "GLOBAL" | "WORKBENCH"; profile: string;
  phase: "PROTOCOL" | "DEVELOP" | "PROPOSE" | "VALIDATE" | "EVALUATE";
  status: "RUNNING" | "PAUSED" | "COMPLETED" | "REJECTED";
  createdAt: string; updatedAt: string; state: JsonObject;
}
export interface MethodRevision {
  id: string; workbenchId: string; scope: "GLOBAL" | "WORKBENCH"; profile: string;
  status: "CANARY" | "ACTIVE" | "REVERTED" | "REJECTED";
  createdAt: string; updatedAt: string; state: JsonObject;
}
export interface MethodGoalPin { workbenchId: string; goalId: string; revisionId: string | null; policy: string; at: string; }
export interface MethodTrialKey { source: string; model: string; tool: string; evaluator: string; parent: string; caseId: string; attempt: number; }
export interface MethodEvidenceRead { workbenchId: string; goalId: string; turnId: string; toolCallId: string; tool: "work_read_result" | "work_read_evidence"; resultId: string | null; cursor: string | null; mode: string | null; }
export interface MethodLearningStore {
  control(): MethodLearningControl;
  configureGlobal(patch: Partial<MethodLearningControl>): MethodLearningControl;
  participant(workbenchId: string): MethodLearningParticipant;
  configureParticipant(workbenchId: string, patch: Partial<MethodLearningParticipant>): MethodLearningParticipant;
  reserveCall(input: { callId: string; experimentId: string; workbenchId: string; day: string; at: string; checkpoint?: MethodExperiment }): "reserved" | "existing" | "disabled" | "paused" | "budget_exhausted";
  completeCall(callId: string, tokens: number | null, at: string): void;
  usage(day: string, workbenchId?: string): { calls: number; tokens: number; tokensComplete: boolean };
  experimentUsage(experimentId: string): { calls: number; tokens: number; tokensComplete: boolean };
  captureFacts(limit?: number): LearningFacts[];
  acknowledgeFacts(facts: LearningFacts[]): void;
  goalMetrics(goalId: string): { calls: number; tokens: number | null };
  goalRequirementCount(workbenchId: string, goalId: string): number | null;
  goalSourceMatches(goalId: string, sourceRevisionId: string, modelRevisionId: string): boolean;
  goalEvaluationEligible(goalId: string): boolean;
  currentEvaluationCases(): LearningCase[];
  goalCaseMatchesCurrent(goalId: string, requirementsRevision: number, resultRevision: number, caseId?: string): boolean;
  invalidateGoalExposure(workbenchId: string, goalId: string): void;
  recordEvidenceRead(read: MethodEvidenceRead): void;
  upsertCases(cases: LearningCase[]): void;
  listCases(workbenchId?: string): LearningCase[];
  saveExperiment(experiment: MethodExperiment): void;
  experiment(id: string): MethodExperiment | null;
  experiments(): MethodExperiment[];
  saveRevision(revision: MethodRevision): void;
  revision(id: string): MethodRevision | null;
  revisions(): MethodRevision[];
  cacheTrial(key: MethodTrialKey): JsonObject | null;
  saveTrial(key: MethodTrialKey, result: JsonObject): void;
  pinGoal(pin: MethodGoalPin): MethodGoalPin;
  goalPin(workbenchId: string, goalId: string): MethodGoalPin | null;
  goalPins(revisionId?: string): MethodGoalPin[];
  countGoalPins(revisionId?: string): number;
}
