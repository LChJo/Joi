import type { WorkbenchAgentRepository } from "../ports/workbench-agents.js";
import type { WorkbenchArtifactOpenMode, WorkbenchArtifactOpener, WorkbenchArtifactSource } from "../ports/workbench-artifacts.js";
import type { Clock } from "../ports/runtime-store.js";
import { DomainError } from "../../domain/errors.js";

export class WorkbenchAgentService {
  constructor(private readonly dependencies: { clock: Clock; opener?: WorkbenchArtifactOpener; repository: WorkbenchAgentRepository }) {}

  list(input: { workbenchId: string; cursor?: string; goalId?: string; limit?: number }) {
    return this.dependencies.repository.listAgents({
      workbenchId: input.workbenchId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      limit: input.limit ?? 50,
    });
  }

  conversation(input: { agentId: string; workbenchId: string; goalId?: string; cursor?: string; latest?: boolean; limit?: number }) {
    return this.dependencies.repository.conversation({
      agentId: input.agentId,
      ...(input.latest === undefined ? {} : { latest: input.latest }),
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      workbenchId: input.workbenchId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit ?? 50,
    });
  }

  dismiss(input: { agentId: string; workbenchId: string }) {
    return this.dependencies.repository.dismiss({ ...input, dismissedAt: this.dependencies.clock.now().toISOString() });
  }

  async openArtifact(input: {
    artifactId: string;
    mode: WorkbenchArtifactOpenMode;
    source: WorkbenchArtifactSource;
    sourceId: string;
    workbenchId: string;
  }): Promise<{ opened: true }> {
    if (this.dependencies.opener === undefined) throw new DomainError("workbench_artifact_open_unavailable", "Artifact opening is unavailable.");
    const artifact = await this.dependencies.repository.resolveArtifact(input);
    await this.dependencies.opener.open({ ...artifact, mode: input.mode });
    return { opened: true };
  }
}
