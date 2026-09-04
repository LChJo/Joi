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
  WorkRecoveryRepository,
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

function acceptanceCheckKey(check: WorkAcceptanceCheck): string {
  if (check.kind === "BODY_PRESENT") return check.kind;
  if (check.kind === "ARTIFACT_PRESENT") return `${check.kind}:${check.name}`;
  if (check.kind === "FILE_EXISTS") return `${check.kind}:${check.relativePath}`;
  return `${check.kind}:${check.relativePath}:${check.expectedText}`;
}

function mergeAcceptanceChecks(required: WorkAcceptanceCheck[], additive: WorkAcceptanceCheck[] | undefined): WorkAcceptanceCheck[] {
  const seen = new Set<string>();
  const merged: WorkAcceptanceCheck[] = [];
  for (const check of [...required, ...(additive ?? [])]) {
    const key = acceptanceCheckKey(check);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...check });
  }
  return merged;
}

function strongerAccessMode(source: WorkAccessMode, requested: WorkAccessMode): WorkAccessMode {
  const rank: Record<WorkAccessMode, number> = { NONE: 0, READ: 1, WRITE: 2 };
  return rank[source] >= rank[requested] ? source : requested;
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
    recovery?: WorkRecoveryRepository;
    repository: WorkPlanRepository;
  }) {}

  async plan(input: {
    workbenchId: string;
    dependencies: { dependsOnKey: string; workKey: string }[];
    inputId: string;
    turnId: string;
    work: WorkRequest[];
    recovery?: { attemptNo: number; evidenceResultIds: string[]; recoveryId: string; sourceWorkId: string; strategy: "SUPPLEMENT" | "TOOL_EXPANSION" };
  }): Promise<{ denied: { reasonCode: string; workKey: string }[]; dispatchPlanId: string; waves: string[][] }> {
    const byKey = new Map<string, WorkRequest>();
    for (const request of input.work) {
      if (request.workspaceRef !== undefined) throw new DomainError("work_workspace_forbidden", "Work uses its Workbench workspace automatically.");
      if (byKey.has(request.key)) throw new DomainError("work_key_duplicate", "Work keys must be unique.");
      validateAcceptanceChecks(request.acceptanceChecks);
      // Authoritative backstop for the schema's minItems: a Work with no acceptance check
      // cannot be verified, so it must not be dispatched (BODY_PRESENT is the natural floor
      // for text-only work).
      if ((request.acceptanceChecks ?? []).length === 0) {
        throw new DomainError("work_acceptance_checks_required", "Every Work needs at least one mechanically checkable acceptance check.");
      }
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
        ...(input.recovery === undefined || input.recovery.evidenceResultIds.length === 0 ? {} : { evidenceResultIds: [...input.recovery.evidenceResultIds] }),
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        workId: item.workId,
      };
    });
    const waves = buildWorkExecutionWaves(items, dependencies);
    const policyResults: CommittedWorkPlan["policyResults"] = [];
    const attempts: PlannedDispatchAttempt[] = [];
    const denied: { partnerId: string; reasonCode: string; workId: string; workKey: string }[] = [];
    for (const [index, item] of items.entries()) {
      const request = input.work[index];
      if (request === undefined) throw new Error("work_request_missing");
      const pin = await this.dependencies.partners.pinForDispatch(request.partnerId);
      const result = await this.dependencies.policy.evaluate(item, pin);
      policyResults.push({ allowed: result.allowed, ...(result.reason === undefined ? {} : { reason: result.reason }), workId: item.workId });
      // Denied Work still gets an attempt so the delivery-side recheck decides its fate:
      // a transient lease conflict retries through the outbox, a permanent denial lands a
      // terminal FAILED result, and neither can silently jam the goal forever. Only a
      // missing workspace aborts the whole plan before commit (raised below).
      if (!result.allowed && result.reason !== DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady) {
        denied.push({ partnerId: request.partnerId, reasonCode: result.reason ?? "dispatch_policy_denied", workId: item.workId, workKey: request.key });
      }
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
      attempts, briefs, createdAt, dependencies, dispatchPlanId, inputId: input.inputId, items, policyResults,
      ...(input.recovery === undefined ? {} : { recovery: {
        attemptNo: input.recovery.attemptNo,
        recoveryId: input.recovery.recoveryId,
        sourceWorkId: input.recovery.sourceWorkId,
        strategy: input.recovery.strategy,
      } }),
      turnId: input.turnId, waves,
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.plan.committed", {
      attemptCount: attempts.length,
      workbenchId: input.workbenchId,
      deniedCount: denied.length,
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
    for (const entry of denied) {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.plan_policy_denied", {
        workbenchId: input.workbenchId,
        dispatchPlanId,
        partnerId: entry.partnerId,
        reasonCode: entry.reasonCode,
        turnId: input.turnId,
        workId: entry.workId,
      });
    }
    await this.dependencies.events?.emit("work.plan.committed", dispatchPlanId, {
      workbenchId: input.workbenchId,
      dispatchPlanId,
      workIds: items.map((item) => item.workId),
    });
    return {
      denied: denied.map(({ reasonCode, workKey }) => ({ reasonCode, workKey })),
      dispatchPlanId,
      waves,
    };
  }

  /** Creates a new, independent Work for an essential gap; historical Work is evidence, never a DAG key. */
  async supplement(input: {
    acceptanceChecks?: WorkAcceptanceCheck[];
    accessMode: WorkAccessMode;
    instructions?: string;
    partnerId: string;
    sourceWorkId: string;
    strategy?: "SUPPLEMENT" | "TOOL_EXPANSION";
    title: string;
    turnId: string;
    workbenchId: string;
  }): Promise<{ attemptNo: number; dispatchPlanId: string; evidenceResultIds: string[]; waves: string[][] }> {
    const repository = this.dependencies.recovery;
    if (repository === undefined) throw new DomainError("work_recovery_unavailable", "Work recovery is unavailable.");
    const context = await repository.loadForSupplement(input.sourceWorkId);
    if (context === null) throw new DomainError("work_not_found", "Work was not found.");
    if (context.item.workbenchId !== input.workbenchId) throw new DomainError("work_workbench_mismatch", "Work belongs to another Workbench.");
    if (context.item.status !== "FAILED") throw new DomainError("work_recovery_status_invalid", "Only failed Work can be supplemented.");
    if (context.attemptCount >= 2) throw new DomainError("work_recovery_exhausted", "Work recovery is limited to two rounds.");
    const acceptanceChecks = mergeAcceptanceChecks(context.sourceAcceptanceChecks, input.acceptanceChecks);
    validateAcceptanceChecks(acceptanceChecks);
    const attemptNo = context.attemptCount + 1;
    const recoveryId = this.dependencies.ids.next("work_recovery");
    const planned = await this.plan({
      dependencies: [],
      inputId: context.inputId,
      recovery: {
        attemptNo,
        evidenceResultIds: context.evidenceResultIds,
        recoveryId,
        sourceWorkId: input.sourceWorkId,
        strategy: input.strategy ?? "SUPPLEMENT",
      },
      turnId: input.turnId,
      work: [{
        acceptanceChecks,
        accessMode: strongerAccessMode(context.item.accessMode, input.accessMode),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        key: recoveryId,
        partnerId: input.partnerId,
        title: input.title,
      }],
      workbenchId: input.workbenchId,
    });
    return { attemptNo, dispatchPlanId: planned.dispatchPlanId, evidenceResultIds: context.evidenceResultIds, waves: planned.waves };
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
    const recoveryAttemptCount = await this.dependencies.recovery?.countRecoveryAttempts(input.workId) ?? 0;
    if (recoveryAttemptCount >= 2) throw new DomainError("work_recovery_exhausted", "Work recovery is limited to two rounds.");
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
      ...(this.dependencies.recovery === undefined ? {} : { recovery: {
        attemptNo: recoveryAttemptCount + 1,
        recoveryId: this.dependencies.ids.next("work_recovery"),
      } }),
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
  async resume(input: { actionId?: string; workbenchId: string; turnId: string; workId: string }): Promise<PlannedDispatchAttempt> {
    const repository = this.dependencies.reassignment;
    if (repository === undefined) throw new DomainError("work_reassignment_unavailable", "Work reassignment is unavailable.");
    const existingForAction = input.actionId === undefined
      ? null
      : await repository.loadAttemptForAction?.(input.workId, input.actionId) ?? null;
    if (existingForAction !== null) return existingForAction;
    const existing = await repository.loadAttemptForTurn?.(input.workId, input.turnId) ?? null;
    if (existing !== null) return existing;
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
    const actionId = input.actionId ?? this.dependencies.ids.next("action");
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
    const outcome = await repository.cancel(input.workId, this.dependencies.clock.now().toISOString());
    if (!outcome.canceled) throw new DomainError("work_cancel_status_invalid", "Work in its current state cannot be canceled.");
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.canceled", {
      workbenchId: input.workbenchId,
      workId: input.workId,
    });
    if (outcome.cascadedWorkIds.length > 0) {
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.work.dependency_cascade", {
        workbenchId: input.workbenchId,
        canceledWorkIds: outcome.cascadedWorkIds,
        reasonCode: "dependency_canceled",
        sourceWorkId: input.workId,
      });
    }
    await this.dependencies.events?.emit("work.canceled", input.workId, {
      workbenchId: input.workbenchId,
      workId: input.workId,
    });
    return { workId: input.workId };
  }
}
