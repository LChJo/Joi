export interface RuntimeDiagnosticEventMap {
  "joi.input.accepted": {
    attachmentCount: number;
    workbenchBound: boolean;
    inputId: string;
  };
  "joi.input.handling_started": {
    attachmentCount: number;
    workbenchBound: boolean;
    inputId: string;
    status: string;
  };
  "joi.input.scheduler_failed": {
    errorCode: string;
    inputId: string;
  };
  "joi.task.input_started": {
    inputId: string;
  };
  "joi.task.turn_cancel_requested": {
    inputId: string;
  };
  "joi.task.turn_settled": {
    durationMs: number;
    inputId: string;
    outcome: "failed" | "ok";
  };
  "joi.task.orphan_turn_recovered": {
    inputId: string;
    turnId: string;
  };
  "joi.task.input_parked": {
    consecutiveFailures: number;
    inputId: string;
  };
  "joi.harness.map_created": {
    goalInputId: string;
  };
  "joi.harness.review_enqueued": {
    goalInputId: string;
    inputId: string;
    resultRevision: number;
  };
  "joi.harness.feedback_recorded": {
    workbenchId: string;
    goalInputId: string;
  };
  "joi.harness.map_cleared_trivial": {
    goalInputId: string;
  };
  "joi.harness.scan_failed": {
    errorCode: string;
    step: string;
  };
  "joi.actor.component_failed": {
    actorId: string;
    componentName: string;
    errorCode: string;
  };
  "joi.actor.failed": {
    actorId: string;
    errorCode: string;
  };
  "joi.rhythm.tick_failed": {
    errorCode: string;
    service: string;
  };
  "joi.workbench.synthesis_enqueued": {
    workbenchId: string;
    eventId: string;
    workId: string;
  };
  "joi.agent.run_started": {
    workbenchId: string;
    dispatchAttemptId: string;
    kind: string;
    partnerId: string;
  };
  "joi.agent.run_converged": {
    workbenchId: string;
    dispatchAttemptId: string;
    partnerId: string;
    status: string;
  };
  "joi.agent.prepare_failed": {
    workbenchId: string;
    errorCode: string;
    outboxId: string;
    partnerId: string;
  };
  "joi.partner.orphan_found": {
    workbenchId: string;
    dispatchAttemptId: string;
    kind: string;
    partnerId: string;
    runId: string;
  };
  "joi.input.waiting_clarification": {
    inputId: string;
    reasonCode: string;
  };
  "joi.workbench.resolved": {
    workbenchId: string;
    inputId: string;
    resolution: "bound" | "bootstrap" | "created" | "selected";
  };
  "joi.work.dispatch_rejected": {
    inputId: string;
    reasonCode: string;
    turnId: string;
    workbenchId: string;
  };
  "joi.turn.started": {
    workbenchId: string;
    inputId: string;
    modelRevisionId: string;
    sourceId: string;
    sourceRevisionId: string;
    turnId: string;
  };
  "joi.tool.started": {
    workbenchId: string;
    inputId: string;
    sourceId: string;
    toolCallId: string;
    toolName: string;
    turnId: string;
  };
  "joi.tool.finished": {
    workbenchId: string;
    durationMs: number;
    errorCode?: string;
    inputId: string;
    isError: boolean;
    sourceId: string;
    toolCallId: string;
    toolName: string;
    turnId: string;
  };
  "joi.turn.repair_requested": {
    workbenchId: string;
    inputId: string;
    observedToolCount: number;
    turnId: string;
  };
  "joi.turn.source_fallback": {
    workbenchId: string;
    fromSourceId: string;
    inputId: string;
    toSourceId: string;
    turnId: string;
  };
  "joi.turn.completed": {
    workbenchId: string;
    durationMs: number;
    inputId: string;
    observedToolCount: number;
    outcomeTools: readonly string[];
    repaired: boolean;
    sourceId: string;
    turnId: string;
  };
  "joi.turn.failed": {
    workbenchId: string;
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
    workbenchId: string;
    goalInputId: string;
    inputId: string;
    resultRevision: number;
    turnId: string;
  };
  "joi.goal.synthesis.completed": {
    workbenchId: string;
    goalInputId: string;
    inputId: string;
    resultRevision: number;
    turnId: string;
  };
  "joi.goal.outcome.persisted": {
    workbenchId: string;
    goalInputId: string;
    resultRevision: number;
  };
  "joi.work.plan.committed": {
    attemptCount: number;
    workbenchId: string;
    dependencyCount: number;
    dispatchPlanId: string;
    inputId: string;
    turnId: string;
    waveCount: number;
    workCount: number;
  };
  "joi.work.dispatch_planned": {
    actionId: string;
    workbenchId: string;
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
    workbenchId: string;
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
    workbenchId: string;
    dispatchAttemptId: string;
    kind: string;
    runId: string;
    workId: string;
  };
  "joi.partner.instance.started": {
    actionId: string;
    workbenchId: string;
    dispatchAttemptId?: string;
    engine: string;
    instanceId: string;
    partnerId: string;
    sessionPolicy: string;
    workId: string;
  };
  "joi.partner.instance.completed": {
    actionId: string;
    workbenchId: string;
    dispatchAttemptId?: string;
    durationMs: number;
    instanceId: string;
    status: string;
    workId: string;
  };
  "joi.partner.instance.failed": {
    actionId: string;
    workbenchId: string;
    dispatchAttemptId?: string;
    durationMs: number;
    errorCode: string;
    instanceId: string;
    workId: string;
  };
  "joi.partner.result.recorded": {
    actionId: string;
    agentId?: string;
    workbenchId: string;
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
