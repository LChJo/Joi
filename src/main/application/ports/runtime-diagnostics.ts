export interface RuntimeDiagnosticEventMap {
  "joi.input.accepted": {
    attachmentCount: number;
    avatarBound: boolean;
    inputId: string;
  };
  "joi.input.handling_started": {
    attachmentCount: number;
    avatarBound: boolean;
    inputId: string;
    status: string;
  };
  "joi.input.scheduler_failed": {
    errorCode: string;
    inputId: string;
  };
  "joi.input.waiting_clarification": {
    inputId: string;
    reasonCode: string;
  };
  "joi.avatar.resolved": {
    avatarId: string;
    inputId: string;
    resolution: "bound" | "bootstrap" | "created" | "selected";
  };
  "joi.turn.started": {
    avatarId: string;
    inputId: string;
    modelRevisionId: string;
    sourceId: string;
    sourceRevisionId: string;
    turnId: string;
  };
  "joi.tool.started": {
    avatarId: string;
    inputId: string;
    sourceId: string;
    toolCallId: string;
    toolName: string;
    turnId: string;
  };
  "joi.tool.finished": {
    avatarId: string;
    durationMs: number;
    inputId: string;
    isError: boolean;
    sourceId: string;
    toolCallId: string;
    toolName: string;
    turnId: string;
  };
  "joi.turn.repair_requested": {
    avatarId: string;
    inputId: string;
    observedToolCount: number;
    turnId: string;
  };
  "joi.turn.source_fallback": {
    avatarId: string;
    fromSourceId: string;
    inputId: string;
    toSourceId: string;
    turnId: string;
  };
  "joi.turn.completed": {
    avatarId: string;
    durationMs: number;
    inputId: string;
    observedToolCount: number;
    outcomeTools: readonly string[];
    repaired: boolean;
    sourceId: string;
    turnId: string;
  };
  "joi.turn.failed": {
    avatarId: string;
    durationMs: number;
    errorCode: string;
    inputId: string;
    observedToolCount: number;
    outcomeTools: readonly string[];
    repaired: boolean;
    sourceId: string;
    turnId: string;
  };
  "joi.goal.synthesis.started": {
    avatarId: string;
    goalInputId: string;
    inputId: string;
    resultRevision: number;
    turnId: string;
  };
  "joi.goal.synthesis.completed": {
    avatarId: string;
    goalInputId: string;
    inputId: string;
    resultRevision: number;
    turnId: string;
  };
  "joi.goal.outcome.persisted": {
    avatarId: string;
    goalInputId: string;
    resultRevision: number;
  };
  "joi.work.plan.committed": {
    attemptCount: number;
    avatarId: string;
    dependencyCount: number;
    dispatchPlanId: string;
    inputId: string;
    turnId: string;
    waveCount: number;
    workCount: number;
  };
  "joi.work.dispatch_planned": {
    actionId: string;
    avatarId: string;
    dispatchAttemptId: string;
    dispatchPlanId: string;
    outboxId: string;
    partnerId: string;
    partnerRevisionId: string;
    turnId: string;
    workId: string;
  };
  "joi.outbox.claimed": {
    limit: number;
    recordCount: number;
  };
  "joi.outbox.delivery_started": {
    attemptCount: number;
    kind: string;
    outboxId: string;
  };
  "joi.outbox.delivery_completed": {
    attemptCount: number;
    durationMs: number;
    kind: string;
    outboxId: string;
  };
  "joi.outbox.delivery_released": {
    attemptCount: number;
    durationMs: number;
    errorCode: string;
    kind: string;
    outboxId: string;
  };
  "joi.partner.dispatch.started": {
    actionId: string;
    avatarId: string;
    dispatchAttemptId: string;
    kind: string;
    outboxId: string;
    partnerId: string;
    partnerRevisionId: string;
    workId: string;
  };
  "joi.partner.dispatch.skipped": {
    actionId: string;
    dispatchAttemptId: string;
    outboxId: string;
    status: string;
  };
  "joi.partner.run.created": {
    actionId: string;
    agentId?: string;
    avatarId: string;
    dispatchAttemptId: string;
    kind: string;
    runId: string;
    workId: string;
  };
  "joi.partner.instance.started": {
    actionId: string;
    avatarId: string;
    dispatchAttemptId?: string;
    engine: string;
    instanceId: string;
    partnerId: string;
    sessionPolicy: string;
    workId: string;
  };
  "joi.partner.instance.completed": {
    actionId: string;
    avatarId: string;
    dispatchAttemptId?: string;
    durationMs: number;
    instanceId: string;
    status: string;
    workId: string;
  };
  "joi.partner.instance.failed": {
    actionId: string;
    avatarId: string;
    dispatchAttemptId?: string;
    durationMs: number;
    errorCode: string;
    instanceId: string;
    workId: string;
  };
  "joi.partner.result.recorded": {
    actionId: string;
    agentId?: string;
    avatarId: string;
    dispatchAttemptId: string;
    isLate: boolean;
    isAuthoritative: boolean;
    resultId: string;
    runId: string;
    status: string;
    workId: string;
  };
}

export type RuntimeDiagnosticName = keyof RuntimeDiagnosticEventMap;

export interface RuntimeDiagnostics {
  emit<Name extends RuntimeDiagnosticName>(event: Name, fields: Readonly<RuntimeDiagnosticEventMap[Name]>): void;
}

/** Diagnostics are observational only and must never alter product control flow. */
export function emitRuntimeDiagnostic<Name extends RuntimeDiagnosticName>(
  diagnostics: RuntimeDiagnostics | undefined,
  event: Name,
  fields: Readonly<RuntimeDiagnosticEventMap[Name]>,
): void {
  try {
    diagnostics?.emit(event, fields);
  } catch {
    // A diagnostic sink is deliberately isolated from runtime behavior.
  }
}

/** Returns a bounded identifier only; error messages and stacks may contain private content or paths. */
export function runtimeDiagnosticErrorCode(error: unknown): string {
  const candidate = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.name : "unknown_error";
  return candidate.length <= 80 && /^[A-Za-z0-9_.:-]+$/u.test(candidate) ? candidate : "unknown_error";
}
