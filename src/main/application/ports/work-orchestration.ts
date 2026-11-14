import type { WorkAccessMode, WorkDependency, WorkItem } from "../../domain/work/work.js";
import type { WorkItemDto } from "../../../shared/joi.js";
import type { LocalExecutionCapabilities, WorkExecutionNeed } from "../../domain/work/work-execution-needs.js";

export interface PartnerDispatchPin {
  localExecution?: LocalExecutionCapabilities;
  /** Required by the pinned Skill/tool policy; applied before policy and lease checks. */
  minimumAccessMode?: WorkAccessMode;
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
  executionNeeds?: WorkExecutionNeed[];
  acceptanceChecks: WorkAcceptanceCheck[];
  briefVersion?: 2 | 3;
  requirementsRevision?: number;
  requirementIds?: string[];
  allRequirements?: boolean;
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

export interface GoalWorkListItem {
  workId: string; title: string; status: string; requirementsRevision?: number;
  executionPhase?: WorkItemDto["executionPhase"];
  waitReason?: WorkItemDto["waitReason"];
}
export interface GoalWorkListQuery {
  goalInputId: string;
  workbenchId: string;
  statuses?: string[];
  requirementsRevision?: number;
  requirementsRevisionNot?: number | null;
  workId?: string;
  excludeWorkId?: string;
  limit?: number;
  cursor?: string;
}
export interface GoalWorkListPage { items: GoalWorkListItem[]; nextCursor?: string }

export interface WorkPlanRepository {
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Ordinary commits have no result; duplicate supplements return their persisted reference.
  commit(plan: CommittedWorkPlan): Promise<void | SupplementReference>;
  refreshBrief?(input: { executionNeeds?: WorkExecutionNeed[]; goalInputId: string; workbenchId: string; workId: string; turnId: string; actionId: string; instructions: string; requirementsRevision: number; requirementIds: string[]; allRequirements: boolean }): Promise<void>;
  listForGoal?(goalInputId: string, workbenchId: string): Promise<GoalWorkListItem[]>;
  listGoalPage?(input: GoalWorkListQuery): Promise<GoalWorkListPage>;
  readBrief?(goalInputId: string, workbenchId: string, workId: string): Promise<{ workId: string; title: string; instructions: string; accessMode?: WorkAccessMode; executionNeeds?: WorkExecutionNeed[] | null; requirementsRevision?: number } | null>;
}

export interface WorkReassignmentContext {
  executionNeeds?: WorkExecutionNeed[];
  inputId?: string;
  item: WorkItem;
  /** Instance that ran the latest attempt, when it was instance-linked; may be disposed by now. */
  lastInstanceId?: string;
  lastPartnerId: string;
  lastPartnerRevisionId: string;
}

export interface WorkSupplementContext {
  executionNeeds?: WorkExecutionNeed[];
  attemptCount: number;
  evidenceResultIds: string[];
  inputId: string;
  item: WorkItem;
  sourceAcceptanceChecks: WorkAcceptanceCheck[];
}

export interface ReassignedWorkPlan {
  evidenceResultIds?: string[];
  executionNeeds?: WorkExecutionNeed[];
  requirementsRevision?: number;
  requirementIds?: string[];
  allRequirements?: boolean;
  accessMode?: WorkAccessMode;
  /** Complete replacement brief for a resumed Work; other contract fields remain intact. */
  instructions?: string;
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
  findSupplement?(sourceWorkId: string, turnId: string): Promise<SupplementReference | null>;
  countRecoveryAttempts(workId: string): Promise<number>;
  loadForSupplement(workId: string): Promise<WorkSupplementContext | null>;
}

export interface SupplementReference { attemptNo: number; dispatchPlanId: string; evidenceResultIds: string[]; waves: string[][] }

export interface WorkQuery {
  listActive(): Promise<WorkItemDto[]>;
}

export interface DispatchPolicyGate {
  evaluate(item: WorkItem, pin: PartnerDispatchPin): Promise<{ allowed: boolean; reason?: string }>;
}
