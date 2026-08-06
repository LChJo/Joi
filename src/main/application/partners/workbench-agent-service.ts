import type { WorkbenchAgentRepository } from "../ports/workbench-agents.js";
import type { Clock } from "../ports/runtime-store.js";

export class WorkbenchAgentService {
  constructor(private readonly dependencies: { clock: Clock; repository: WorkbenchAgentRepository }) {}

  list(input: { workbenchId: string; cursor?: string; goalId?: string; limit?: number }) {
    return this.dependencies.repository.listAgents({
      workbenchId: input.workbenchId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      limit: input.limit ?? 50,
    });
  }

  conversation(input: { agentId: string; workbenchId: string; cursor?: string; limit?: number }) {
    return this.dependencies.repository.conversation({
      agentId: input.agentId,
      workbenchId: input.workbenchId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit ?? 50,
    });
  }

  dismiss(input: { agentId: string; workbenchId: string }) {
    return this.dependencies.repository.dismiss({ ...input, dismissedAt: this.dependencies.clock.now().toISOString() });
  }
}
