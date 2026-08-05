import { DomainError } from "../../domain/errors.js";
import { buildWorkExecutionWaves, createWorkItem, type WorkAccessMode, type WorkDependency } from "../../domain/work/work.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";
import type {
  CommittedWorkPlan,
  DispatchPolicyGate,
  PartnerDispatchPin,
  PlannedDispatchAttempt,
  WorkAcceptanceCheck,
  WorkPlanRepository,
  WorkReassignmentRepository,
} from "../ports/work-orchestration.js";

interface WorkRequest {
  acceptanceChecks?: WorkAcceptanceCheck[];
  accessMode: WorkAccessMode;
  instructions?: string;
  instanceId?: string;
  key: string;
  partnerId: string;
  sessionPolicy?: "EPHEMERAL" | "RESIDENT";
  title: string;
  /** Rejected compatibility field; work binds the Avatar workspace automatically. */
  workspaceRef?: string;
}

export class WorkOrchestrationService {
  constructor(private readonly dependencies: {
    clock: Clock;
    diagnostics?: RuntimeDiagnostics;
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
    inputId: string;
    turnId: string;
    work: WorkRequest[];
  }): Promise<{ dispatchPlanId: string; waves: string[][] }> {
    const byKey = new Map<string, WorkRequest>();
    for (const request of input.work) {
      if (request.workspaceRef !== undefined) throw new DomainError("work_workspace_forbidden", "Work uses its Avatar workspace automatically.");
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
      });
    });
    const dependencies: WorkDependency[] = input.dependencies.map((dependency) => {
      const workId = workIds.get(dependency.workKey);
      const dependsOnWorkId = workIds.get(dependency.dependsOnKey);
      if (workId === undefined || dependsOnWorkId === undefined) throw new DomainError("work_dependency_unknown", "Work dependency is unknown.");
      return { dependsOnWorkId, workId };
    });
    const briefs = items.map((item, index) => {
      const request = input.work[index];
      if (request === undefined) throw new Error("work_request_missing");
      return {
        acceptanceChecks: (request.acceptanceChecks ?? []).map((check) => ({ ...check })),
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        workId: item.workId,
      };
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
          payload: {
            actionId,
            dispatchAttemptId,
            ...(request.instanceId === undefined ? {} : { instanceId: request.instanceId }),
            ...(request.sessionPolicy === undefined ? {} : { sessionPolicy: request.sessionPolicy }),
            workId: item.workId,
          },
        },
        workId: item.workId,
      });
    }
    if (policyResults.some((policy) => !policy.allowed && policy.reason === "avatar_workspace_not_ready")) {
      throw new DomainError("avatar_workspace_not_ready", "Select an Avatar workspace before dispatching file work.");
    }
    const dispatchPlanId = this.dependencies.ids.next("dispatch_plan");
    await this.dependencies.repository.commit({
      attempts, briefs, createdAt, dependencies, dispatchPlanId, inputId: input.inputId, items, policyResults, turnId: input.turnId, waves,
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.plan.committed", {
      attemptCount: attempts.length,
      avatarId: input.avatarId,
      dependencyCount: dependencies.length,
      dispatchPlanId,
      inputId: input.inputId,
      turnId: input.turnId,
      waveCount: waves.length,
      workCount: items.length,
    });
    for (const attempt of attempts) {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.dispatch_planned", {
        actionId: attempt.actionId,
        avatarId: input.avatarId,
        dispatchAttemptId: attempt.dispatchAttemptId,
        dispatchPlanId,
        outboxId: attempt.outbox.outboxId,
        partnerId: attempt.partnerId,
        partnerRevisionId: attempt.partnerRevisionId,
        turnId: input.turnId,
        workId: attempt.workId,
      });
    }
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
    const dispatchPlanId = this.dependencies.ids.next("dispatch_plan");
    await repository.reassign({
      attempt,
      createdAt,
      dispatchPlanId,
      turnId: input.turnId,
      workId: input.workId,
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.dispatch_planned", {
      actionId: attempt.actionId,
      avatarId: input.avatarId,
      dispatchAttemptId: attempt.dispatchAttemptId,
      dispatchPlanId,
      outboxId: attempt.outbox.outboxId,
      partnerId: attempt.partnerId,
      partnerRevisionId: attempt.partnerRevisionId,
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
