import { DomainError } from "../../domain/errors.js";
import type {
  WorkbenchCatalog,
  WorkbenchContextProjectionReader,
  WorkbenchContextSnapshot,
  WorkbenchContextSnapshotStore,
} from "../ports/workbench-context.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

const PATH_FRAGMENT = /(?:[A-Za-z]:[\\/][^\s]+|\\\\[^\s\\]+\\[^\s]+|(?:^|\s)\/(?:Users|home|var|tmp|opt|mnt)\/[^\s]+)/gu;

function safeText(value: string): string {
  return value.replace(PATH_FRAGMENT, " [redacted-path]").trim();
}

export class WorkbenchContextAssembler {
  constructor(private readonly dependencies: {
    workbenches: WorkbenchCatalog;
    clock: Clock;
    ids: IdGenerator;
    projections: WorkbenchContextProjectionReader;
    snapshots: WorkbenchContextSnapshotStore;
  }) {}

  async assemble(input: { workbenchId: string; workId: string }): Promise<WorkbenchContextSnapshot> {
    const [workbench, facts] = await Promise.all([
      this.dependencies.workbenches.getWorkbench(input.workbenchId),
      this.dependencies.projections.loadSnapshotFacts(input.workbenchId, input.workId),
    ]);
    if (workbench === null || facts === null) throw new DomainError("workbench_context_not_found", "Workbench execution context was not found.");
    if (facts.work.accessMode !== "NONE" && facts.workspace?.status !== "READY") {
      throw new DomainError("workbench_workspace_not_ready", "Workbench workspace is not ready for file work.");
    }
    const snapshot: WorkbenchContextSnapshot = {
      workbenchId: input.workbenchId,
      contextSnapshotId: this.dependencies.ids.next("workbench_context_snapshot"),
      createdAt: this.dependencies.clock.now().toISOString(),
      memorySummaryRefs: [...new Set([`workbench_memory:${workbench.memory.namespaceId}`, ...facts.memorySummaryRefs])],
      personaRevisionId: workbench.profile.personaRevisionId,
      safeContext: {
        activeWork: facts.activeWork.map((item) => ({ ...item, title: safeText(item.title) })),
        workbenchName: safeText(workbench.profile.name),
        projectLabel: safeText(workbench.project.label),
        recentResults: facts.recentResults.map((item) => ({ ...item, summary: safeText(item.summary) })),
        responsibility: safeText(workbench.profile.scopeSummary),
        work: { ...facts.work, title: safeText(facts.work.title) },
      },
      workId: input.workId,
      ...(facts.work.accessMode === "NONE" || facts.workspace === null ? {} : { workspaceRef: facts.workspace.workspaceRef }),
    };
    await this.dependencies.snapshots.save(snapshot);
    return snapshot;
  }
}
