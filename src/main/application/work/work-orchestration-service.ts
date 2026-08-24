import { DomainError } from "../../domain/errors.js";
import { buildWorkExecutionWaves, createWorkItem, type WorkAccessMode, type WorkDependency } from "../../domain/work/work.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import type { PartnerInstanceRepository } from "../ports/partner-instances.js";
import { DISPATCH_POLICY_REASONS } from "./dispatch-policy.js";
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
  /** Rejected compatibility field; work binds the workbench workspace automatically. */
  workspaceRef?: string;
}

function invalidAcceptancePath(value: string): boolean {
  const candidate = value.trim();
  return candidate === ""
    || /^[\\/]/u.test(candidate)
    || /^[A-Za-z]:/u.test(candidate)
    || candidate.split(/[\\/]+/u).some((segment) => segment === "..");
}

function validateAcceptanceChecks(checks: WorkAcceptanceCheck[] | undefined): void {
  for (const check of checks ?? []) {
    if ((check.kind === "FILE_EXISTS" || check.kind === "FILE_CONTAINS_EXACT") && invalidAcceptancePath(check.relativePath)) {
      throw new DomainError("work_acceptance_path_invalid", "Acceptance file paths must be relative to the Workbench workspace.");
    }
  }
}

export class WorkOrchestrationService {
  constructor(private readonly dependencies: {
    clock: Clock;
    diagnostics?: RuntimeDiagnostics;
    events?: DurableUiEventEmitter;
    ids: IdGenerator;
    /** Liveness check before a resume references a stored instance id. */
    instances?: Pick<PartnerInstanceRepository, "get">;
    partners: { pinForDispatch(partnerId: string): Promise<PartnerDispatchPin> };
    policy: DispatchPolicyGate;
    reassignment?: WorkReassignmentRepository;
    repository: WorkPlanRepository;
  }) {}

  async plan(input: {
    workbenchId: string;
    dependencies: { dependsOnKey: string; workKey: string }[];
    inputId: string;
    turnId: string;
    work: WorkRequest[];
  }): Promise<{ dispatchPlanId: string; waves: string[][] }> {
    const byKey = new Map<string, WorkRequest>();
    for (const request of input.work) {
      if (request.workspaceRef !== undefined) throw new DomainError("work_workspace_forbidden", "Work uses its Workbench workspace automatically.");
      if (byKey.has(request.key)) throw new DomainError("work_key_duplicate", "Work keys must be unique.");
      validateAcceptanceChecks(request.acceptanceChecks);
      byKey.set(request.key, request);
    }
    for (const request of input.work) await this.#validateInstanceSelection(input.workbenchId, request);
    const createdAt = this.dependencies.clock.now().toISOString();
    const workIds = new Map<string, string>();
    const items = input.work.map((request) => {
      const workId = this.dependencies.ids.next("work");
      workIds.set(request.key, workId);
      return createWorkItem({
        accessMode: request.accessMode,
        workbenchId: input.workbenchId,
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
    if (policyResults.some((policy) => !policy.allowed && policy.reason === DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady)) {
      throw new DomainError(DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady, "Select a workbench workspace before dispatching file work.");
    }
    const dispatchPlanId = this.dependencies.ids.next("dispatch_plan");
    await this.dependencies.repository.commit({
      attempts, briefs, createdAt, dependencies, dispatchPlanId, inputId: input.inputId, items, policyResults, turnId: input.turnId, waves,
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.plan.committed", {
      attemptCount: attempts.length,
      workbenchId: input.workbenchId,
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
        workbenchId: input.workbenchId,
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
      workbenchId: input.workbenchId,
      dispatchPlanId,
      workIds: items.map((item) => item.workId),
    });
    return { dispatchPlanId, waves };
  }

  async #validateInstanceSelection(workbenchId: string, request: WorkRequest): Promise<void> {
    if (request.instanceId !== undefined && request.sessionPolicy !== undefined) {
      throw new DomainError("partner_instance_selection_ambiguous", "Choose either an existing partner instance or a session policy, not both.");
    }
    if (request.instanceId === undefined) return;
    if (this.dependencies.instances === undefined) {
      throw new DomainError("partner_instance_validation_unavailable", "Partner instance validation is unavailable.");
    }
    const instance = await this.dependencies.instances.get(request.instanceId);
    if (instance === null || instance.status === "DISPOSED") {
      throw new DomainError("partner_instance_unavailable", "Partner instance is not available.");
    }
    if (instance.workbenchId !== workbenchId) {
      throw new DomainError("partner_instance_workbench_mismatch", "Partner instance belongs to another Workbench.");
    }
    if (instance.partnerId !== request.partnerId) {
      throw new DomainError("partner_instance_partner_mismatch", "Partner instance belongs to another partner.");
    }
    if (instance.status !== "IDLE") {
      throw new DomainError("partner_instance_busy", "Partner instance is busy with another turn.");
    }
  }

  async reassign(input: { workbenchId: string; partnerId: string; turnId: string; workId: string }): Promise<PlannedDispatchAttempt> {
    const repository = this.dependencies.reassignment;
    if (repository === undefined) throw new DomainError("work_reassignment_unavailable", "Work reassignment is unavailable.");
    const context = await repository.loadForReassignment(input.workId);
    if (context === null) throw new DomainError("work_not_found", "Work was not found.");
    if (context.item.workbenchId !== input.workbenchId) throw new DomainError("work_workbench_mismatch", "Work belongs to another Workbench.");
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
      workbenchId: input.workbenchId,
      dispatchAttemptId: attempt.dispatchAttemptId,
      dispatchPlanId,
      outboxId: attempt.outbox.outboxId,
      partnerId: attempt.partnerId,
      partnerRevisionId: attempt.partnerRevisionId,
      turnId: input.turnId,
      workId: input.workId,
    });
    await this.dependencies.events?.emit("work.reassigned", input.workId, {
      workbenchId: input.workbenchId,
      partnerRevisionId: attempt.partnerRevisionId,
      workId: input.workId,
    });
    return attempt;
  }

  /**
   * Resumes work that paused waiting for the user's answer. Unlike reassign this keeps the
   * current partner revision: the point is to feed the answer back into the same work, and
   * the dispatch continues in the original resident instance when it is still alive.
   */
  async resume(input: { workbenchId: string; turnId: string; workId: string }): Promise<PlannedDispatchAttempt> {
    const repository = this.dependencies.reassignment;
    if (repository === undefined) throw new DomainError("work_reassignment_unavailable", "Work reassignment is unavailable.");
    const context = await repository.loadForReassignment(input.workId);
    if (context === null) throw new DomainError("work_not_found", "Work was not found.");
    if (context.item.workbenchId !== input.workbenchId) throw new DomainError("work_workbench_mismatch", "Work belongs to another Workbench.");
    if (context.item.status !== "WAITING") throw new DomainError("work_resume_status_invalid", "Only waiting work can be resumed.");
    const pin = await this.dependencies.partners.pinForDispatch(context.lastPartnerId);
    const policy = await this.dependencies.policy.evaluate(context.item, pin);
    if (!policy.allowed) throw new DomainError("work_resume_policy_denied", policy.reason ?? "Work resume was denied.");
    // Continue in the instance that paused so the resident conversation keeps the question
    // context. Never reference a disposed instance: dispatch would fail and the outbox row
    // would retry forever. Fall back to a resident continuation when the instance is gone.
    const lastInstance = context.lastInstanceId === undefined || this.dependencies.instances === undefined
      ? null
      : await this.dependencies.instances.get(context.lastInstanceId);
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
        payload: {
          actionId,
          dispatchAttemptId,
          ...(lastInstance !== null && lastInstance.status === "IDLE"
            ? { instanceId: lastInstance.instanceId }
            : { sessionPolicy: "RESIDENT" as const }),
          workId: input.workId,
        },
      },
      workId: input.workId,
    };
    const dispatchPlanId = this.dependencies.ids.next("dispatch_plan");
    await repository.reassign({ attempt, createdAt, dispatchPlanId, turnId: input.turnId, workId: input.workId });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.dispatch_planned", {
      actionId: attempt.actionId,
      workbenchId: input.workbenchId,
      dispatchAttemptId: attempt.dispatchAttemptId,
      dispatchPlanId,
      outboxId: attempt.outbox.outboxId,
      partnerId: attempt.partnerId,
      partnerRevisionId: attempt.partnerRevisionId,
      turnId: input.turnId,
      workId: input.workId,
    });
    await this.dependencies.events?.emit("work.resumed", input.workId, {
      workbenchId: input.workbenchId,
      partnerRevisionId: attempt.partnerRevisionId,
      workId: input.workId,
    });
    return attempt;
  }

  /** Cancels work that is not mid-flight; a RUNNING attempt finishes on its own and arrives late. */
  async cancel(input: { workbenchId: string; workId: string }): Promise<{ workId: string }> {
    const repository = this.dependencies.reassignment;
    if (repository === undefined) throw new DomainError("work_reassignment_unavailable", "Work cancellation is unavailable.");
    const context = await repository.loadForReassignment(input.workId);
    if (context === null) throw new DomainError("work_not_found", "Work was not found.");
    if (context.item.workbenchId !== input.workbenchId) throw new DomainError("work_workbench_mismatch", "Work belongs to another Workbench.");
    const canceled = await repository.cancel(input.workId, this.dependencies.clock.now().toISOString());
    if (!canceled) throw new DomainError("work_cancel_status_invalid", "Work in its current state cannot be canceled.");
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.canceled", {
      workbenchId: input.workbenchId,
      workId: input.workId,
    });
    await this.dependencies.events?.emit("work.canceled", input.workId, {
      workbenchId: input.workbenchId,
      workId: input.workId,
    });
    return { workId: input.workId };
  }
}
