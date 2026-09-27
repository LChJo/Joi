import type { RemoteDiagnosticCode } from "../../../shared/remote.js";

export interface RuntimeDiagnosticEventMap {
  "joi.remote.connection": {
    code: RemoteDiagnosticCode;
    sequence: number;
  };
  "joi.automation.claimed": {
    count: number;
  };
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
  "joi.input.retried": {
    inputId: string;
    supplemented: boolean;
  };
  "joi.task.input_started": {
    inputId: string;
  };
  "joi.task.turn_cancel_requested": {
    inputId: string;
    reason?: "stalled" | "user_canceled";
  };
  "joi.task.turn_canceled": {
    durationMs: number;
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
  "joi.task.review_recovery_failed": {
    errorCode: string;
  };
  "joi.task.input_parked": {
    consecutiveFailures: number;
    errorCode: string;
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
  "joi.harness.work_recovery_enqueued": {
    attemptNo: number;
    goalInputId: string;
    inputId: string;
    sourceWorkId: string;
  };
  "joi.harness.review_requeued": {
    goalInputId: string;
    inputId: string;
    reasonCode: string;
    resultRevision: number;
  };
  "joi.harness.review_quarantined": {
    goalInputId: string;
    reasonCode: string;
    resultRevision: number;
  };
  "joi.harness.review_auto_cleared": {
    goalInputId: string;
    reasonCode: string;
    resultRevision: number;
  };
  "joi.harness.review_historically_closed": {
    inputId: string;
  };
  /**
   * A goal whose Work is all terminal and whose synthesis fell behind the result set had no scan
   * that could reach it, so it sat in "finalizing" indefinitely and was only ever found by reading
   * the database by hand. Emitted when such a goal is detected and put back in the queue.
   */
  "joi.harness.stalled_synthesis_redriven": {
    goalInputId: string;
    resultRevision: number;
  };
  /**
   * A map was closed while a newer evidence layer was still arriving, which no later scan could
   * reach: its card reported review forever. Emitted when such a map is returned to ACTIVE so the
   * ordinary review path can adopt the layer the close-out outran.
   */
  "joi.harness.map_reopened": {
    goalInputId: string;
    resultRevision: number;
  };
  /**
   * Routes a finished goal's review left open were closed so its map could settle. Recorded
   * because the alternative reading — a goal reporting review while nothing runs — is the same
   * symptom three different defects produce, and this is the one of them that leaves no other
   * trace behind.
   */
  "joi.harness.finished_paths_closed": {
    closed: number;
    goalInputId: string;
  };
  "joi.harness.feedback_recorded": {
    workbenchId: string;
    goalInputId: string;
  };
  "joi.harness.map_cleared_trivial": {
    goalInputId: string;
  };
  "joi.harness.paths_synchronized": {
    closed: number;
    created: number;
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
    consecutiveFailures: number;
    errorCode: string;
    service: string;
  };
  "joi.workbench.synthesis_enqueued": {
    workbenchId: string;
    eventId: string;
    workId: string;
  };
  "joi.workbench.attention_repaired": {
    repaired: number;
    workbenchId: string;
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
  "joi.runtime.tick_failed": {
    errorCode: string;
  };
  "joi.agent.prepare_failed": {
    workbenchId: string;
    errorCode: string;
    outboxId: string;
    partnerId: string;
  };
  "joi.agent.workspace_contended": {
    workbenchId: string;
    dispatchAttemptId: string;
    outboxId: string;
    partnerId: string;
  };
  "joi.agent.resource_queued": {
    workbenchId: string;
    dispatchAttemptId: string;
    outboxId: string;
    partnerId: string;
    reasonCode: string;
  };
  "joi.agent.capacity_queued": {
    workbenchId: string;
    dispatchAttemptId: string;
    partnerId: string;
    reasonCode: string;
  };
  "joi.agent.prepare_exhausted": {
    workbenchId: string;
    dispatchAttemptId: string;
    errorCode: string;
    outboxId: string;
    partnerId: string;
  };
  "joi.agent.lease_lost": {
    workbenchId: string;
    dispatchAttemptId: string;
    partnerId: string;
    workId: string;
  };
  "joi.agent.watchdog_abort": {
    workbenchId: string;
    dispatchAttemptId: string;
    partnerId: string;
  };
  "joi.agent.deadline_grace": {
    workbenchId: string;
    workId: string;
    actionId: string;
    graceMillis: number;
  };
  "joi.agent.run_canceled": {
    workbenchId: string;
    dispatchAttemptId: string;
    partnerId: string;
    workId: string;
  };
  "joi.agent.complete_failed": {
    workbenchId: string;
    dispatchAttemptId: string;
    errorCode: string;
    partnerId: string;
  };
  "joi.agent.converge_stuck_cleared": {
    workbenchId: string;
    dispatchAttemptId: string;
    errorCode: string;
    partnerId: string;
  };
  "joi.partner.orphan_found": {
    workbenchId: string;
    dispatchAttemptId: string;
    kind: string;
    partnerId: string;
    runId: string;
  };
  "joi.partner.orphan_finalize_failed": {
    workbenchId: string;
    dispatchAttemptId: string;
    errorCode: string;
    partnerId: string;
    runId: string;
  };
  "joi.input.waiting_clarification": {
    inputId: string;
    reasonCode: string;
  };
  "joi.harness.continuation_decision_requested": {
    goalInputId: string;
    resultRevision: number;
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
    modelRevisionId?: string;
    sourceId?: string;
    sourceRevisionId?: string;
    toolCapabilityProven?: boolean;
    turnId: string;
  };
  "joi.action.applied": {
    actionId: string;
    inputId: string;
    turnId: string;
    workbenchId: string;
    workId: string;
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
  "joi.turn.tool_capability_proven": {
    modelRevisionId: string;
    sourceId: string;
    sourceRevisionId: string;
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
    disposition: "BLOCKED" | "COMPLETED" | "CONTINUE";
    workbenchId: string;
    goalInputId: string;
    inputId: string;
    resultRevision: number;
    turnId: string;
  };
  "joi.goal.outcome.persisted": {
    disposition: "BLOCKED" | "COMPLETED" | "CONTINUE";
    workbenchId: string;
    goalInputId: string;
    resultRevision: number;
  };
  "joi.work.plan.committed": {
    attemptCount: number;
    workbenchId: string;
    deniedCount: number;
    dependencyCount: number;
    dispatchPlanId: string;
    inputId: string;
    turnId: string;
    waveCount: number;
    workCount: number;
  };
  "joi.work.plan_policy_denied": {
    workbenchId: string;
    dispatchPlanId: string;
    partnerId: string;
    reasonCode: string;
    turnId: string;
    workId: string;
  };
  "joi.work.dependency_cascade": {
    workbenchId: string;
    canceledWorkIds: string[];
    reasonCode: string;
    sourceWorkId: string;
  };
  "joi.partner.brief_checks_filtered": {
    workbenchId: string;
    dispatchAttemptId: string;
    droppedChecks: number;
    partnerId: string;
    workId: string;
  };
  "joi.a2a.invocation_started": {
    agentConnectionId: string;
    invocationId: string;
    messageId: string;
  };
  "joi.a2a.invocation_settled": {
    durationMs: number;
    invocationId: string;
    status: string;
  };
  "joi.a2a.breaker_opened": {
    breakerKey: string;
    invocationId: string;
    lastStatus: number;
    openUntil: string;
  };
  "joi.a2a.recover_failed": {
    errorCode: string;
    invocationId: string;
  };
  "joi.a2a.recover_not_ready": {
    invocationId: string;
    status: string;
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
  "joi.work.canceled": {
    workbenchId: string;
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
  "joi.partner.cli_probe.settled": {
    durationMs: number;
    engine: string;
    outcome: "failed" | "ready";
    phase: "create" | "invoke" | "resolve";
    reasonCode?: string;
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
    /** Truncated provider/engine detail for local debugging; never shown in work results. */
    errorDetail?: string;
    instanceId: string;
    workId: string;
  };
  "joi.partner.dispatch.preflight_failed": {
    actionId: string;
    workbenchId: string;
    dispatchAttemptId?: string;
    durationMs: number;
    hasRequestedInstanceId: boolean;
    partnerId: string;
    phase: string;
    reasonCode: string;
    retryable: boolean;
    sideEffectState: string;
    workId: string;
  };
  "joi.partner.model_override_fallback": {
    activeModelId: string;
    partnerId: string;
    pinnedModelId: string;
    sourceId: string;
  };
  /**
   * A partner's system prompt carries Workbench evidence, knowledge and Skill sections that share
   * the model window with the message list, and only the message list was bounded. An oversized
   * background section therefore reached the provider intact and came back as an opaque budget
   * rejection, or as a model that answered with silence. Recorded whenever the background was
   * trimmed to the budget, so the cause stays visible instead of only its downstream symptom.
   */
  "joi.partner.system_prompt_bounded": {
    backgroundChars: number;
    budgetChars: number;
    workbenchId: string;
    workId: string;
  };
  /**
   * A partner run summarized the part of its transcript that no longer fits the request. This is
   * the ordinary way a long run keeps its history: the summary replaces those messages in every
   * later request, and the run's own transcript is left intact for the result body and the UI
   * timeline. `tokensBefore` is the estimate that tripped the threshold, not a billed figure.
   */
  "joi.partner.context_compacted": {
    compactedMessages: number;
    count: number;
    tokensBefore: number;
  };
  /**
   * The summary call failed, so the history could not be compacted this request. The run continues
   * on the last usable checkpoint plus whatever bound applied; recorded because a route that keeps
   * failing here is silently back to losing history, which is the defect this replaced.
   */
  "joi.partner.context_summary_failed": {
    reasonCode: string;
  };
  /**
   * A request had to drop history outright — summary unavailable, or a summary that still left the
   * request over budget. The messages are gone from that request and the model was told so in the
   * request itself; recorded so the honest-degradation path is never mistaken for silent trimming.
   *
   * Both counts cover only what no summary stands in for: a checkpoint that already exists travels
   * with the request, so the messages it covers are represented rather than lost and are not
   * reported here. Counting from the anchors instead would price ordinary compression as data loss.
   */
  "joi.partner.context_truncated": {
    omittedChars: number;
    omittedMessages: number;
  };
  /**
   * A run kept calling tools while changing nothing in its workspace, and has been told so. This is
   * the warning shot, not a failure: the run continues, and a run that was merely reading a great
   * deal can say so and carry on. Recorded because the shape it detects — busy but unproductive —
   * is invisible to every other guard the runtime has.
   */
  "joi.partner.progress_stalled": {
    toolCallsWithoutChange: number;
  };
  /**
   * A run that had already been warned kept changing nothing and was closed out, or reached the
   * tool-call ceiling. The partial work is kept and the run converges as a failure rather than
   * being left to spin; recorded with which limit fired so the two are never confused.
   */
  "joi.partner.run_closed_out": {
    reason: "no-deliverable" | "tool-call-ceiling";
    toolCallsWithoutChange: number;
  };
  "joi.partner.skills.injected": {
    actionId: string;
    instanceId: string;
    instructionChars: number;
    partnerId: string;
    skillCount: number;
    workbenchId: string;
    workId: string;
  };
  "joi.partner.skills.failed": {
    actionId: string;
    errorCode: string;
    errorDetail?: string;
    instanceId: string;
    partnerId: string;
    skillCount: number;
    workbenchId: string;
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
    phase?: string;
    reasonCode?: string;
    retryable?: boolean;
    runId: string;
    sideEffectState?: string;
    status: string;
    workId: string;
  };
  /**
   * Every path that declines to run an evolution batch used to be a bare `return`, so "no evolution
   * ever happened" was indistinguishable from "the scheduler is broken". Emitted only when the
   * signature changes, otherwise the 2s tick would flood the log.
   */
  "joi.evolution.gate_skipped": {
    evaluable: number;
    reason: "not_idle" | "no_candidate" | "evidence_below_threshold" | "aborted";
    thresholdEvaluable: number;
    thresholdFailed: number;
    verificationFailed: number;
    workbenchCount: number;
  };
  "joi.evolution.evidence_recorded": {
    goalInputId: string;
    outcome: string;
    /** Present only when a later scan upgraded an earlier, weaker classification. */
    previousOutcome?: string;
    workbenchId: string;
  };
  "joi.evolution.batch_step_started": {
    batchId: string;
    callId: string;
    phase: string;
    workbenchId: string;
  };
  "joi.evolution.call_failed": {
    callId: string;
    consecutiveFailures: number;
    parkedDay: string;
    workbenchId: string;
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
  // Prefer the structured partner-run reason code, then an explicit code property, then the
  // error name. The message itself is never used: free text would leak into diagnostics and
  // a bare `new Error(...)` would otherwise collapse every distinct failure into "Error".
  const carrier = error !== null && typeof error === "object" ? (error as { partnerRunFailure?: unknown }).partnerRunFailure : undefined;
  const carriedReason = carrier !== null && typeof carrier === "object" && typeof (carrier as { reasonCode?: unknown }).reasonCode === "string"
    ? (carrier as { reasonCode: string }).reasonCode
    : undefined;
  const candidate = carriedReason !== undefined && carriedReason !== ""
    ? carriedReason
    : error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : error instanceof Error ? error.name : "unknown_error";
  return candidate.length <= 80 && /^[A-Za-z0-9_.:-]+$/u.test(candidate) ? candidate : "unknown_error";
}

/** Truncated engine-provided detail carried with an error, for local diagnostics only. */
export function runtimeDiagnosticErrorDetail(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("detail" in error)) return undefined;
  const detail = (error as { detail?: unknown }).detail;
  if (typeof detail !== "string") return undefined;
  const trimmed = detail.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, 240);
}
