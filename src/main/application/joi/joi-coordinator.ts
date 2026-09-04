import { DomainError } from "../../domain/errors.js";
import type { WorkbenchCatalog } from "../ports/workbench-context.js";
import type { JoiAttachmentPort } from "../ports/managed-file-ports.js";
import type { WorkbenchRoutingRuntime, JoiCoordinatorStore, ReasoningFailureClassifier } from "../ports/joi-coordinator.js";
import { buildJoiAttachmentContext } from "./joi-attachment-context.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";
import type { JoiReasoningOutcome, PrimaryReasoningRuntime } from "../ports/primary-reasoning-runtime.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
  type RuntimeDiagnostics,
} from "../ports/runtime-diagnostics.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";
import type { WorkbenchRegistryService } from "./workbench-registry-service.js";
import { buildJoiSystemPrompt } from "./joi-system-prompt.js";
import { COMPLETION_SUMMARY_LIMIT, normalizeCompletionSummary } from "../partners/agent-conversation-presentation.js";
import { DISPATCH_POLICY_REASONS } from "../work/dispatch-policy.js";
import type { WorkOrchestrationService } from "../work/work-orchestration-service.js";

interface SourcePin {
  modelCapability?: "release-tested" | "custom-unverified-tools";
  modelId: string;
  modelRevisionId: string;
  sourceId: string;
  sourceRevisionId: string;
  turnId: string;
}

type WorkbenchDecision = { action: "select"; workbenchId: string } | {
  action: "create";
  name: string;
  personaSummary: string;
  projectLabel: string;
  scopeSummary: string;
};

/** Deterministic first context when no Workbench exists and routing cannot produce a valid decision. */
const BOOTSTRAP_WORKBENCH = {
  name: "joi 工作台",
  personaSummary: "承接第一批输入的通用 joi 上下文；可在上下文中心改名或调整范围。",
  projectLabel: "joi 工作台",
  scopeSummary: "尚无 Workbench 时自动创建的通用工作台；只承接不成独立目标的杂项输入，明确的新目标应创建新 Workbench。",
};

const COMMITTED_OUTCOME_TOOL_NAMES = new Set([
  "workbench_suggest_archive",
  "workbench_suggest_merge",
  "schedule_plan",
  "create_automation",
  "update_automation",
  "delete_automation",
  "run_automation_now",
  "turn_complete",
  "user_ask",
  "work_cancel",
  "work_dispatch",
  "work_supplement",
  "work_reassign",
  "work_resume",
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
  "workbench_list_summaries",
  "list_automations",
  "get_automation",
]);

const OUTCOME_REPAIR_PROMPT = [
  "[joi completion repair] Your preceding response used tools but did not commit an outcome.",
  "Continue the same persisted request now; do not repeat a lookup-only answer or merely describe future work.",
  "For executable AFK work, call work_dispatch. If user judgement is genuinely required, call user_ask.",
  "Only when no execution is requested and the response is already complete may you call turn_complete with the matching outcome.",
].join(" ");

const EMPTY_COMPLETION_REPAIR_PROMPT = [
  "[joi completion repair] Your preceding direct response did not contain a visible final answer.",
  "Continue the same persisted request without repeating side effects or lookup calls.",
  "Emit the concise final answer for the user now; if tools were used, keep the already committed outcome.",
].join(" ");

const DISPATCH_CLARIFICATION_REASONS = new Set([
  DISPATCH_POLICY_REASONS.workbenchWorkspaceNotReady,
  "partner_selection_required",
  "work_dispatch_failed",
]);

function workbenchDecision(value: unknown, known: Set<string>, canCreate: boolean): WorkbenchDecision | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.action === "select" && typeof record.workbenchId === "string" && known.has(record.workbenchId)) {
    return { action: "select", workbenchId: record.workbenchId };
  }
  if (canCreate && record.action === "create" && typeof record.name === "string"
    && typeof record.personaSummary === "string" && typeof record.projectLabel === "string"
    && typeof record.scopeSummary === "string") {
    return {
      action: "create",
      name: record.name,
      personaSummary: record.personaSummary,
      projectLabel: record.projectLabel,
      scopeSummary: record.scopeSummary,
    };
  }
  return null;
}

export class JoiCoordinator {
  constructor(private readonly dependencies: {
    workbenches: WorkbenchCatalog;
    workbenchRegistry?: Pick<WorkbenchRegistryService, "create">;
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
      selectFallback?(input: {
        currentSourceId: string;
        failure: SourceFailureKind;
        formalOutputStarted: boolean;
        sideEffectStarted: boolean;
        turnId: string;
      }): Promise<SourcePin | null>;
      selectInitial(turnId: string): Promise<SourcePin>;
    };
    store: JoiCoordinatorStore;
    work?: Pick<WorkOrchestrationService, "resume">;
  }) {}

  async handle(inputId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DomainError("joi_turn_aborted", "joi turn was canceled before it started.");
    const input = await this.dependencies.store.loadInput(inputId);
    if (input === null) throw new DomainError("joi_input_not_found", "joi input was not found.");
    if (input.status === "CONSUMED") return;
    const automationPrompt = input.automationRoutineId === undefined || this.dependencies.automation === undefined
      ? undefined
      : (await this.dependencies.automation.promptForExecution(input.automationRoutineId))?.prompt;
    if (input.automationRoutineId !== undefined && automationPrompt === undefined) throw new DomainError("automation_routine_not_found", "The scheduled Routine is unavailable.");
    const requestText = automationPrompt ?? input.body;
    const handleStartedAt = this.dependencies.clock.now().getTime();
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.handling_started", {
      attachmentCount: input.attachments?.length ?? 0,
      workbenchBound: input.workbenchId !== undefined,
      inputId,
      status: input.status,
    });
    const workbenches = await this.dependencies.workbenches.listSummaries();
    let createdWorkbench;
    let workbenchId = input.workbenchId;
    let workbenchResolution: "bound" | "bootstrap" | "created" | "selected" = "bound";
    if (workbenchId === undefined) {
      const known = new Set(workbenches.map((workbench) => workbench.workbenchId));
      let decision: WorkbenchDecision | null = null;
      for (let attempt = 0; attempt < 2 && decision === null; attempt += 1) {
        decision = workbenchDecision(
          await this.dependencies.router.decide({ workbenches, input: requestText, repair: attempt === 1 }),
          known,
          this.dependencies.workbenchRegistry !== undefined,
        );
      }
      if (decision === null) {
        if (workbenches.length === 0 && this.dependencies.workbenchRegistry !== undefined) {
          createdWorkbench = await this.dependencies.workbenchRegistry.create(BOOTSTRAP_WORKBENCH);
          workbenchId = createdWorkbench.workbenchId;
          workbenchResolution = "bootstrap";
        } else {
          await this.dependencies.store.requireClarification(inputId, "workbench_selection_invalid");
          emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.waiting_clarification", {
            inputId,
            reasonCode: "workbench_selection_invalid",
          });
          await this.dependencies.events?.emit("joi.message.clarification_required", inputId, { inputId });
          return;
        }
      } else {
        createdWorkbench = decision.action === "create"
          ? await this.dependencies.workbenchRegistry?.create(decision)
          : undefined;
        workbenchId = decision.action === "select" ? decision.workbenchId : createdWorkbench?.workbenchId;
        workbenchResolution = decision.action === "select" ? "selected" : "created";
      }
    }
    if (workbenchId === undefined) {
      await this.dependencies.store.requireClarification(inputId, "workbench_creation_unavailable");
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.waiting_clarification", {
        inputId,
        reasonCode: "workbench_creation_unavailable",
      });
      return;
    }
    const workbench = createdWorkbench ?? await this.dependencies.workbenches.getWorkbench(workbenchId);
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
    const sessionId = isGoalSynthesis ? `joi_synthesis_session:${workbenchId}` : `joi_session:${workbenchId}`;
    if (input.resolvedAction !== undefined) {
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
    let sideEffectStarted = false;
    const observedToolCalls = new Set<string>();
    const toolStartedAt = new Map<string, number>();
    const committedOutcomeTools = new Set<string>();
    let committedTurnOutcome: JoiReasoningOutcome | undefined;
    const attemptedSources = new Set<string>();
    let completionRepairAttempted = false;
    let completionText = "";
    let dispatchFailureReason: string | undefined;
    let prompt = requestText;
    let turnImages: readonly { data: string; mimeType: string }[] | undefined;
    let turnAttachmentIds: readonly string[] | undefined;
    if (input.attachments !== undefined && input.attachments.length > 0 && this.dependencies.attachments !== undefined) {
      const attachments = this.dependencies.attachments;
      const attachmentContext = await buildJoiAttachmentContext({
        attachments: input.attachments,
        reader: (attachmentId) => attachments.read(attachmentId),
      });
      if (attachmentContext.promptAddendum !== "") prompt = `${requestText}\n\n${attachmentContext.promptAddendum}`;
      turnImages = attachmentContext.images.length === 0 ? undefined : attachmentContext.images;
      turnAttachmentIds = attachmentContext.attachmentIds;
    }
    try {
      for (;;) {
        if (signal?.aborted) throw new DomainError("joi_turn_aborted", "joi turn was canceled.");
        attemptedSources.add(pin.sourceId);
      try {
        let attemptCompletionText = "";
        const finishedTurnIds = new Set<string>();
        await this.dependencies.runtime.startTurn({
            workbenchId,
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
                sideEffectStarted = sideEffectStarted || !REPLAY_SAFE_TOOL_NAMES.has(event.toolName);
                observedToolCalls.add(event.toolCallId);
                toolStartedAt.set(event.toolCallId, this.dependencies.clock.now().getTime());
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
                if (event.toolName === "work_dispatch" && (event.isError || event.reasonCode !== undefined)) {
                  dispatchFailureReason = event.reasonCode ?? "tool_execution_error";
                }
              }
              if (event.type === "tool_finished" && !event.isError && COMMITTED_OUTCOME_TOOL_NAMES.has(event.toolName)) {
                committedOutcomeTools.add(event.toolName);
                if (event.outcome !== undefined) committedTurnOutcome = event.outcome;
              }
              if (formalOutputStarted || sideEffectStarted) {
                void this.dependencies.store.recordTurnProgress?.(turnId, { formalOutputStarted, sideEffectStarted });
              }
            },
            prompt,
            sessionId,
            sourceId: pin.sourceId,
            sourceRevisionId: pin.sourceRevisionId,
            systemPrompt: buildJoiSystemPrompt({
              ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
              workbenchName: workbench.profile.name,
              ...(pin.modelCapability === undefined ? {} : { modelCapability: pin.modelCapability }),
              personaSummary: workbench.profile.personaSummary,
              projectLabel: workbench.project.label,
              scopeSummary: workbench.profile.scopeSummary,
              taskContextSummary: workbench.taskContext.summary,
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
          if (pin.modelCapability === "custom-unverified-tools" && observedToolCalls.size === 0) {
            throw new DomainError("custom_model_tool_capability_unverified", "Custom model did not demonstrate structured tool calling.");
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
            prompt = OUTCOME_REPAIR_PROMPT;
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
            sideEffectStarted,
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
        completionSummary,
        outcome: synthesisOutcome ?? "RESULT_BLOCKED",
      } : directOutcome === undefined ? undefined : {
        completionSummary,
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
      await this.dependencies.store.failTurn?.(inputId, turnId);
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
