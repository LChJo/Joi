import { DomainError } from "../../domain/errors.js";
import { buildWorkExecutionWaves, createWorkItem, type WorkAccessMode, type WorkDependency } from "../../domain/work/work.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type {
  CommittedWorkPlan,
  DispatchPolicyGate,
  PartnerDispatchPin,
  PlannedDispatchAttempt,
  WorkPlanRepository,
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
    ids: IdGenerator;
    partners: { pinForDispatch(partnerId: string): Promise<PartnerDispatchPin> };
    policy: DispatchPolicyGate;
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
    return { dispatchPlanId, waves };
  }
}
