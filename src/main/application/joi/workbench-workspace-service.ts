import { DomainError } from "../../domain/errors.js";
import type { WorkbenchWorkspaceDto } from "../../../shared/joi.js";
import type { WorkbenchCatalog, WorkbenchWorkspaceRepository, WorkbenchWorkspaceSummary } from "../ports/workbench-context.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";

export class WorkbenchWorkspaceService {
  constructor(private readonly dependencies: {
    workbenches: WorkbenchCatalog;
    clock: Clock;
    events?: DurableUiEventEmitter;
    ids: IdGenerator;
    repository: WorkbenchWorkspaceRepository;
  }) {}

  async get(workbenchId: string): Promise<WorkbenchWorkspaceDto> {
    const value = await this.dependencies.repository.getWorkspace(workbenchId);
    if (value === null) throw new DomainError("workbench_workspace_not_found", "Workbench workspace was not found.");
    return safeWorkspace(value);
  }

  async bindExisting(workbenchId: string, rootPath: string): Promise<WorkbenchWorkspaceDto> {
    await this.#assertSwitchable(workbenchId);
    const normalized = rootPath.trim();
    if (normalized === "") throw new DomainError("workbench_workspace_path_required", "A workspace directory is required.");
    const displayName = normalized.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? "已绑定目录";
    const value = await this.dependencies.repository.bindExisting({
      workbenchId,
      displayName,
      rootPath: normalized,
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
    await this.#changed(workbenchId, value);
    return safeWorkspace(value);
  }

  async rebuildManaged(workbenchId: string): Promise<WorkbenchWorkspaceDto> {
    await this.#assertSwitchable(workbenchId);
    const value = await this.dependencies.repository.requestManagedRebuild({
      workbenchId,
      outboxId: this.dependencies.ids.next("outbox"),
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
    await this.#changed(workbenchId, value);
    return safeWorkspace(value);
  }

  async #assertSwitchable(workbenchId: string): Promise<void> {
    if (await this.dependencies.workbenches.getWorkbench(workbenchId) === null) throw new DomainError("workbench_not_found", "Workbench was not found.");
    if (await this.dependencies.repository.hasNonTerminalFileWork(workbenchId)) {
      throw new DomainError("workbench_workspace_busy", "Workbench has non-terminal file work.");
    }
  }

  async #changed(workbenchId: string, value: WorkbenchWorkspaceSummary): Promise<void> {
    await this.dependencies.events?.emit("workbench.workspace.changed", workbenchId, {
      workbenchId,
      kind: value.kind,
      status: value.status,
    });
  }
}

function safeWorkspace(value: WorkbenchWorkspaceSummary): WorkbenchWorkspaceDto {
  return {
    displayName: value.displayName,
    ...(value.failureReasonCode === undefined ? {} : { failureReasonCode: value.failureReasonCode }),
    kind: value.kind,
    status: value.status,
  };
}
