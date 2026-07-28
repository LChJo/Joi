import { DomainError } from "../../domain/errors.js";
import type { AvatarCatalog } from "../ports/avatar-context.js";
import type { AvatarRoutingRuntime, JoiCoordinatorStore, ReasoningFailureClassifier } from "../ports/joi-coordinator.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";
import type { PrimaryReasoningRuntime } from "../ports/primary-reasoning-runtime.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";
import type { AvatarRegistryService } from "./avatar-registry-service.js";

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
    const avatars = await this.dependencies.avatars.listSummaries();
    let createdAvatar;
    let avatarId = input.avatarId;
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
        await this.dependencies.store.requireClarification(inputId, "avatar_selection_invalid");
        await this.dependencies.events?.emit("joi.message.clarification_required", inputId, { inputId });
        return;
      }
      createdAvatar = decision.action === "create"
        ? await this.dependencies.avatarRegistry?.create(decision)
        : undefined;
      avatarId = decision.action === "select" ? decision.avatarId : createdAvatar?.avatarId;
    }
    if (avatarId === undefined) {
      await this.dependencies.store.requireClarification(inputId, "avatar_creation_unavailable");
      return;
    }
    const avatar = createdAvatar ?? await this.dependencies.avatars.getAvatar(avatarId);
    if (avatar === null) {
      await this.dependencies.store.requireClarification(inputId, "avatar_not_found");
      return;
    }
    const turnId = this.dependencies.ids.next("turn");
    const sessionId = `joi_session:${avatarId}`;
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
    await this.dependencies.events?.emit("joi.turn.started", turnId, { avatarId, inputId, turnId });
    let formalOutputStarted = false;
    let sideEffectStarted = false;
    const observedToolCalls = new Set<string>();
    const attemptedSources = new Set<string>();
    try {
      for (;;) {
        attemptedSources.add(pin.sourceId);
        try {
          await this.dependencies.runtime.startTurn({
            avatarId,
            modelId: pin.modelId,
            modelRevisionId: pin.modelRevisionId,
            onEvent: (event) => {
              if (event.type === "text_delta" && event.delta.length > 0) formalOutputStarted = true;
              if (event.type === "tool_started") { sideEffectStarted = true; observedToolCalls.add(event.toolCallId); }
              if (formalOutputStarted || sideEffectStarted) {
                void this.dependencies.store.recordTurnProgress?.(turnId, { formalOutputStarted, sideEffectStarted });
              }
            },
            prompt: input.body,
            sessionId,
            sourceId: pin.sourceId,
            sourceRevisionId: pin.sourceRevisionId,
            systemPrompt: [
              "You are the single global joi orchestration authority.",
              "Treat this persisted input at a safe Turn boundary: decide whether it updates current work, becomes follow-up work, starts independent work, or needs clarification.",
              ...(pin.modelCapability === "custom-unverified-tools" ? ["This custom model is not tool-verified. Call partner.list_available before any formal response; otherwise this Turn will fail closed."] : []),
              `Avatar: ${avatar.profile.name}`,
              `Scope: ${avatar.profile.scopeSummary}`,
              `Persona: ${avatar.profile.personaSummary}`,
              `Project: ${avatar.project.label}`,
              `Task context: ${avatar.taskContext.summary}`,
              ...(input.attachments === undefined ? [] : [`Attachments: ${input.attachments.map((item) => `${item.attachmentId} ${item.filename} ${item.mimeType} ${String(item.size)} bytes`).join("; ")}`]),
            ].join("\n"),
            turnId,
          });
          if (pin.modelCapability === "custom-unverified-tools" && observedToolCalls.size === 0) {
            throw new DomainError("custom_model_tool_capability_unverified", "Custom model did not demonstrate structured tool calling.");
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
          pin = fallback;
          await this.dependencies.store.updateTurnSource?.(turnId, pin.sourceRevisionId, pin.modelRevisionId);
        }
      }
      await this.dependencies.store.completeInput(inputId, turnId);
      await this.dependencies.events?.emit("joi.turn.completed", turnId, { avatarId, inputId, turnId });
    } catch (error) {
      await this.dependencies.store.failTurn?.(inputId, turnId);
      await this.dependencies.events?.emit("joi.turn.failed", turnId, { avatarId, inputId, turnId });
      throw error;
    }
  }
}
