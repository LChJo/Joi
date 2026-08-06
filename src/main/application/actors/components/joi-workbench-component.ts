import type { WorkbenchCatalog, WorkbenchSummary } from "../../ports/workbench-context.js";
import type { ActorComponent, ActorTickContext } from "../../ports/actor-runtime.js";

/** Roster projection the joi actor reconciles its Workbench children from. */
export class JoiWorkbenchComponent implements ActorComponent {
  readonly componentName = "joi-workbench";
  #summaries: WorkbenchSummary[] = [];

  constructor(private readonly dependencies: {
    workbenches: Pick<WorkbenchCatalog, "listSummaries">;
  }) {}

  get summaries(): readonly WorkbenchSummary[] {
    return this.#summaries;
  }

  async update(_ctx: ActorTickContext): Promise<void> {
    this.#summaries = await this.dependencies.workbenches.listSummaries();
  }
}
