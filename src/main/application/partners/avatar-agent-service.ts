import type { AvatarAgentRepository } from "../ports/avatar-agents.js";
import type { Clock } from "../ports/runtime-store.js";

export class AvatarAgentService {
  constructor(private readonly dependencies: { clock: Clock; repository: AvatarAgentRepository }) {}

  list(input: { avatarId: string; cursor?: string; goalId?: string; limit?: number }) {
    return this.dependencies.repository.listAgents({
      avatarId: input.avatarId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      limit: input.limit ?? 50,
    });
  }

  conversation(input: { agentId: string; avatarId: string; cursor?: string; limit?: number }) {
    return this.dependencies.repository.conversation({
      agentId: input.agentId,
      avatarId: input.avatarId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit ?? 50,
    });
  }

  dismiss(input: { agentId: string; avatarId: string }) {
    return this.dependencies.repository.dismiss({ ...input, dismissedAt: this.dependencies.clock.now().toISOString() });
  }
}
