import type { JoiAcceptedMessageDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import type { JoiInboxRecord, JoiInboxRepository } from "../ports/joi-inbox.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import { normalizeJoiFailureReasonCode, suggestedActionForJoiInputFailure } from "./joi-input-failure.js";

export class JoiInboxService {
  constructor(private readonly dependencies: { clock: Clock; diagnostics?: RuntimeDiagnostics; ids: IdGenerator; repository: JoiInboxRepository }) {}

  async accept(input: { attachmentIds?: string[]; workbenchId?: string; idempotencyKey: string; text: string }): Promise<JoiAcceptedMessageDto> {
    const body = input.text.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (body.length === 0 || body.length > 32_000) throw new DomainError("joi_message_invalid", "Message is invalid.");
    if (idempotencyKey.length === 0 || idempotencyKey.length > 240) throw new DomainError("idempotency_key_invalid", "Idempotency key is invalid.");
    const workbenchId = typeof input.workbenchId === "string" ? input.workbenchId.trim() : "";
    if (workbenchId.length > 160) throw new DomainError("joi_workbench_invalid", "Workbench reference is invalid.");
    const attachmentIds = [...new Set(input.attachmentIds ?? [])];
    if (attachmentIds.length !== (input.attachmentIds?.length ?? 0) || attachmentIds.length > 8
      || attachmentIds.some((value) => value.trim() === "" || value.length > 240)) {
      throw new DomainError("joi_attachments_invalid", "Message attachments are invalid.");
    }
    const now = this.dependencies.clock.now().toISOString();
    const record = await this.dependencies.repository.create({
      body,
      ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
      ...(workbenchId.length === 0 ? {} : { workbenchId }),
      createdAt: now,
      idempotencyKey,
      inputId: this.dependencies.ids.next("input"),
      status: "PENDING",
      updatedAt: now,
    });
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.accepted", {
      attachmentCount: attachmentIds.length,
      workbenchBound: record.workbenchId !== undefined,
      inputId: record.inputId,
    });
    return toDto(record);
  }

  async list(): Promise<JoiAcceptedMessageDto[]> {
    return (await this.dependencies.repository.list()).map(toDto);
  }

  async clarify(input: { workbenchId?: string; inputId: string; text?: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const workbenchId = typeof input.workbenchId === "string" ? input.workbenchId.trim() : "";
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const cleanWorkbench = workbenchId.length === 0 ? undefined : workbenchId;
    const cleanText = text.length === 0 ? undefined : text;
    if (cleanWorkbench === undefined && cleanText === undefined) {
      throw new DomainError("joi_clarification_empty", "Provide a workbench or supplementary text to continue.");
    }
    if (cleanWorkbench !== undefined && cleanWorkbench.length > 160) throw new DomainError("joi_workbench_invalid", "Workbench reference is invalid.");
    if (cleanText !== undefined && cleanText.length > 8_000) throw new DomainError("joi_clarification_invalid", "Supplementary text is too long.");
    const record = await this.dependencies.repository.clarify(inputId, {
      ...(cleanWorkbench === undefined ? {} : { workbenchId: cleanWorkbench }),
      ...(cleanText === undefined ? {} : { text: cleanText }),
    });
    if (record === null) throw new DomainError("joi_clarification_unavailable", "This input is not awaiting clarification.");
    return toDto(record);
  }

  async cancel(input: { inputId: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const record = await this.dependencies.repository.cancel(inputId);
    if (record === null) throw new DomainError("joi_cancel_unavailable", "This input is not awaiting a decision and cannot be canceled.");
    return toDto(record);
  }

  async dismiss(input: { inputId: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const record = await this.dependencies.repository.dismiss(inputId);
    if (record === null) throw new DomainError("joi_dismiss_unavailable", "This input is not finished and cannot be removed.");
    return toDto(record);
  }
}

function textPreviewOf(record: JoiInboxRecord): string | undefined {
  if (record.inputId.startsWith("joi_result_input:") || record.inputId.startsWith("joi_signal_input:")) return undefined;
  const collapsed = record.body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

function toDto(record: JoiInboxRecord): JoiAcceptedMessageDto {
  const preview = textPreviewOf(record);
  const failureReasonCode = normalizeJoiFailureReasonCode(record.failureReasonCode);
  return {
    acceptedAt: record.createdAt,
    ...(record.workbenchId === undefined ? {} : { workbenchId: record.workbenchId }),
    ...(record.canceledAt === undefined ? {} : { canceled: true }),
    ...(record.clarificationPrompt === undefined ? {} : { clarificationPrompt: record.clarificationPrompt }),
    ...(record.clarificationReasonCode === undefined ? {} : { clarificationReasonCode: record.clarificationReasonCode }),
    ...(record.failedAt === undefined || record.failureCount === undefined || record.failureReasonCode === undefined ? {} : {
      failure: {
        attempts: record.failureCount,
        executionStarted: record.failureExecutionStarted ?? false,
        reasonCode: failureReasonCode,
        suggestedAction: suggestedActionForJoiInputFailure(failureReasonCode),
      },
    }),
    inputId: record.inputId,
    status: record.status,
    ...(preview === undefined ? {} : { textPreview: preview }),
  };
}
