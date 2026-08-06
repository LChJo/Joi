import { DomainError } from "../../domain/errors.js";
import type { WorkbenchChangeRepository, WorkbenchChangeRequest } from "../ports/workbench-change.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

function required(value: string, code: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new DomainError(code, "Workbench change field must not be empty.");
  return trimmed;
}

export class WorkbenchChangeService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; repository: WorkbenchChangeRepository }) {}

  async suggestArchive(input: { workbenchId: string; reason: string; turnId: string }): Promise<WorkbenchChangeRequest> {
    const sourceWorkbenchId = required(input.workbenchId, "workbench_change_source_required");
    await this.#requireActive(sourceWorkbenchId, "workbench_change_source_not_active");
    return this.#create({
      kind: "ARCHIVE",
      reason: required(input.reason, "workbench_change_reason_required"),
      sourceWorkbenchId,
      turnId: required(input.turnId, "workbench_change_turn_required"),
    });
  }

  async suggestMerge(input: { reason: string; sourceWorkbenchId: string; targetWorkbenchId: string; turnId: string }): Promise<WorkbenchChangeRequest> {
    const sourceWorkbenchId = required(input.sourceWorkbenchId, "workbench_change_source_required");
    const targetWorkbenchId = required(input.targetWorkbenchId, "workbench_change_target_required");
    if (sourceWorkbenchId === targetWorkbenchId) throw new DomainError("workbench_change_same_target", "An Workbench cannot be merged into itself.");
    await this.#requireActive(sourceWorkbenchId, "workbench_change_source_not_active");
    await this.#requireActive(targetWorkbenchId, "workbench_change_target_not_active");
    return this.#create({
      kind: "MERGE",
      reason: required(input.reason, "workbench_change_reason_required"),
      sourceWorkbenchId,
      targetWorkbenchId,
      turnId: required(input.turnId, "workbench_change_turn_required"),
    });
  }

  async decide(input: { decision: "CONFIRM" | "REJECT"; requestId: string }): Promise<WorkbenchChangeRequest> {
    const requestId = required(input.requestId, "workbench_change_request_required");
    const existing = await this.dependencies.repository.get(requestId);
    if (existing === null) throw new DomainError("workbench_change_not_found", "Workbench change request was not found.");
    if (existing.status !== "PENDING") {
      const expected = input.decision === "CONFIRM" ? "CONFIRMED" : "REJECTED";
      if (existing.status === expected) return existing;
      throw new DomainError("workbench_change_already_decided", "Workbench change request was already decided.");
    }
    return this.dependencies.repository.decide(requestId, input.decision, this.dependencies.clock.now().toISOString());
  }

  listPending(): Promise<WorkbenchChangeRequest[]> {
    return this.dependencies.repository.listPending();
  }

  async #create(input: Omit<WorkbenchChangeRequest, "createdAt" | "requestId" | "status">): Promise<WorkbenchChangeRequest> {
    const request: WorkbenchChangeRequest = {
      ...input,
      createdAt: this.dependencies.clock.now().toISOString(),
      requestId: this.dependencies.ids.next("workbench_change"),
      status: "PENDING",
    };
    await this.dependencies.repository.create(request);
    return request;
  }

  async #requireActive(workbenchId: string, code: string): Promise<void> {
    if (!await this.dependencies.repository.isActive(workbenchId)) throw new DomainError(code, "Workbench is not active.");
  }
}
