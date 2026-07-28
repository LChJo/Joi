import { DomainError } from "../../domain/errors.js";
import { buildWorkExecutionWaves, createWorkItem, type WorkAccessMode, type WorkDependency } from "../../domain/work/work.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";
import type {
  CommittedWorkPlan,
  DispatchPolicyGate,
  PartnerDispatchPin,
  PlannedDispatchAttempt,
  WorkPlanRepository,
  WorkReassignmentRepository,
} from "../ports/work-orchestration.js";

interface WorkRequest {
  accessMode: WorkAccessMode;
  key: string;
  partnerId: string;
  title: string;
  workspaceRef?: string;
}

export class WorkOrchestrationService {
  constructor(private readonly dependencies: {
    clock: Clock;
    events?: DurableUiEventEmitter;
    ids: IdGenerator;
    partners: { pinForDispatch(partnerId: string): Promise<PartnerDispatchPin> };
    policy: DispatchPolicyGate;
    reassignment?: WorkReassignmentRepository;
    repository: WorkPlanRepository;
  }) {}

  async plan(input: {
    avatarId: string;
    dependencies: { dependsOnKey: string; workKey: string }[];
    turnId: string;
    work: WorkRequest[];
  }): Promise<{ dispatchPlanId: string; waves: string[][] }> {
    const byKey = new Map<string, WorkRequest>();
    for (const request of input.work) {
      if (byKey.has(request.key)) throw new DomainError("work_key_duplicate", "Work keys must be unique.");
      byKey.set(request.key, request);
    }
    const createdAt = this.dependencies.clock.now().toISOString();
    const workIds = new Map<string, string>();
    const items = input.work.map((request) => {
      const workId = this.dependencies.ids.next("work");
      workIds.set(request.key, workId);
      return createWorkItem({
        accessMode: request.accessMode,
        avatarId: input.avatarId,
        createdAt,
        title: request.title,
        workId,
        ...(request.workspaceRef === undefined ? {} : { workspaceRef: request.workspaceRef }),
      });
    });
    const dependencies: WorkDependency[] = input.dependencies.map((dependency) => {
      const workId = workIds.get(dependency.workKey);
      const dependsOnWorkId = workIds.get(dependency.dependsOnKey);
      if (workId === undefined || dependsOnWorkId === undefined) throw new DomainError("work_dependency_unknown", "Work dependency is unknown.");
      return { dependsOnWorkId, workId };
    });
    const waves = buildWorkExecutionWaves(items, dependencies);
    const policyResults: CommittedWorkPlan["policyResults"] = [];
    const attempts: PlannedDispatchAttempt[] = [];
    for (const [index, item] of items.entries()) {
      const request = input.work[index];
      if (request === undefined) throw new Error("work_request_missing");
      const pin = await this.dependencies.partners.pinForDispatch(request.partnerId);
      const result = await this.dependencies.policy.evaluate(item, pin);
      policyResults.push({ allowed: result.allowed, ...(result.reason === undefined ? {} : { reason: result.reason }), workId: item.workId });
      if (!result.allowed) continue;
      const actionId = this.dependencies.ids.next("action");
      const dispatchAttemptId = this.dependencies.ids.next("dispatch_attempt");
      attempts.push({
        ...pin,
        actionId,
        dispatchAttemptId,
        outbox: {
          availableAt: createdAt,
          kind: "partner.dispatch",
          outboxId: this.dependencies.ids.next("outbox"),
          payload: { actionId, dispatchAttemptId, workId: item.workId },
        },
        workId: item.workId,
      });
    }
    const dispatchPlanId = this.dependencies.ids.next("dispatch_plan");
    await this.dependencies.repository.commit({
      attempts, createdAt, dependencies, dispatchPlanId, items, policyResults, turnId: input.turnId, waves,
    });
    await this.dependencies.events?.emit("work.plan.committed", dispatchPlanId, {
      avatarId: input.avatarId,
      dispatchPlanId,
      workIds: items.map((item) => item.workId),
    });
    return { dispatchPlanId, waves };
  }

  async reassign(input: { avatarId: string; partnerId: string; turnId: string; workId: string }): Promise<PlannedDispatchAttempt> {
    const repository = this.dependencies.reassignment;
    if (repository === undefined) throw new DomainError("work_reassignment_unavailable", "Work reassignment is unavailable.");
    const context = await repository.loadForReassignment(input.workId);
    if (context === null) throw new DomainError("work_not_found", "Work was not found.");
    if (context.item.avatarId !== input.avatarId) throw new DomainError("work_avatar_mismatch", "Work belongs to another Avatar.");
    if (!(["FAILED", "WAITING", "READY"] as const).includes(context.item.status as "FAILED" | "WAITING" | "READY")) {
      throw new DomainError("work_reassign_status_invalid", "Work cannot be reassigned in its current state.");
    }
    const pin = await this.dependencies.partners.pinForDispatch(input.partnerId);
    if (pin.partnerRevisionId === context.lastPartnerRevisionId) {
      throw new DomainError("work_reassign_same_revision", "Reassignment requires a different partner revision.");
    }
    const policy = await this.dependencies.policy.evaluate(context.item, pin);
    if (!policy.allowed) throw new DomainError("work_reassign_policy_denied", policy.reason ?? "Work reassignment was denied.");
    const createdAt = this.dependencies.clock.now().toISOString();
    const actionId = this.dependencies.ids.next("action");
    const dispatchAttemptId = this.dependencies.ids.next("dispatch_attempt");
    const attempt: PlannedDispatchAttempt = {
      ...pin,
      actionId,
      dispatchAttemptId,
      outbox: {
        availableAt: createdAt,
        kind: "partner.dispatch",
        outboxId: this.dependencies.ids.next("outbox"),
        payload: { actionId, dispatchAttemptId, workId: input.workId },
      },
      workId: input.workId,
    };
    await repository.reassign({
      attempt,
      createdAt,
      dispatchPlanId: this.dependencies.ids.next("dispatch_plan"),
      turnId: input.turnId,
      workId: input.workId,
    });
    await this.dependencies.events?.emit("work.reassigned", input.workId, {
      avatarId: input.avatarId,
      partnerRevisionId: attempt.partnerRevisionId,
      workId: input.workId,
    });
    return attempt;
  }
}
