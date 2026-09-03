import type { AutomationDto, AutomationRunDto, CreateAutomationInput, UpdateAutomationInput } from "../../../shared/automation.js";
import { createRoutine, nextRoutineOccurrence, routineLifecycle } from "../../domain/automation/routine.js";
import { DomainError } from "../../domain/errors.js";
import type { AutomationRecord, AutomationStore } from "../ports/automation.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { PartnerRegistryService } from "../partners/partner-registry-service.js";
import type { WorkbenchCatalog } from "../ports/workbench-context.js";

const MAX_ROUTINES = 30;

export class AutomationService {
  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    store: AutomationStore;
    workbenches: WorkbenchCatalog;
    workspaces?: { getWorkspace(workbenchId: string): Promise<{ status: string } | null> };
    partners?: Pick<PartnerRegistryService, "inspect">;
  }) {}

  async list(): Promise<AutomationDto[]> {
    return (await this.dependencies.store.list()).map((record) => toDto(record));
  }

  async get(routineId: string): Promise<AutomationDto> {
    const record = await this.dependencies.store.get(cleanId(routineId));
    if (record === null) throw new DomainError("routine_not_found", "Routine was not found.");
    return toDto(record);
  }

  async create(input: CreateAutomationInput, idempotencyKey?: string): Promise<AutomationDto> {
    const normalizedKey = idempotencyKey?.trim();
    if (normalizedKey !== undefined && (normalizedKey.length === 0 || normalizedKey.length > 240)) throw new DomainError("idempotency_key_invalid", "Idempotency key is invalid.");
    if (normalizedKey !== undefined && normalizedKey !== "" && this.dependencies.store.getByCreateIdempotencyKey !== undefined) {
      const existing = await this.dependencies.store.getByCreateIdempotencyKey(normalizedKey);
      if (existing !== null) return toDto(existing);
    }
    if (await this.dependencies.store.countActive() >= MAX_ROUTINES) throw new DomainError("routine_limit_reached", "At most 30 routines are allowed.");
    const workbenchId = await this.assertWorkbench(input.workbenchId);
    await this.assertPartner(input.preferredPartnerId);
    const now = this.dependencies.clock.now().toISOString();
    const routine = createRoutine({
      createdAt: now,
      ...(input.from === undefined ? {} : { from: input.from }),
      frequency: input.frequency,
      name: input.name,
      ...(input.preferredPartnerId === undefined ? {} : { preferredPartnerId: input.preferredPartnerId }),
      prompt: input.prompt,
      routineId: this.dependencies.ids.next("routine"),
      ...(input.to === undefined ? {} : { to: input.to }),
      workbenchId,
    });
    const nextRunAt = nextRoutineOccurrence(routine, new Date(now), systemTimezone());
    return toDto(await this.dependencies.store.create({ ...routine, ...(normalizedKey === undefined || normalizedKey === "" ? {} : { createIdempotencyKey: normalizedKey }), ...(nextRunAt === undefined ? {} : { nextRunAt: nextRunAt.toISOString() }), runs: [] }));
  }

  async update(routineId: string, input: UpdateAutomationInput, idempotencyKey?: string): Promise<AutomationDto> {
    const mutationKey = normalizeIdempotencyKey(idempotencyKey);
    const cleanRoutineId = cleanId(routineId);
    const current = await this.dependencies.store.get(cleanRoutineId);
    if (current === null) {
      // A committed update must remain replayable even if a later request soft-deleted
      // the routine. The store's mutation ledger is the source of that prior result.
      const replay = mutationKey === undefined ? null : await this.dependencies.store.update(cleanRoutineId, {}, mutationKey);
      if (replay === null) throw new DomainError("routine_not_found", "Routine was not found.");
      return toDto(replay);
    }
    if (input.workbenchId !== undefined) await this.assertWorkbench(input.workbenchId);
    await this.assertPartner(input.preferredPartnerId === null ? undefined : input.preferredPartnerId);
    const candidate = createRoutine({
      createdAt: current.createdAt,
      enabled: input.enabled ?? current.enabled,
      ...(input.from === null ? {} : { from: input.from ?? current.from }),
      frequency: input.frequency ?? current.frequency,
      ...(current.lastRunAt === undefined ? {} : { lastRunAt: current.lastRunAt }),
      name: input.name ?? current.name,
      ...(current.pendingTriggerAt === undefined ? {} : { pendingTriggerAt: current.pendingTriggerAt }),
      ...(input.preferredPartnerId === null ? {} : { preferredPartnerId: input.preferredPartnerId ?? current.preferredPartnerId }),
      prompt: input.prompt ?? current.prompt,
      routineId: current.routineId,
      ...(input.to === null ? {} : { to: input.to ?? current.to }),
      workbenchId: input.workbenchId ?? current.workbenchId,
    });
    const nextRun = nextRoutineOccurrence(candidate, new Date(this.dependencies.clock.now().getTime() - 1), systemTimezone());
    const updated = await this.dependencies.store.update(current.routineId, {
      enabled: candidate.enabled, frequency: candidate.frequency, name: candidate.name, prompt: candidate.prompt, workbenchId: candidate.workbenchId,
      ...(nextRun === undefined ? { nextRunAt: null } : { nextRunAt: nextRun.toISOString() }),
      ...(input.from === null ? { from: null } : candidate.from === undefined ? {} : { from: candidate.from }),
      ...(candidate.pendingTriggerAt === undefined ? {} : { pendingTriggerAt: candidate.pendingTriggerAt }),
      ...(input.preferredPartnerId === null ? { preferredPartnerId: null } : candidate.preferredPartnerId === undefined ? {} : { preferredPartnerId: candidate.preferredPartnerId }),
      ...(input.to === null ? { to: null } : candidate.to === undefined ? {} : { to: candidate.to }),
    }, mutationKey);
    if (updated === null) throw new DomainError("routine_not_found", "Routine was not found.");
    return toDto(updated);
  }

  async setEnabled(routineId: string, enabled: boolean, idempotencyKey?: string): Promise<AutomationDto> {
    return this.update(routineId, { enabled }, idempotencyKey);
  }

  async delete(routineId: string, idempotencyKey?: string): Promise<void> {
    if (await this.dependencies.store.softDelete(cleanId(routineId), this.dependencies.clock.now().toISOString(), normalizeIdempotencyKey(idempotencyKey)) === null) {
      throw new DomainError("routine_not_found", "Routine was not found.");
    }
  }

  async revealPrompt(routineId: string): Promise<{ prompt: string }> {
    const result = await this.dependencies.store.revealPrompt(cleanId(routineId));
    if (result === null) throw new DomainError("routine_not_found", "Routine was not found.");
    return result;
  }

  async promptForExecution(routineId: string): Promise<{ prompt: string } | null> {
    return this.dependencies.store.get(routineId, true).then((record) => record === null ? null : { prompt: record.prompt });
  }

  async runNow(routineId: string, idempotencyKey: string): Promise<AutomationDto> {
    const id = cleanId(routineId);
    if (idempotencyKey.trim().length === 0 || idempotencyKey.length > 240) throw new DomainError("idempotency_key_invalid", "Idempotency key is invalid.");
    const trigger = await this.dependencies.store.runNow({
      idempotencyKey: idempotencyKey.trim(), inputId: this.dependencies.ids.next("input"), now: this.dependencies.clock.now().toISOString(), routineId: id,
    });
    if (trigger === null) throw new DomainError("routine_not_found", "Routine was not found.");
    const routine = await this.dependencies.store.get(id) ?? await this.dependencies.store.get(id, true);
    if (routine === null) throw new DomainError("routine_not_found", "Routine was not found.");
    return toDto(routine);
  }

  private async assertWorkbench(workbenchId: string): Promise<string> {
    const clean = workbenchId.trim();
    if (clean.length === 0 || clean.length > 160 || await this.dependencies.workbenches.getWorkbench(clean) === null) throw new DomainError("routine_workbench_invalid", "Routine Workbench is unavailable.");
    const workspace = await this.dependencies.workspaces?.getWorkspace(clean);
    if (workspace === null || (workspace !== undefined && workspace.status !== "READY")) {
      throw new DomainError("routine_workbench_unavailable", "Routine Workbench is not ready.");
    }
    return clean;
  }

  private async assertPartner(partnerId: string | null | undefined): Promise<void> {
    if (partnerId === undefined || partnerId === null || partnerId.trim() === "") return;
    if (this.dependencies.partners === undefined) throw new DomainError("routine_partner_invalid", "Routine partner is unavailable.");
    const partner = await this.dependencies.partners.inspect(partnerId.trim());
    if (partner.status !== "ACTIVE") throw new DomainError("routine_partner_invalid", "Routine partner is unavailable.");
  }
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function cleanId(value: string): string {
  const result = value.trim();
  if (result.length === 0 || result.length > 160) throw new DomainError("routine_id_invalid", "Routine id is invalid.");
  return result;
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = value.trim();
  if (result.length === 0 || result.length > 240) throw new DomainError("idempotency_key_invalid", "Idempotency key is invalid.");
  return result;
}

function toDto(record: AutomationRecord): AutomationDto {
  return {
    createdAt: record.createdAt,
    enabled: record.enabled,
    ...(record.from === undefined ? {} : { from: record.from }),
    frequency: record.frequency,
    ...(record.lastRunAt === undefined ? {} : { lastRunAt: record.lastRunAt }),
    lifecycle: routineLifecycle(record, undefined, record.runs.some((run) => run.status === "BLOCKED" && run.reasonCode === "workbench_unavailable")),
    name: record.name,
    ...(record.nextRunAt === undefined ? {} : { nextRunAt: record.nextRunAt }),
    ...(record.pendingTriggerAt === undefined ? {} : { pendingTriggerAt: record.pendingTriggerAt }),
    ...(record.preferredPartnerId === undefined ? {} : { preferredPartnerId: record.preferredPartnerId }),
    promptConfigured: record.prompt.length > 0,
    routineId: record.routineId,
    runs: [...record.runs].sort((left, right) => right.occurrenceAt.localeCompare(left.occurrenceAt)).slice(0, 10).map(toRunDto),
    ...(record.to === undefined ? {} : { to: record.to }),
    workbenchId: record.workbenchId,
  };
}

function toRunDto(run: AutomationRecord["runs"][number]): AutomationRunDto {
  return {
    ...(run.completedAt === undefined ? {} : { completedAt: run.completedAt }),
    ...(run.inputId === undefined ? {} : { inputId: run.inputId }),
    occurrenceAt: run.occurrenceAt,
    ...(run.queuedAt === undefined ? {} : { queuedAt: run.queuedAt }),
    ...(run.reasonCode === undefined ? {} : { reasonCode: run.reasonCode }),
    result: run.result,
    runId: run.runId,
    mergeCount: run.mergeCount,
    status: run.status,
    triggeredAt: run.triggeredAt,
  };
}
