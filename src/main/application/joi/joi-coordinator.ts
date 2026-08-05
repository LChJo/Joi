import { DomainError } from "../../domain/errors.js";
import type { AvatarCatalog } from "../ports/avatar-context.js";
import type { AvatarRoutingRuntime, JoiCoordinatorStore, ReasoningFailureClassifier } from "../ports/joi-coordinator.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";
import type { PrimaryReasoningRuntime } from "../ports/primary-reasoning-runtime.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
  type RuntimeDiagnostics,
} from "../ports/runtime-diagnostics.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";
import type { AvatarRegistryService } from "./avatar-registry-service.js";
import { buildJoiSystemPrompt } from "./joi-system-prompt.js";
import { sanitizeAgentConversationText } from "../partners/agent-conversation-presentation.js";

interface SourcePin {
  modelCapability?: "release-tested" | "custom-unverified-tools";
  modelId: string;
  modelRevisionId: string;
  sourceId: string;
  sourceRevisionId: string;
  turnId: string;
}

type AvatarDecision = { action: "select"; avatarId: string } | {
  action: "create";
  name: string;
  personaSummary: string;
  projectLabel: string;
  scopeSummary: string;
};

/** Deterministic first context when no Avatar exists and routing cannot produce a valid decision. */
const BOOTSTRAP_AVATAR = {
  name: "joi 工作台",
  personaSummary: "承接第一批输入的通用 joi 上下文；可在上下文中心改名或调整范围。",
  projectLabel: "joi 工作台",
  scopeSummary: "尚无 Avatar 时自动创建的通用工作台；只承接不成独立目标的杂项输入，明确的新目标应创建新 Avatar。",
};

const COMMITTED_OUTCOME_TOOL_NAMES = new Set([
  "avatar_suggest_archive",
  "avatar_suggest_merge",
  "schedule_plan",
  "turn_complete",
  "user_ask",
  "work_cancel",
  "work_dispatch",
  "work_reassign",
  "work_wait",
]);

const OUTCOME_REPAIR_PROMPT = [
  "[joi completion repair] Your preceding response used tools but did not commit an outcome.",
  "Continue the same persisted request now; do not repeat a lookup-only answer or merely describe future work.",
  "For executable AFK work, call work_dispatch. If user judgement is genuinely required, call user_ask.",
  "Only when no execution is requested and the response is already complete may you call turn_complete with the matching outcome.",
].join(" ");

function avatarDecision(value: unknown, known: Set<string>, canCreate: boolean): AvatarDecision | null {
  if (value === null || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.action === "select" && typeof record.avatarId === "string" && known.has(record.avatarId)) {
    return { action: "select", avatarId: record.avatarId };
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
    avatars: AvatarCatalog;
    avatarRegistry?: Pick<AvatarRegistryService, "create">;
    clock: Clock;
    diagnostics?: RuntimeDiagnostics;
    failureClassifier?: ReasoningFailureClassifier;
    ids: IdGenerator;
    events?: DurableUiEventEmitter;
    router: AvatarRoutingRuntime;
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
  }) {}

  async handle(inputId: string): Promise<void> {
    const input = await this.dependencies.store.loadInput(inputId);
    if (input === null) throw new DomainError("joi_input_not_found", "joi input was not found.");
    if (input.status === "CONSUMED") return;
    const handleStartedAt = this.dependencies.clock.now().getTime();
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.handling_started", {
      attachmentCount: input.attachments?.length ?? 0,
      avatarBound: input.avatarId !== undefined,
      inputId,
      status: input.status,
    });
    const avatars = await this.dependencies.avatars.listSummaries();
    let createdAvatar;
    let avatarId = input.avatarId;
    let avatarResolution: "bound" | "bootstrap" | "created" | "selected" = "bound";
    if (avatarId === undefined) {
      const known = new Set(avatars.map((avatar) => avatar.avatarId));
      let decision: AvatarDecision | null = null;
      for (let attempt = 0; attempt < 2 && decision === null; attempt += 1) {
        decision = avatarDecision(
          await this.dependencies.router.decide({ avatars, input: input.body, repair: attempt === 1 }),
          known,
          this.dependencies.avatarRegistry !== undefined,
        );
      }
      if (decision === null) {
        if (avatars.length === 0 && this.dependencies.avatarRegistry !== undefined) {
          createdAvatar = await this.dependencies.avatarRegistry.create(BOOTSTRAP_AVATAR);
          avatarId = createdAvatar.avatarId;
          avatarResolution = "bootstrap";
        } else {
          await this.dependencies.store.requireClarification(inputId, "avatar_selection_invalid");
          emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.waiting_clarification", {
            inputId,
            reasonCode: "avatar_selection_invalid",
          });
          await this.dependencies.events?.emit("joi.message.clarification_required", inputId, { inputId });
          return;
        }
      } else {
        createdAvatar = decision.action === "create"
          ? await this.dependencies.avatarRegistry?.create(decision)
          : undefined;
        avatarId = decision.action === "select" ? decision.avatarId : createdAvatar?.avatarId;
        avatarResolution = decision.action === "select" ? "selected" : "created";
      }
    }
    if (avatarId === undefined) {
      await this.dependencies.store.requireClarification(inputId, "avatar_creation_unavailable");
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.waiting_clarification", {
        inputId,
        reasonCode: "avatar_creation_unavailable",
      });
      return;
    }
    const avatar = createdAvatar ?? await this.dependencies.avatars.getAvatar(avatarId);
    if (avatar === null) {
      await this.dependencies.store.requireClarification(inputId, "avatar_not_found");
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.waiting_clarification", {
        inputId,
        reasonCode: "avatar_not_found",
      });
      return;
    }
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.avatar.resolved", { avatarId, inputId, resolution: avatarResolution });
    const turnId = this.dependencies.ids.next("turn");
    const goalSynthesis = input.goalInputId !== undefined && input.resultRevision !== undefined
      ? { goalInputId: input.goalInputId, resultRevision: input.resultRevision }
      : null;
    const isGoalSynthesis = goalSynthesis !== null;
    const sessionId = isGoalSynthesis ? `joi_synthesis_session:${avatarId}` : `joi_session:${avatarId}`;
    let pin = await this.dependencies.sources.selectInitial(turnId);
    await this.dependencies.store.createTurn({
      avatarId,
      createdAt: this.dependencies.clock.now().toISOString(),
      inputId,
      modelRevisionId: pin.modelRevisionId,
      sessionId,
      sourceRevisionId: pin.sourceRevisionId,
      turnId,
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.started", {
      avatarId,
      inputId,
      modelRevisionId: pin.modelRevisionId,
      sourceId: pin.sourceId,
      sourceRevisionId: pin.sourceRevisionId,
      turnId,
    });
    if (goalSynthesis !== null) emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.goal.synthesis.started", {
      avatarId,
      goalInputId: goalSynthesis.goalInputId,
      inputId,
      resultRevision: goalSynthesis.resultRevision,
      turnId,
    });
    await this.dependencies.events?.emit("joi.turn.started", turnId, { avatarId, inputId, turnId });
    let formalOutputStarted = false;
    let sideEffectStarted = false;
    const observedToolCalls = new Set<string>();
    const toolStartedAt = new Map<string, number>();
    const committedOutcomeTools = new Set<string>();
    const attemptedSources = new Set<string>();
    let completionRepairAttempted = false;
    let completionText = "";
    let prompt = input.body;
    try {
      for (;;) {
        attemptedSources.add(pin.sourceId);
        try {
          await this.dependencies.runtime.startTurn({
            avatarId,
            inputId,
            modelId: pin.modelId,
            modelRevisionId: pin.modelRevisionId,
            onEvent: (event) => {
              if (event.type === "text_delta" && event.delta.length > 0) {
                formalOutputStarted = true;
                if (isGoalSynthesis && completionText.length < 4_000) completionText += event.delta.slice(0, 4_000 - completionText.length);
              }
              if (event.type === "tool_started") {
                sideEffectStarted = true;
                observedToolCalls.add(event.toolCallId);
                toolStartedAt.set(event.toolCallId, this.dependencies.clock.now().getTime());
                emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.tool.started", {
                  avatarId,
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
                  avatarId,
                  durationMs: Math.max(0, finishedAt - startedAt),
                  inputId,
                  isError: event.isError,
                  sourceId: pin.sourceId,
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  turnId,
                });
                toolStartedAt.delete(event.toolCallId);
              }
              if (event.type === "tool_finished" && !event.isError && COMMITTED_OUTCOME_TOOL_NAMES.has(event.toolName)) {
                committedOutcomeTools.add(event.toolName);
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
              avatarName: avatar.profile.name,
              ...(pin.modelCapability === undefined ? {} : { modelCapability: pin.modelCapability }),
              personaSummary: avatar.profile.personaSummary,
              projectLabel: avatar.project.label,
              scopeSummary: avatar.profile.scopeSummary,
              taskContextSummary: avatar.taskContext.summary,
            }),
            turnId,
          });
          if (pin.modelCapability === "custom-unverified-tools" && observedToolCalls.size === 0) {
            throw new DomainError("custom_model_tool_capability_unverified", "Custom model did not demonstrate structured tool calling.");
          }
          if (observedToolCalls.size > 0 && committedOutcomeTools.size === 0) {
            if (completionRepairAttempted) {
              throw new DomainError("joi_turn_outcome_uncommitted", "The reasoning Turn ended without a committed outcome.");
            }
            completionRepairAttempted = true;
            emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.repair_requested", {
              avatarId,
              inputId,
              observedToolCount: observedToolCalls.size,
              turnId,
            });
            prompt = OUTCOME_REPAIR_PROMPT;
            continue;
          }
          break;
        } catch (error) {
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
            avatarId,
            fromSourceId: pin.sourceId,
            inputId,
            toSourceId: fallback.sourceId,
            turnId,
          });
          pin = fallback;
          await this.dependencies.store.updateTurnSource?.(turnId, pin.sourceRevisionId, pin.modelRevisionId);
        }
      }
      const completionSummary = sanitizeAgentConversationText(completionText).replace(/\s+/gu, " ").trim().slice(0, 640);
      const completion = await this.dependencies.store.completeInput(inputId, turnId, isGoalSynthesis ? {
        completionSummary: completionSummary === ""
          ? "相关工作已完成，结果已汇总到 Avatar 的 Agent 记录。"
          : completionSummary,
      } : undefined);
      if (goalSynthesis !== null) {
        emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.goal.synthesis.completed", {
          avatarId,
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
            avatarId,
            goalInputId: completion.goalInputId,
            resultRevision: completion.resultRevision,
          });
        }
      }
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.completed", {
        avatarId,
        durationMs: Math.max(0, this.dependencies.clock.now().getTime() - handleStartedAt),
        inputId,
        observedToolCount: observedToolCalls.size,
        outcomeTools: [...committedOutcomeTools].sort(),
        repaired: completionRepairAttempted,
        sourceId: pin.sourceId,
        turnId,
      });
      await this.dependencies.events?.emit("joi.turn.completed", turnId, { avatarId, inputId, turnId });
    } catch (error) {
      await this.dependencies.store.failTurn?.(inputId, turnId);
      emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.turn.failed", {
        avatarId,
        durationMs: Math.max(0, this.dependencies.clock.now().getTime() - handleStartedAt),
        errorCode: runtimeDiagnosticErrorCode(error),
        inputId,
        observedToolCount: observedToolCalls.size,
        outcomeTools: [...committedOutcomeTools].sort(),
        repaired: completionRepairAttempted,
        sourceId: pin.sourceId,
        turnId,
      });
      await this.dependencies.events?.emit("joi.turn.failed", turnId, { avatarId, inputId, turnId });
      throw error;
    }
  }
}
