import type { WorkDependency, WorkItem } from "../../domain/work/work.js";
import type { WorkItemDto } from "../../../shared/joi.js";

export interface PartnerDispatchPin {
  partnerId: string;
  partnerRevisionId: string;
  registryRevision: number;
}

export interface DispatchPolicyResult {
  allowed: boolean;
  reason?: string;
  workId: string;
}

export interface PlannedDispatchAttempt extends PartnerDispatchPin {
  actionId: string;
  dispatchAttemptId: string;
  outbox: {
    availableAt: string;
    kind: "partner.dispatch";
    outboxId: string;
    payload: { actionId: string; dispatchAttemptId: string; instanceId?: string; sessionPolicy?: "EPHEMERAL" | "RESIDENT"; workId: string };
  };
  workId: string;
}

export type WorkAcceptanceCheck =
  | { kind: "BODY_PRESENT" }
  | { kind: "ARTIFACT_PRESENT"; name: string }
  | { kind: "FILE_CONTAINS_EXACT"; expectedText: string; relativePath: string }
  | { kind: "FILE_EXISTS"; relativePath: string };

export interface WorkBrief {
  acceptanceChecks: WorkAcceptanceCheck[];
  evidenceResultIds?: string[];
  instructions?: string;
  workId: string;
}

export interface WorkRecoveryPlan {
  attemptNo: number;
  recoveryId: string;
  sourceWorkId: string;
  strategy: "SUPPLEMENT" | "TOOL_EXPANSION";
}

export interface CommittedWorkPlan {
  attempts: PlannedDispatchAttempt[];
  briefs: WorkBrief[];
  createdAt: string;
  dependencies: WorkDependency[];
  dispatchPlanId: string;
  inputId: string;
  items: WorkItem[];
  policyResults: DispatchPolicyResult[];
  recovery?: WorkRecoveryPlan;
  turnId: string;
  waves: string[][];
}

export interface WorkPlanRepository {
  commit(plan: CommittedWorkPlan): Promise<void>;
}

export interface WorkReassignmentContext {
  item: WorkItem;
  /** Instance that ran the latest attempt, when it was instance-linked; may be disposed by now. */
  lastInstanceId?: string;
  lastPartnerId: string;
  lastPartnerRevisionId: string;
}

export interface WorkSupplementContext {
  attemptCount: number;
  evidenceResultIds: string[];
  inputId: string;
  item: WorkItem;
  sourceAcceptanceChecks: WorkAcceptanceCheck[];
}

export interface ReassignedWorkPlan {
  attempt: PlannedDispatchAttempt;
  createdAt: string;
  dispatchPlanId: string;
  turnId: string;
  workId: string;
  recovery?: { attemptNo: number; recoveryId: string };
}

export interface WorkReassignmentRepository {
  cancel(workId: string, at: string): Promise<{ canceled: boolean; cascadedWorkIds: string[] }>;
  loadAttemptForAction?(workId: string, actionId: string): Promise<PlannedDispatchAttempt | null>;
  loadAttemptForTurn?(workId: string, turnId: string): Promise<PlannedDispatchAttempt | null>;
  loadForReassignment(workId: string): Promise<WorkReassignmentContext | null>;
  reassign(plan: ReassignedWorkPlan): Promise<void>;
}

export interface WorkRecoveryRepository {
  countRecoveryAttempts(workId: string): Promise<number>;
  loadForSupplement(workId: string): Promise<WorkSupplementContext | null>;
}

export interface WorkQuery {
  listActive(): Promise<WorkItemDto[]>;
}

export interface DispatchPolicyGate {
  evaluate(item: WorkItem, pin: PartnerDispatchPin): Promise<{ allowed: boolean; reason?: string }>;
}
