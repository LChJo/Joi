import { DomainError } from "../../domain/errors.js";
import type { AvatarCatalog } from "../ports/avatar-context.js";
import type { AvatarRoutingRuntime, JoiCoordinatorStore } from "../ports/joi-coordinator.js";
import type { PrimaryReasoningRuntime } from "../ports/primary-reasoning-runtime.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { AvatarRegistryService } from "./avatar-registry-service.js";

interface SourcePin {
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
    ids: IdGenerator;
    router: AvatarRoutingRuntime;
    runtime: PrimaryReasoningRuntime;
    sources: { selectInitial(turnId: string): Promise<SourcePin> };
    store: JoiCoordinatorStore;
  }) {}

  async handle(inputId: string): Promise<void> {
    const input = await this.dependencies.store.loadInput(inputId);
    if (input === null) throw new DomainError("joi_input_not_found", "joi input was not found.");
    if (input.status === "CONSUMED") return;
    const avatars = await this.dependencies.avatars.listSummaries();
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
      return;
    }
    const createdAvatar = decision.action === "create"
      ? await this.dependencies.avatarRegistry?.create(decision)
      : undefined;
    const avatarId = decision.action === "select" ? decision.avatarId : createdAvatar?.avatarId;
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
    const sessionId = this.dependencies.ids.next(`joi_${avatarId}_session`);
    const pin = await this.dependencies.sources.selectInitial(turnId);
    await this.dependencies.store.createTurn({
      avatarId,
      createdAt: this.dependencies.clock.now().toISOString(),
      inputId,
      modelRevisionId: pin.modelRevisionId,
      sessionId,
      sourceRevisionId: pin.sourceRevisionId,
      turnId,
    });
    try {
      await this.dependencies.runtime.startTurn({
        avatarId,
        modelId: pin.modelId,
        modelRevisionId: pin.modelRevisionId,
        prompt: input.body,
        sessionId,
        sourceId: pin.sourceId,
        sourceRevisionId: pin.sourceRevisionId,
        systemPrompt: [
          "You are the single global joi orchestration authority.",
          `Avatar: ${avatar.profile.name}`,
          `Scope: ${avatar.profile.scopeSummary}`,
          `Persona: ${avatar.profile.personaSummary}`,
          `Project: ${avatar.project.label}`,
          `Task context: ${avatar.taskContext.summary}`,
        ].join("\n"),
        turnId,
      });
      await this.dependencies.store.completeInput(inputId, turnId);
    } catch (error) {
      await this.dependencies.store.failTurn?.(inputId, turnId);
      throw error;
    }
  }
}
