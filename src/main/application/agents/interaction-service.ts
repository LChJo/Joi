import type { A2aGatewayService } from "../a2a/a2a-gateway-service.js";
import type { EventService } from "../events/event-service.js";
import type { RuntimeStore } from "../ports/runtime-store.js";
import { DomainError } from "../../domain/errors.js";

export class InteractionService {
  constructor(private readonly dependencies: { events?: EventService; gateway: A2aGatewayService; notify?: (lifeId: string) => void; store: RuntimeStore }) {}

  async answer(interactionId: string, answer: string) {
    const interaction = await this.dependencies.store.getInteraction(interactionId);
    if (interaction === null) throw new DomainError("interaction_not_found", "Interaction was not found.");
    if (interaction.status !== "PENDING") throw new DomainError("interaction_stale", "Interaction is no longer pending.");
    if (interaction.kind === "auth-required") throw new DomainError("auth_user_action_required", "Authorization must be completed by the user at the Agent.");
    const invocation = await this.dependencies.store.getInvocation(interaction.invocationId);
    if (invocation?.contextId === undefined) throw new DomainError("interaction_stale", "Interaction context is no longer available.");
    await this.dependencies.gateway.start({
      agentConnectionId: invocation.agentConnectionId,
      contextId: invocation.contextId,
      parts: [
        { kind: "text", text: answer },
        { data: { interactionId }, kind: "data" },
      ],
    });
    const resolved = await this.dependencies.store.resolveInteraction(interactionId);
    await this.recordHumanResolution(interactionId, "human.input_answered", { answer, invocationId: invocation.invocationId });
    return resolved;
  }

  async resumeAuthorization(interactionId: string) {
    const interaction = await this.dependencies.store.getInteraction(interactionId);
    if (interaction === null) throw new DomainError("interaction_not_found", "Interaction was not found.");
    if (interaction.status !== "PENDING") throw new DomainError("interaction_stale", "Interaction is no longer pending.");
    if (interaction.kind !== "auth-required") throw new DomainError("interaction_kind_invalid", "Only authorization interactions can be resumed here.");
    const invocation = await this.dependencies.store.getInvocation(interaction.invocationId);
    if (invocation?.taskId === undefined) throw new DomainError("interaction_stale", "The original Agent Task is unavailable.");
    const recovered = await this.dependencies.gateway.recover(invocation.invocationId);
    if (recovered.status === "AUTH_REQUIRED") throw new DomainError("auth_still_required", "The Agent still reports that authorization is required.");
    const resolved = await this.dependencies.store.resolveInteraction(interactionId);
    await this.recordHumanResolution(interactionId, "human.auth_resolved", { invocationId: invocation.invocationId });
    return resolved;
  }

  listPending() {
    return this.dependencies.store.listPendingInteractions();
  }

  private async recordHumanResolution(interactionId: string, type: "human.auth_resolved" | "human.input_answered", payload: Record<string, unknown>) {
    if (this.dependencies.events === undefined) return;
    const scope = await this.dependencies.store.getInteractionScope(interactionId);
    if (scope === null) return;
    await this.dependencies.events.ingest({
      ...(scope.affairId === undefined ? {} : { affairId: scope.affairId }),
      dedupeKey: interactionId,
      lifeId: scope.lifeId,
      payload: { interactionId, ...payload },
      source: "human",
      type,
    });
    this.dependencies.notify?.(scope.lifeId);
  }
}
