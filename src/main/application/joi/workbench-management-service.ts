import { DomainError } from "../../domain/errors.js";
import type { WorkbenchDetailDto } from "../../../shared/joi.js";
import type { WorkbenchManagementRepository } from "../ports/workbench-context.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";

function optionalText(value: string | undefined, maxLength: number, code: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maxLength) throw new DomainError(code, "Workbench context value is invalid.");
  return normalized;
}

export class WorkbenchManagementService {
  constructor(private readonly dependencies: {
    clock: Clock;
    events?: DurableUiEventEmitter;
    ids: IdGenerator;
    repository: WorkbenchManagementRepository;
  }) {}

  async get(workbenchId: string): Promise<WorkbenchDetailDto> {
    const detail = await this.dependencies.repository.getDetail(workbenchId);
    if (detail === null) throw new DomainError("workbench_not_found", "Workbench was not found.");
    return detail;
  }

  async update(workbenchId: string, input: { name?: string; persona?: string; projectLabel?: string; responsibility?: string }): Promise<WorkbenchDetailDto> {
    if (input.name === undefined && input.persona === undefined && input.projectLabel === undefined && input.responsibility === undefined) {
      throw new DomainError("workbench_update_empty", "Workbench update is empty.");
    }
    const name = optionalText(input.name, 80, "workbench_name_invalid");
    const persona = optionalText(input.persona, 4_000, "workbench_persona_invalid");
    const projectLabel = optionalText(input.projectLabel, 160, "workbench_project_label_invalid");
    const responsibility = optionalText(input.responsibility, 1_000, "workbench_scope_invalid");
    const detail = await this.dependencies.repository.updateContext({
      workbenchId,
      ...(name === undefined ? {} : { name }),
      ...(persona === undefined ? {} : { personaBody: persona, personaRevisionId: this.dependencies.ids.next("persona_revision") }),
      ...(projectLabel === undefined ? {} : { projectLabel }),
      ...(responsibility === undefined ? {} : { responsibility }),
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
    if (detail === null) throw new DomainError("workbench_not_found", "Workbench was not found.");
    await this.dependencies.events?.emit("workbench.context.updated", workbenchId, {
      workbenchId,
      personaRevisionId: detail.personaRevisionId,
      updatedAt: detail.updatedAt,
    });
    return detail;
  }
}
