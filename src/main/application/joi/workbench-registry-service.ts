import type { Workbench } from "../../domain/workbench/workbench.js";
import { createWorkbench } from "../../domain/workbench/workbench.js";
import type { WorkbenchRepository } from "../ports/workbench-context.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { WorkbenchBindingDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";

export class WorkbenchRegistryService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; repository: WorkbenchRepository }) {}

  async create(input: {
    name: string;
    personaSummary: string;
    projectLabel: string;
    scopeSummary: string;
    bindInputId?: string;
    questionId?: string;
    questionVersion?: number;
    idempotencyKey?: string;
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
    if (input.bindInputId !== undefined) {
      const binding: WorkbenchBindingDto = {
        bindInputId: input.bindInputId.trim(), questionId: input.questionId?.trim() ?? "",
        questionVersion: input.questionVersion ?? 0, idempotencyKey: input.idempotencyKey?.trim() ?? "",
      };
      if (!binding.bindInputId || binding.bindInputId.length > 160 || !binding.questionId || binding.questionId.length > 240
        || !Number.isInteger(binding.questionVersion) || binding.questionVersion < 1 || !binding.idempotencyKey || binding.idempotencyKey.length > 240) {
        throw new DomainError("workbench_choice_invalid", "The workbench choice is invalid.");
      }
      if (this.dependencies.repository.createAndBindWorkbench === undefined) throw new DomainError("workbench_choice_unavailable", "Workbench binding is unavailable.");
      return this.dependencies.repository.createAndBindWorkbench(workbench, binding);
    }
    await this.dependencies.repository.createWorkbench(workbench);
    return workbench;
  }
}
