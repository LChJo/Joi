import type { Workbench } from "../../domain/workbench/workbench.js";
import { createWorkbench } from "../../domain/workbench/workbench.js";
import type { WorkbenchRepository } from "../ports/workbench-context.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

export class WorkbenchRegistryService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; repository: WorkbenchRepository }) {}

  async create(input: {
    name: string;
    personaSummary: string;
    projectLabel: string;
    scopeSummary: string;
  }): Promise<Workbench> {
    const createdAt = this.dependencies.clock.now().toISOString();
    const workbenchId = this.dependencies.ids.next("workbench");
    const workbench = createWorkbench({
      workbenchId,
      createdAt,
      memoryNamespaceId: this.dependencies.ids.next("memory"),
      name: input.name,
      personaRevisionId: this.dependencies.ids.next("persona_revision"),
      personaSummary: input.personaSummary,
      project: { label: input.projectLabel },
      scopeSummary: input.scopeSummary,
      taskContext: { activeWorkIds: [], summary: "" },
    });
    await this.dependencies.repository.createWorkbench(workbench);
    return workbench;
  }
}
