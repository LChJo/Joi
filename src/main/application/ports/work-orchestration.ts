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
    payload: { actionId: string; dispatchAttemptId: string; workId: string };
  };
  workId: string;
}

export interface CommittedWorkPlan {
  attempts: PlannedDispatchAttempt[];
  createdAt: string;
  dependencies: WorkDependency[];
  dispatchPlanId: string;
  items: WorkItem[];
  policyResults: DispatchPolicyResult[];
  turnId: string;
  waves: string[][];
}

export interface WorkPlanRepository {
  commit(plan: CommittedWorkPlan): Promise<void>;
}

export interface WorkQuery {
  listActive(): Promise<WorkItemDto[]>;
}

export interface DispatchPolicyGate {
  evaluate(item: WorkItem, pin: PartnerDispatchPin): Promise<{ allowed: boolean; reason?: string }>;
}
