import { DomainError } from "../../domain/errors.js";
import type { EvolutionService } from "../evolution/evolution-service.js";
import type { WorkbenchCatalog } from "../ports/workbench-context.js";
import type { JoiAttachmentPort } from "../ports/managed-file-ports.js";
import type { WorkbenchRoutingRuntime, JoiCoordinatorStore, ReasoningFailureClassifier } from "../ports/joi-coordinator.js";
import { buildJoiAttachmentContext } from "./joi-attachment-context.js";
import { composeJoiContinuationBackground } from "./joi-continuation-prompt.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";
import type { JoiReasoningOutcome, PrimaryReasoningRuntime } from "../ports/primary-reasoning-runtime.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
  type RuntimeDiagnostics,
} from "../ports/runtime-diagnostics.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";
import type { WorkbenchRegistryService } from "./workbench-registry-service.js";
import type { WorkbenchWorkspaceService } from "./workbench-workspace-service.js";
import { buildJoiSystemPrompt } from "./joi-system-prompt.js";
import { resolveWorkbenchAssignment } from "./workbench-assignment.js";
import { COMPLETION_SUMMARY_LIMIT, normalizeCompletionSummary } from "../partners/agent-conversation-presentation.js";
import { DISPATCH_POLICY_REASONS } from "../work/dispatch-policy.js";
import type { WorkOrchestrationService } from "../work/work-orchestration-service.js";
import type { GoalRequirementsRepository } from "../ports/goal-requirements.js";
import { renderGoalRequirements } from "../../domain/work/goal-requirements.js";

interface SourcePin {
  modelCapability?: "release-tested" | "custom-unverified-tools";
  modelId: string;
  modelRevisionId: string;
  sourceId: string;
  sourceRevisionId: string;
  toolCapabilityProven?: boolean;
  turnId: string;
}

const COMMITTED_OUTCOME_TOOL_NAMES = new Set([
  "workbench_suggest_archive",
  "workbench_suggest_merge",
  "schedule_plan",
  "create_automation",
  "update_automation",
  "delete_automation",
  "run_automation_now",
  "goal_resume",
  "turn_complete",
  "user_ask",
  "work_cancel",
  "work_dispatch",
  "work_supplement",
  "work_reassign",
  "work_resume",
  "work_update_brief",
  "work_wait",
]);

// A lookup does not make replay unsafe. Keep this classification at the coordinator
// boundary so recovery can distinguish read-only inspection from durable mutations.
const REPLAY_SAFE_TOOL_NAMES = new Set([
  "attachment_read",
  "model_list_sources",
  "partner_inspect_revision",
  "partner_list_available",
  "partner_list_instances",
  "partner_list_skills",
  "work_read_result",
  "work_read_evidence",
  "context_read_history",
  "workbench_list_summaries",
  "list_automations",
  "get_automation",
  "goal_read_inputs",
  "goal_update_requirements",
  "work_list_goal",
  "work_read_brief",
]);

const OUTCOME_REPAIR_PROMPT = [
  "[joi completion repair] Your preceding response used tools but did not commit an outcome.",
  "Continue the same persisted request now; do not repeat a lookup-only answer or merely describe future work.",
  "For executable AFK work, call work_dispatch. If user judgement is genuinely required, call user_ask.",
  "Only when no execution is requested and the response is already complete may you call turn_complete with the matching outcome.",
].join(" ");

// These tools persist map facts without scheduling Work or invoking external systems.
const INTERNAL_REVIEW_TOOL_NAMES = new Set([
  "harness_name_destination", "harness_chart_path", "harness_record_decision", "harness_note_fog",
]);

const SYNTHESIS_OUTCOME_REPAIR_PROMPT = [
  "[joi completion repair] This goal-result synthesis did not commit an outcome.",
  "Use the existing evidence; do not repeat completed work or merely describe future work.",
  "Call turn_complete through the real tool-call mechanism with RESULT_SYNTHESIZED when the evidence answers the goal, RESULT_CONTINUE for a concrete safe evidence gap, or RESULT_BLOCKED for a gap requiring user intervention.",
  "Then provide the complete visible deliverable and explain any material coverage gap.",
  "If structured tools are unavailable, start the response with exactly [joi synthesis outcome=RESULT_SYNTHESIZED], [joi synthesis outcome=RESULT_CONTINUE], or [joi synthesis outcome=RESULT_BLOCKED], followed by a newline and the complete deliverable. This is a synthesis decision, not a tool call.",
].join(" ");

const SYNTHESIS_TEXT_DECISION_INSTRUCTIONS = "For this goal-result synthesis, use the existing evidence and finish without repeating completed work when it already answers the goal. You may submit a text-only decision instead of calling a tool: start with exactly [joi synthesis outcome=RESULT_SYNTHESIZED], [joi synthesis outcome=RESULT_CONTINUE], or [joi synthesis outcome=RESULT_BLOCKED], then a newline and the complete deliverable with any material gaps. Use RESULT_SYNTHESIZED only when evidence answers the goal, RESULT_CONTINUE only for a concrete safe next evidence layer, and RESULT_BLOCKED when user intervention is essential. Do not emit tool-call markup.";

function synthesisTextDecision(text: string): { outcome: "RESULT_SYNTHESIZED" | "RESULT_CONTINUE" | "RESULT_BLOCKED"; body: string } | undefined {
  const match = /^\[joi synthesis outcome=(RESULT_SYNTHESIZED|RESULT_CONTINUE|RESULT_BLOCKED)\]\r?\n([\s\S]+)$/u.exec(text.trim());
  if (match === null || containsLeakedToolCallMarkup(text)) return undefined;
  const body = match[2]?.trim() ?? "";
  if (body === "") return undefined;
  return { outcome: match[1] as "RESULT_SYNTHESIZED" | "RESULT_CONTINUE" | "RESULT_BLOCKED", body };
}

const EMPTY_COMPLETION_REPAIR_PROMPT = [
  "[joi completion repair] Your preceding direct response did not contain a visible final answer.",
  "Continue the same persisted request without repeating side effects or lookup calls.",
  "Emit the concise final answer for the user now; if tools were used, keep the already committed outcome.",
].join(" ");

const LEAKED_TOOL_CALL_REPAIR_PROMPT = [
  "[joi tool-call repair] Your preceding response wrote tool-call markup as plain text (DSML-style tags), so none of those tools actually ran.",
  "Re-issue the tool calls through the real tool-call mechanism; never write markup as message text.",
  "If the markup was merely quoted content rather than an attempted tool call, restate the answer in plain text without any markup.",
].join(" ");

// Models behind some gateways render tool calls as literal special-token text instead of
// structured calls. The turn then looks like a finished prose answer while every intended
// tool silently never ran, so it must not be treated as a direct answer.
const LEAKED_TOOL_CALL_PATTERNS = [
  /<[｜|]{1,2}\s*(?:DSML|tool|calls?|invoke)/iu,
  /[｜|]{1,2}\s*invoke\s+name\s*=/iu,
] as const;

function containsLeakedToolCallMarkup(text: string): boolean {
  return LEAKED_TOOL_CALL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether a failed Turn's transcript should be dropped from its session.
 *
 * Only a Turn whose input is re-queued is worth taking back, and the schedule makes that call by
 * exactly this condition: `failTurn` re-queues an input whose Turn committed nothing, and consumes
 * the rest for good. For those, the transcript is the only account the next Turn has of what this
 * one already dispatched, so dropping it would erase real work. A cancel re-runs nothing either.
 *
 * Kept as a function so the compiler does not narrow the caller's flag to its initial literal —
 * the assignment that can make it true happens in a stream callback.
 */
function shouldRollbackTurn(sideEffectStarted: boolean, signal: AbortSignal | undefined): boolean {
  return !sideEffectStarted && !signal?.aborted;
}

// A deterministic model-side failure (protocol garbage, capacity mismatch) should not be
// rediscovered by the very next Turn: skip the route for this window.
const PROTOCOL_AVOID_MILLIS = 30 * 60_000;
// Consecutive failed Turns on one goal poison the shared session: each retry appends the
// previous failure's transcript, so the next retry reproduces it. After this many, the
// next attempt starts from a fresh session generation instead.
const SESSION_RESET_AFTER_CONSECUTIVE_FAILURES = 4;

const DISPATCH_CLARIFICATION_REASONS = new Set([
  DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady,
  "partner_selection_required",
  "work_dispatch_failed",
]);

export class JoiCoordinator {
  #sessionFailures = new Map<string, number>();
  #sessionGenerations = new Map<string, number>();

  constructor(private readonly dependencies: {
    evolution?: Pick<EvolutionService, "strategyForGoal">;
    requirements?: GoalRequirementsRepository;
    workbenches: WorkbenchCatalog;
    workbenchRegistry?: Pick<WorkbenchRegistryService, "create">;
    /** Current workspace binding, injected into the system prompt so the model never re-asks for a bound directory. */
    workspaces?: Pick<WorkbenchWorkspaceService, "current">;
    /** Verified attachment reader; without it attachments stay metadata-only. */
    attachments?: Pick<JoiAttachmentPort, "read">;
    automation?: { promptForExecution(routineId: string): Promise<{ prompt: string } | null> };
    clock: Clock;
    diagnostics?: RuntimeDiagnostics;
    failureClassifier?: ReasoningFailureClassifier;
    ids: IdGenerator;
    events?: DurableUiEventEmitter;
    router: WorkbenchRoutingRuntime;
    runtime: PrimaryReasoningRuntime;
    sources: {
      /** Skips a deterministically broken route for a window so the next Turn picks another. */
      avoidSource?(sourceId: string, millis: number): void;
      selectFallback?(input: {
        currentSourceId: string;
        failure: SourceFailureKind;
        formalOutputStarted: boolean;
        sideEffectStarted: boolean;
        turnId: string;
      }): Promise<SourcePin | null>;
      recordToolProof?(input: { modelRevisionId: string; provenAt: string; sourceRevisionId: string }): Promise<void>;
      selectInitial(turnId: string): Promise<SourcePin>;
    };
    store: JoiCoordinatorStore;
    work?: Pick<WorkOrchestrationService, "resume">;
  }) {}

  /** Spread into buildJoiSystemPrompt arguments; empty when no workspace service or binding exists. */
  private async currentWorkspaceSummary(workbenchId: string): Promise<{ workspace?: { displayName: string; kind: string; status: string } }> {
    const workspace = await this.dependencies.workspaces?.current(workbenchId);
    return workspace === null || workspace === undefined ? {} : { workspace: { displayName: workspace.displayName, kind: workspace.kind, status: workspace.status } };
  }

  async handle(inputId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DomainError("joi_turn_aborted", "joi turn was canceled before it started.");
    const input = await this.dependencies.store.loadInput(inputId);
    if (input === null) throw new DomainError("joi_input_not_found", "joi input was not found.");
    if (input.status === "CONSUMED") return;
    const automationPrompt = input.automationExecutionPrompt ?? (input.automationRoutineId === undefined || this.dependencies.automation === undefined
      ? undefined
      : (await this.dependencies.automation.promptForExecution(input.automationRoutineId))?.prompt);
    if (input.automationRoutineId !== undefined && automationPrompt === undefined) throw new DomainError("automation_routine_not_found", "The scheduled Routine is unavailable.");
    let requestText = automationPrompt ?? input.continuationPrompt ?? input.body;
    const backgroundContext = composeJoiContinuationBackground(input);
    const backgroundContextVariants = backgroundContext === undefined ? [] : [...new Set([
      composeJoiContinuationBackground(input, 40_000), composeJoiContinuationBackground(input, 60_000),
    ])].filter((value): value is string => value !== undefined && value !== backgroundContext);
    const handleStartedAt = this.dependencies.clock.now().getTime();
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.handling_started", {
      attachmentCount: input.attachments?.length ?? 0,
      workbenchBound: input.workbenchId !== undefined,
      inputId,
      status: input.status,
    });
    const workbenches = await this.dependencies.workbenches.listSummaries();
    let workbenchId = input.workbenchId;
    let workbenchResolution: "bound" | "bootstrap" | "created" | "selected" = "bound";
    if (workbenchId === undefined) {
      const assignment = await resolveWorkbenchAssignment({
        canCreate: this.dependencies.workbenchRegistry !== undefined,
        requestText,
        router: this.dependencies.router,
        workbenches,
      });
      if (assignment.action === "clarify") {
        await this.dependencies.store.requireClarification(inputId, assignment.reasonCode, undefined, undefined, assignment.proposal);
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.waiting_clarification", {
          inputId,
          reasonCode: assignment.reasonCode,
        });
        await this.dependencies.events?.emit("joi.message.clarification_required", inputId, { inputId });
        return;
      }
      workbenchId = assignment.workbenchId;
      workbenchResolution = assignment.resolution;
    }
    const workbench = await this.dependencies.workbenches.getWorkbench(workbenchId);
    if (workbench === null) {
      await this.dependencies.store.requireClarification(inputId, "workbench_not_found");
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.waiting_clarification", {
        inputId,
        reasonCode: "workbench_not_found",
      });
      return;
    }
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.workbench.resolved", { workbenchId, inputId, resolution: workbenchResolution });
    const turnId = this.dependencies.ids.next("turn");
    const goalSynthesis = input.goalInputId !== undefined && input.resultRevision !== undefined
      ? { goalInputId: input.goalInputId, resultRevision: input.resultRevision }
      : null;
    const isGoalSynthesis = goalSynthesis !== null;
    // New submissions are independent goals even when their text and Workbench match.
    // Clarification/recovery keep the persisted input id; internal reviews keep their goal id.
    const goalId = input.goalInputId ?? input.inputId;
    const contract = await this.dependencies.requirements?.ensure({
      goalInputId: goalId, workbenchId, ...(automationPrompt === undefined ? {} : { executionPrompt: automationPrompt }),
      ...(input.automationExecutionId === undefined ? {} : { executionKey: input.automationExecutionId }),
    });
    if (input.automationRoutineId !== undefined && contract?.executionPrompt !== undefined) requestText = contract.executionPrompt;
    const requirementsStore = this.dependencies.requirements;
    let turnStrategyInstructions = "";
    const refreshRequiredContext = requirementsStore === undefined ? undefined : async () => {
      const current = await requirementsStore.load(goalId, workbenchId);
      if (current === null) return "";
      const strategy = this.dependencies.evolution?.strategyForGoal(workbenchId, goalId, pin,
        { requirementsReady: current.status === "READY", requirementCount: current.requirements.length });
      const addition = strategy !== undefined && strategy.instructions !== turnStrategyInstructions ? `\nRuntime method (subordinate to user requirements and fixed gates):\n${strategy.instructions}` : "";
      return `${renderGoalRequirements(current)}${addition}`;
    };
    // A poisoned session is part of why retries reproduce their own failure; bump the
    // generation after consecutive flops so the next attempt starts with clean history.
    let sessionGeneration = this.#sessionGenerations.get(goalId) ?? 0;
    if ((this.#sessionFailures.get(goalId) ?? 0) >= SESSION_RESET_AFTER_CONSECUTIVE_FAILURES) {
      sessionGeneration += 1;
      this.#sessionGenerations.set(goalId, sessionGeneration);
      this.#sessionFailures.delete(goalId);
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.session.reset", {
        generation: sessionGeneration,
        goalId,
        inputId,
      });
    }
    const sessionBase = isGoalSynthesis
      ? `joi_synthesis_snapshot_v1:${workbenchId}:${goalId}:r${String(input.resultRevision)}:q${String(input.requirementsRevision ?? contract?.revision ?? 0)}`
      : `joi_session:${workbenchId}:${goalId}`;
    const sessionId = sessionGeneration === 0 ? sessionBase : `${sessionBase}#${String(sessionGeneration)}`;
    if (input.resolvedAction !== undefined && contract === undefined) {
      if (this.dependencies.work === undefined || this.dependencies.store.completeResolvedAction === undefined) {
        throw new DomainError("joi_action_resume_unavailable", "The persisted user action cannot be resumed right now.");
      }
      await this.dependencies.store.createTurn({
        workbenchId,
        createdAt: this.dependencies.clock.now().toISOString(),
        inputId,
        sessionId,
        turnId,
      });
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.started", { workbenchId, inputId, turnId });
      await this.dependencies.events?.emit("joi.turn.started", turnId, { workbenchId, inputId, turnId });
      try {
        await this.dependencies.work.resume({
          actionId: input.resolvedAction.actionId,
          workbenchId,
          turnId,
          workId: input.resolvedAction.workId,
        });
        await this.dependencies.store.completeResolvedAction({
          actionId: input.resolvedAction.actionId,
          inputId,
          turnId,
        });
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.action.applied", {
          actionId: input.resolvedAction.actionId,
          inputId,
          turnId,
          workbenchId,
          workId: input.resolvedAction.workId,
        });
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.completed", {
          workbenchId,
          durationMs: Math.max(0, this.dependencies.clock.now().getTime() - handleStartedAt),
          inputId,
          observedToolCount: 0,
          outcomeTools: ["work_resume"],
          repaired: false,
          sourceId: "persisted-user-action",
          turnId,
        });
        await this.dependencies.events?.emit("joi.turn.completed", turnId, { workbenchId, inputId, turnId });
        return;
      } catch (error) {
        await this.dependencies.store.failTurn?.(inputId, turnId);
        throw error;
      }
    }
    const abortRuntime = () => {
      try {
        this.dependencies.runtime.abort(sessionId);
      } catch {
        // The session may not exist yet; the turn's catch block will retry the cleanup.
      }
    };
    if (signal?.aborted) abortRuntime();
    signal?.addEventListener("abort", abortRuntime, { once: true });
    let pin = await this.dependencies.sources.selectInitial(turnId);
    await this.dependencies.store.createTurn({
      workbenchId,
      createdAt: this.dependencies.clock.now().toISOString(),
      inputId,
      modelRevisionId: pin.modelRevisionId,
      // The revision the turn opens against. A turn that never calls a versioned tool has no
      // other way to record one, and it still has to end on the contract it started from.
      ...(contract === undefined ? {} : { requirementsRevision: contract.revision }),
      sessionId,
      sourceRevisionId: pin.sourceRevisionId,
      turnId,
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.started", {
      workbenchId,
      inputId,
      modelRevisionId: pin.modelRevisionId,
      sourceId: pin.sourceId,
      sourceRevisionId: pin.sourceRevisionId,
      toolCapabilityProven: pin.toolCapabilityProven === true,
      turnId,
    });
    if (goalSynthesis !== null) emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.goal.synthesis.started", {
      workbenchId,
      goalInputId: goalSynthesis.goalInputId,
      inputId,
      resultRevision: goalSynthesis.resultRevision,
      turnId,
    });
    await this.dependencies.events?.emit("joi.turn.started", turnId, { workbenchId, inputId, turnId });
    let formalOutputStarted = false;
    // Only a trusted pre-submission rejection resolves a mutating call as having no effect.
    // SDK errors and unfinished calls retain their protection, including postcommit failures.
    const unsafeToReplayToolCalls = new Set<string>();
    const replayState = { uncertain: false, rejected: false };
    const sideEffectStarted = () => replayState.uncertain || unsafeToReplayToolCalls.size > 0;
    const pendingReviewEffects = new Map<string, string>();
    const reviewEffects = { unsafe: false };
    const observedToolCalls = new Set<string>();
    const toolStartedAt = new Map<string, number>();
    const committedOutcomeTools = new Set<string>();
    let committedTurnOutcome: JoiReasoningOutcome | undefined;
    let committedSynthesisState: GoalSynthesisDraft | undefined;
    const attemptedSources = new Set<string>();
    let completionRepairAttempted = false;
    let toolLeakRepairAttempted = false;
    let completionText = "";
    let dispatchFailureReason: string | undefined;
    let prompt = backgroundContext === undefined ? requestText : `Current continuation request:\n${requestText}`;
    if (isGoalSynthesis) prompt += `\n\n${SYNTHESIS_TEXT_DECISION_INSTRUCTIONS}`;
    if (input.resolvedAction !== undefined && contract !== undefined) {
      prompt += `\nPersisted user action: actionId=${input.resolvedAction.actionId} workId=${input.resolvedAction.workId}. Review current requirements and work_read_brief, then apply work_resume with this stable actionId and complete updated instructions; do not replay a resolved action.`;
    }
    let turnImages: readonly { data: string; mimeType: string }[] | undefined;
    let turnAttachmentIds: readonly string[] | undefined;
    if (input.attachments !== undefined && input.attachments.length > 0 && this.dependencies.attachments !== undefined) {
      const attachments = this.dependencies.attachments;
      const attachmentContext = await buildJoiAttachmentContext({
        attachments: input.attachments,
        reader: (attachmentId) => attachments.read(attachmentId),
      });
      if (attachmentContext.promptAddendum !== "") prompt = `${prompt}\n\n${attachmentContext.promptAddendum}`;
      turnImages = attachmentContext.images.length === 0 ? undefined : attachmentContext.images;
      turnAttachmentIds = attachmentContext.attachmentIds;
    }
    try {
      for (;;) {
        if (signal?.aborted) throw new DomainError("joi_turn_aborted", "joi turn was canceled.");
        attemptedSources.add(pin.sourceId);
        const strategy = this.dependencies.evolution?.strategyForGoal(workbenchId, goalId, pin,
          contract === undefined ? undefined : { requirementsReady: contract.status === "READY", requirementCount: contract.requirements.length });
        turnStrategyInstructions = strategy?.instructions ?? "";
      try {
        let attemptCompletionText = "";
        // Per-pass facts: a repair pass must be judged on its own output, not on the
        // cumulative history of earlier passes in the same Turn. Held in an object so the
        // compiler does not narrow them to their initial literals — the assignments that
        // can make them true happen in the stream callback below.
        const pass = { committedOutcome: false, observedToolCalls: 0 };
        const finishedTurnIds = new Set<string>();
        await this.dependencies.runtime.startTurn({
            ...(contract === undefined
              ? input.synthesisContext === undefined ? {} : { requiredContext: input.synthesisContext.originalRequest }
              : { requiredContext: renderGoalRequirements(contract) }),
            ...(refreshRequiredContext === undefined ? {} : { refreshRequiredContext }),
            workbenchId,
            ...(backgroundContext === undefined ? {} : { backgroundContext }),
            ...(backgroundContextVariants.length === 0 ? {} : { backgroundContextVariants }),
            ...(turnAttachmentIds === undefined ? {} : { attachmentIds: turnAttachmentIds }),
            ...(input.goalInputId === undefined ? {} : { goalInputId: input.goalInputId }),
            ...(turnImages === undefined ? {} : { images: turnImages }),
            inputId,
            modelId: pin.modelId,
            modelRevisionId: pin.modelRevisionId,
            onEvent: (event) => {
              if (event.type === "turn_finished") finishedTurnIds.add(event.turnId);
              if (event.type === "text_delta" && event.delta.length > 0) {
                formalOutputStarted = true;
                if (attemptCompletionText.length < COMPLETION_SUMMARY_LIMIT) {
                  attemptCompletionText += event.delta.slice(0, COMPLETION_SUMMARY_LIMIT - attemptCompletionText.length);
                }
              }
              if (event.type === "tool_started") {
                if (!REPLAY_SAFE_TOOL_NAMES.has(event.toolName)) {
                  if (pendingReviewEffects.has(event.toolCallId)) reviewEffects.unsafe = true;
                  if (unsafeToReplayToolCalls.has(event.toolCallId)) replayState.uncertain = true;
                  pendingReviewEffects.set(event.toolCallId, event.toolName);
                }
                observedToolCalls.add(event.toolCallId);
                pass.observedToolCalls += 1;
                toolStartedAt.set(event.toolCallId, this.dependencies.clock.now().getTime());
                if (!REPLAY_SAFE_TOOL_NAMES.has(event.toolName)) unsafeToReplayToolCalls.add(event.toolCallId);
                emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.tool.started", {
                  workbenchId,
                  inputId,
                  sourceId: pin.sourceId,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  turnId,
                });
              }
              if (event.type === "tool_finished") {
                if (!REPLAY_SAFE_TOOL_NAMES.has(event.toolName)) {
                  const startedTool = pendingReviewEffects.get(event.toolCallId);
                  pendingReviewEffects.delete(event.toolCallId);
                  const rejected = startedTool === event.toolName && event.replaySafeRejection === true;
                  if (startedTool !== event.toolName) replayState.uncertain = true;
                  if (rejected && event.toolName === "work_dispatch") {
                    unsafeToReplayToolCalls.delete(event.toolCallId);
                    replayState.rejected = true;
                  }
                  if (startedTool !== event.toolName || !(rejected
                    || !event.isError && INTERNAL_REVIEW_TOOL_NAMES.has(event.toolName))) reviewEffects.unsafe = true;
                }
                const finishedAt = this.dependencies.clock.now().getTime();
                const startedAt = toolStartedAt.get(event.toolCallId) ?? finishedAt;
                emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.tool.finished", {
                  workbenchId,
                  durationMs: Math.max(0, finishedAt - startedAt),
                  ...(event.reasonCode === undefined ? {} : { errorCode: event.reasonCode }),
                  inputId,
                  isError: event.isError,
                  sourceId: pin.sourceId,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  turnId,
                });
                toolStartedAt.delete(event.toolCallId);
                if (event.toolName === "work_dispatch") {
                  // Reflect the latest dispatch outcome: a later successful dispatch in the same
                  // Turn clears an earlier failure so a corrected retry is not wrongly failed.
                  dispatchFailureReason = event.isError || event.reasonCode !== undefined
                    ? event.reasonCode ?? "tool_execution_error"
                    : undefined;
                }
              }
              if (event.type === "tool_finished" && !event.isError && event.replaySafeRejection !== true && COMMITTED_OUTCOME_TOOL_NAMES.has(event.toolName)) {
                committedOutcomeTools.add(event.toolName);
                pass.committedOutcome = true;
                if (event.outcome !== undefined) committedTurnOutcome = event.outcome;
                if (event.toolName === "turn_complete") committedSynthesisState = event.synthesisState;
              }
              if (formalOutputStarted || sideEffectStarted()) {
                void this.dependencies.store.recordTurnProgress?.(turnId, { formalOutputStarted, sideEffectStarted: sideEffectStarted() });
              }
            },
            prompt,
            sessionId,
            sourceId: pin.sourceId,
            sourceRevisionId: pin.sourceRevisionId,
            systemPrompt: buildJoiSystemPrompt({
              ...(isGoalSynthesis ? { synthesisInstructions: SYNTHESIS_TEXT_DECISION_INSTRUCTIONS } : {}),
              ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
              workbenchName: workbench.profile.name,
              ...(pin.modelCapability === undefined || pin.toolCapabilityProven === true ? {} : { modelCapability: pin.modelCapability }),
              personaSummary: workbench.profile.personaSummary,
              projectLabel: workbench.project.label,
              scopeSummary: workbench.profile.scopeSummary,
              taskContextSummary: `Current goal: ${goalId}. Use only this goal's request and execution evidence.`,
              strategyInstructions: strategy?.instructions,
              ...(await this.currentWorkspaceSummary(workbenchId)),
            }),
            turnId,
          });
          if (normalizeCompletionSummary(attemptCompletionText) !== "") completionText = attemptCompletionText;
          if (signal?.aborted) throw new DomainError("joi_turn_aborted", "joi turn was canceled.");
          if (dispatchFailureReason !== undefined) {
            if (!DISPATCH_CLARIFICATION_REASONS.has(dispatchFailureReason)) {
              throw new DomainError(dispatchFailureReason, "Work dispatch failed before a recoverable plan was committed.");
            }
            await this.dependencies.store.completeInput(inputId, turnId);
            emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.completed", {
              workbenchId,
              durationMs: Math.max(0, this.dependencies.clock.now().getTime() - handleStartedAt),
              inputId,
              observedToolCount: observedToolCalls.size,
              outcomeTools: [],
              repaired: completionRepairAttempted,
              sourceId: pin.sourceId,
              turnId,
            });
            await this.dependencies.events?.emit("joi.turn.completed", turnId, { workbenchId, inputId, turnId });
            return;
          }
          // AC-26 gates the FIRST Turn of an unproven custom model only: once any Turn of the
          // pinned revision pair demonstrated structured tool calling, a later direct answer
          // (zero tool calls) is a valid outcome instead of a capability failure.
          const textDecision = isGoalSynthesis && shouldRollbackTurn(sideEffectStarted(), signal) && !pass.committedOutcome
            ? synthesisTextDecision(attemptCompletionText) : undefined;
          if (textDecision !== undefined) {
            committedTurnOutcome = textDecision.outcome;
            completionText = textDecision.body;
          }
          if (!isGoalSynthesis && pin.modelCapability === "custom-unverified-tools" && pin.toolCapabilityProven !== true && observedToolCalls.size === 0) {
            throw new DomainError("custom_model_tool_capability_unverified", "Custom model did not demonstrate structured tool calling.");
          }
          // A pass that rendered tool-call markup as plain text ran nothing: let the model
          // re-emit real calls once, then treat the source as protocol-broken so a fallback
          // route can take the request. The text must never masquerade as a direct answer.
          if (pass.observedToolCalls === 0 && !pass.committedOutcome && containsLeakedToolCallMarkup(attemptCompletionText)) {
            if (toolLeakRepairAttempted) {
              throw new DomainError("joi_model_toolcall_leak", "The model rendered tool-call markup as plain text, so the response is not a real answer.");
            }
            toolLeakRepairAttempted = true;
            emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.toolcall_leak_repair_requested", {
              workbenchId,
              inputId,
              sourceId: pin.sourceId,
              turnId,
            });
            prompt = LEAKED_TOOL_CALL_REPAIR_PROMPT;
            turnImages = undefined;
            continue;
          }
          const synthesisOutcomeCommitted = committedTurnOutcome === "RESULT_SYNTHESIZED" || committedTurnOutcome === "RESULT_CONTINUE" || committedTurnOutcome === "RESULT_BLOCKED";
          if (observedToolCalls.size > 0 && committedOutcomeTools.size === 0 || isGoalSynthesis && !synthesisOutcomeCommitted) {
            if (completionRepairAttempted) {
              throw new DomainError("joi_turn_outcome_uncommitted", "The reasoning Turn ended without a committed outcome.");
            }
            completionRepairAttempted = true;
            emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.repair_requested", {
              workbenchId,
              inputId,
              observedToolCount: observedToolCalls.size,
              turnId,
            });
            prompt = isGoalSynthesis ? SYNTHESIS_OUTCOME_REPAIR_PROMPT : OUTCOME_REPAIR_PROMPT;
            // The repair continues the same session: the first user message already
            // carries the attachment content, so never resend the image parts.
            turnImages = undefined;
            continue;
          }
          const inferredDirectOutcome = !isGoalSynthesis && input.goalInputId === undefined
            ? committedTurnOutcome === "DIRECT_ANSWER" || committedTurnOutcome === "TEAM_READY"
              ? committedTurnOutcome
              : committedOutcomeTools.has("turn_complete") || observedToolCalls.size === 0
                ? "DIRECT_ANSWER"
                : undefined
            : undefined;
          if ((finishedTurnIds.has(turnId) && inferredDirectOutcome !== undefined || isGoalSynthesis && synthesisOutcomeCommitted)
            && normalizeCompletionSummary(completionText) === "") {
            if (completionRepairAttempted) {
              throw new DomainError("joi_turn_completion_empty", "The reasoning Turn ended without a visible final answer.");
            }
            completionRepairAttempted = true;
            emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.repair_requested", {
              workbenchId,
              inputId,
              observedToolCount: observedToolCalls.size,
              turnId,
            });
            prompt = EMPTY_COMPLETION_REPAIR_PROMPT;
            turnImages = undefined;
            continue;
          }
          break;
        } catch (error) {
          if (signal?.aborted) throw error;
          const failure = this.dependencies.failureClassifier?.classify(error) ?? null;
          const fallback = failure === null ? null : await this.dependencies.sources.selectFallback?.({
            currentSourceId: pin.sourceId,
            failure,
            formalOutputStarted,
            sideEffectStarted: sideEffectStarted(),
            turnId,
          }) ?? null;
          if (fallback === null || attemptedSources.has(fallback.sourceId)) throw error;
          emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.source_fallback", {
            workbenchId,
            fromSourceId: pin.sourceId,
            inputId,
            toSourceId: fallback.sourceId,
            turnId,
          });
          pin = fallback;
          await this.dependencies.store.updateTurnSource?.(turnId, pin.sourceRevisionId, pin.modelRevisionId);
        }
      }
      if (pin.modelCapability === "custom-unverified-tools" && pin.toolCapabilityProven !== true && observedToolCalls.size > 0) {
        await this.dependencies.sources.recordToolProof?.({
          modelRevisionId: pin.modelRevisionId,
          provenAt: this.dependencies.clock.now().toISOString(),
          sourceRevisionId: pin.sourceRevisionId,
        });
        pin = { ...pin, toolCapabilityProven: true };
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.tool_capability_proven", {
          modelRevisionId: pin.modelRevisionId,
          sourceId: pin.sourceId,
          sourceRevisionId: pin.sourceRevisionId,
          turnId,
        });
      }
      const completionSummary = normalizeCompletionSummary(completionText);
      if (signal?.aborted) throw new DomainError("joi_turn_aborted", "joi turn was canceled.");
      const synthesisOutcome = committedTurnOutcome === "RESULT_SYNTHESIZED" || committedTurnOutcome === "RESULT_CONTINUE" || committedTurnOutcome === "RESULT_BLOCKED"
        ? committedTurnOutcome
        : undefined;
      if (isGoalSynthesis && synthesisOutcome === undefined) {
        throw new DomainError("joi_goal_synthesis_outcome_uncommitted", "Goal synthesis ended without a committed disposition.");
      }
      const directOutcome = completionSummary !== "" && !isGoalSynthesis && input.goalInputId === undefined
        ? committedTurnOutcome === "DIRECT_ANSWER" || committedTurnOutcome === "TEAM_READY"
          ? committedTurnOutcome
          : committedOutcomeTools.has("turn_complete") || observedToolCalls.size === 0
            ? "DIRECT_ANSWER" as const
            : undefined
        : undefined;
      const completion = await this.dependencies.store.completeInput(inputId, turnId, isGoalSynthesis ? {
        ...(committedSynthesisState === undefined ? {} : { synthesisState: committedSynthesisState }),
        completionSummary,
        outcome: synthesisOutcome ?? "RESULT_BLOCKED",
      } : directOutcome === undefined ? undefined : {
        completionSummary,
        ...(committedTurnOutcome === directOutcome ? { committedByTool: true } : {}),
        outcome: directOutcome,
      });
      if (goalSynthesis !== null) {
        const disposition = synthesisOutcome === "RESULT_SYNTHESIZED" ? "COMPLETED" as const
          : synthesisOutcome === "RESULT_CONTINUE" ? "CONTINUE" as const : "BLOCKED" as const;
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.goal.synthesis.completed", {
          disposition,
          workbenchId,
          goalInputId: goalSynthesis.goalInputId,
          inputId,
          resultRevision: goalSynthesis.resultRevision,
          turnId,
        });
        if (completion !== null && typeof completion === "object"
          && "goalOutcomePersisted" in completion && completion.goalOutcomePersisted === true
          && "goalInputId" in completion && typeof completion.goalInputId === "string"
          && "resultRevision" in completion && typeof completion.resultRevision === "number") {
          emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.goal.outcome.persisted", {
            disposition,
            workbenchId,
            goalInputId: completion.goalInputId,
            resultRevision: completion.resultRevision,
          });
        }
      }
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.completed", {
        workbenchId,
        durationMs: Math.max(0, this.dependencies.clock.now().getTime() - handleStartedAt),
        inputId,
        observedToolCount: observedToolCalls.size,
        outcomeTools: [...committedOutcomeTools].sort(),
        repaired: completionRepairAttempted,
        sourceId: pin.sourceId,
        turnId,
      });
      this.#sessionFailures.delete(goalId);
      await this.dependencies.events?.emit("joi.turn.completed", turnId, { workbenchId, inputId, turnId });
    } catch (error) {
      // A failed turn must not leave its reasoning session streaming: a leftover
      // isStreaming would make every later turn on this session fail busy at once,
      // turning one failure into a retry crash loop.
      try {
        this.dependencies.runtime.abort(sessionId);
      } catch {
        // The session may not exist yet; nothing to abort.
      }
      if (!signal?.aborted) {
        const failureKind = this.dependencies.failureClassifier?.classify(error) ?? null;
        if (failureKind === "protocol") {
          this.dependencies.sources.avoidSource?.(pin.sourceId, PROTOCOL_AVOID_MILLIS);
          emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.source.avoided", {
            millis: PROTOCOL_AVOID_MILLIS,
            reason: failureKind,
            sourceId: pin.sourceId,
            turnId,
          });
        }
        this.#sessionFailures.set(goalId, (this.#sessionFailures.get(goalId) ?? 0) + 1);
      }
      // Preserve any attempt whose submission state is committed, uncertain or canceled.
      // Settled no-submission attempts can be removed without erasing dispatched work.
      if (shouldRollbackTurn(sideEffectStarted(), signal)) {
        const rolledBack = await this.dependencies.runtime.rollbackTurn(sessionId, turnId);
        if (!rolledBack) {
          emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.session.rollback_skipped", {
            inputId,
            turnId,
            workbenchId,
          });
        }
      }
      const failureReasonCode = runtimeDiagnosticErrorCode(error);
      const replayProof = replayState.rejected ? {
        replaySafe: !signal?.aborted && !sideEffectStarted() && pendingReviewEffects.size === 0,
      } : {};
      await this.dependencies.store.failTurn?.(inputId, turnId,
        inputId.startsWith("joi_harness_review:goal:") ? {
          reasonCode: failureReasonCode,
          ...replayProof,
          reviewReplaySafe: !signal?.aborted && !reviewEffects.unsafe && pendingReviewEffects.size === 0,
        } : failureReasonCode === dispatchFailureReason || replayState.rejected ? { reasonCode: failureReasonCode, ...replayProof } : undefined);
      if (error instanceof DomainError && error.code === "goal_requirements_capacity_exceeded") {
        await this.dependencies.store.requireClarification(inputId, error.code, "当前有效需求超出了可用上下文容量。请选择更大上下文的模型，或明确精简有效需求后继续。");
      }
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.failed", {
        workbenchId,
        durationMs: Math.max(0, this.dependencies.clock.now().getTime() - handleStartedAt),
        errorCode: runtimeDiagnosticErrorCode(error),
        inputId,
        observedToolCount: observedToolCalls.size,
        outcomeTools: [...committedOutcomeTools].sort(),
        repaired: completionRepairAttempted,
        sourceId: pin.sourceId,
        turnId,
      });
      await this.dependencies.events?.emit("joi.turn.failed", turnId, { workbenchId, inputId, turnId });
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortRuntime);
    }
  }
}
import type { GoalSynthesisDraft } from "../../domain/work/goal-synthesis-state.js";
