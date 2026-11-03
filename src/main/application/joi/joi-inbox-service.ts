import type { JoiAcceptedMessageDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import type { JoiInboxRecord, JoiInboxRepository } from "../ports/joi-inbox.js";
import { emitRuntimeDiagnostic, type RuntimeDiagnostics } from "../ports/runtime-diagnostics.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { PartnerRegistryService } from "../partners/partner-registry-service.js";
import { normalizeJoiFailureReasonCode, suggestedActionForJoiInputFailure } from "./joi-input-failure.js";

export class JoiInboxService {
  constructor(private readonly dependencies: {
    clock: Clock;
    diagnostics?: RuntimeDiagnostics;
    ids: IdGenerator;
    partners?: Pick<PartnerRegistryService, "inspect">;
    repository: JoiInboxRepository;
  }) {}

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

  async clarify(input: { actionChoice?: string; partnerId?: string; questionId?: string; questionVersion?: number; workbenchId?: string; inputId: string; text?: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const workbenchId = typeof input.workbenchId === "string" ? input.workbenchId.trim() : "";
    const partnerId = typeof input.partnerId === "string" ? input.partnerId.trim() : "";
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const actionChoice = typeof input.actionChoice === "string" ? input.actionChoice.trim() : "";
    const cleanWorkbench = workbenchId.length === 0 ? undefined : workbenchId;
    const cleanPartner = partnerId.length === 0 ? undefined : partnerId;
    const cleanText = text.length === 0 ? undefined : text;
    const cleanActionChoice = actionChoice === "" ? undefined : actionChoice;
    const questionId = typeof input.questionId === "string" ? input.questionId.trim() : "";
    const questionVersion = input.questionVersion;
    if ((questionId === "") !== (questionVersion === undefined)
      || (questionVersion !== undefined && (!Number.isInteger(questionVersion) || questionVersion < 1))) {
      throw new DomainError("joi_clarification_version_invalid", "The clarification question version is invalid.");
    }
    const expectedQuestion = questionId === "" || questionVersion === undefined
      ? {}
      : { expectedQuestionId: questionId, expectedQuestionVersion: questionVersion };
    if (cleanActionChoice !== undefined && !["RESUME", "CONTINUE", "ACCEPT_CURRENT"].includes(cleanActionChoice)) {
      throw new DomainError("joi_clarification_invalid", "The selected action is invalid.");
    }
    if (cleanActionChoice !== undefined && (cleanPartner !== undefined || cleanWorkbench !== undefined || cleanText !== undefined)) {
      throw new DomainError("joi_clarification_invalid", "Choose one clarification resolution.");
    }
    if (cleanPartner !== undefined && (cleanWorkbench !== undefined || cleanText !== undefined)) {
      throw new DomainError("joi_clarification_invalid", "Choose a partner without another clarification resolution.");
    }
    if (cleanWorkbench === undefined && cleanPartner === undefined && cleanText === undefined && cleanActionChoice === undefined) {
      throw new DomainError("joi_clarification_empty", "Provide a workbench, partner, or supplementary text to continue.");
    }
    if (cleanWorkbench !== undefined && cleanWorkbench.length > 160) throw new DomainError("joi_workbench_invalid", "Workbench reference is invalid.");
    if (cleanPartner !== undefined && cleanPartner.length > 160) throw new DomainError("joi_partner_selection_invalid", "Partner reference is invalid.");
    if (cleanText !== undefined && cleanText.length > 8_000) throw new DomainError("joi_clarification_invalid", "Supplementary text is too long.");
    let record;
    if (cleanPartner === undefined) {
      record = await this.dependencies.repository.clarify(inputId, {
        ...(cleanActionChoice === undefined ? {} : { actionChoice: cleanActionChoice as "RESUME" | "CONTINUE" | "ACCEPT_CURRENT" }),
        ...(cleanWorkbench === undefined ? {} : { workbenchId: cleanWorkbench }),
        ...(cleanText === undefined ? {} : { text: cleanText }),
        ...expectedQuestion,
      });
    } else {
      if (this.dependencies.partners === undefined) {
        throw new DomainError("joi_partner_selection_unavailable", "Partner selection is unavailable.");
      }
      let partner;
      try {
        partner = await this.dependencies.partners.inspect(cleanPartner);
      } catch {
        throw new DomainError("joi_partner_selection_invalid", "The selected partner is unavailable.");
      }
      if (partner.status !== "ACTIVE" || partner.configuration !== undefined) {
        throw new DomainError("joi_partner_selection_invalid", "The selected partner is unavailable.");
      }
      record = await this.dependencies.repository.clarify(inputId, {
        expectedReasonCode: "partner_selection_required",
        ...expectedQuestion,
        text: `[用户选择搭档] partnerId=${partner.partnerId}。请使用这个精确搭档继续原任务；一次性工作不要传 instanceId。`,
      });
    }
    if (record === null) throw new DomainError("joi_clarification_unavailable", "This input is not awaiting clarification.");
    return toDto(record);
  }

  /**
   * Bind a workbench to an input that is waiting for one, without the clarify contract's refusals.
   *
   * The phone creates the workbench and binds it in the same request, so there is no card left to
   * match against by the time the bind runs. Returns null when the input is no longer waiting for
   * a workbench at all — the caller reports that honestly instead of failing the creation.
   */
  async attachWorkbench(input: { inputId: string; workbenchId: string }): Promise<JoiAcceptedMessageDto | null> {
    const inputId = input.inputId.trim();
    const workbenchId = input.workbenchId.trim();
    if (inputId.length === 0 || inputId.length > 160 || workbenchId.length === 0 || workbenchId.length > 160) return null;
    const record = await this.dependencies.repository.clarify(inputId, { workbenchId });
    return record === null ? null : toDto(record);
  }

  async cancel(input: { inputId: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const record = await this.dependencies.repository.cancel(inputId);
    if (record === null) throw new DomainError("joi_cancel_unavailable", "This input is not awaiting a decision and cannot be canceled.");
    return toDto(record);
  }

  async closeHistoricalReview(input: { inputId: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const record = await this.dependencies.repository.closeHistoricalReview?.(inputId) ?? null;
    if (record === null) throw new DomainError("joi_historical_review_unavailable", "This historical review cannot be closed safely.");
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.harness.review_historically_closed", { inputId });
    return toDto(record);
  }

  async emergencyStopQueued(): Promise<number> {
    return this.dependencies.repository.cancelQueued === undefined
      ? 0
      : this.dependencies.repository.cancelQueued();
  }

  async archive(input: { inputId: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const record = await this.dependencies.repository.archive(inputId);
    if (record === null) throw new DomainError("joi_archive_unavailable", "This input is not finished and cannot be archived.");
    return toDto(record);
  }

  async unarchive(input: { inputId: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const record = await this.dependencies.repository.unarchive(inputId);
    if (record === null) throw new DomainError("joi_unarchive_unavailable", "This input is not archived.");
    return toDto(record);
  }

  async dismiss(input: { inputId: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const record = await this.dependencies.repository.dismiss(inputId);
    if (record === null) throw new DomainError("joi_dismiss_unavailable", "This input is not finished and cannot be removed.");
    return toDto(record);
  }

  async retry(input: { inputId: string; text?: string }): Promise<JoiAcceptedMessageDto> {
    const inputId = input.inputId.trim();
    if (inputId.length === 0 || inputId.length > 160) throw new DomainError("joi_input_invalid", "joi input is invalid.");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (text.length > 8_000) throw new DomainError("joi_retry_invalid", "Supplementary text is too long.");
    const record = await this.dependencies.repository.retry(inputId, { ...(text === "" ? {} : { text }) });
    if (record === null) throw new DomainError("joi_retry_unavailable", "This goal cannot be continued right now.");
    emitRuntimeDiagnostic(this.dependencies.diagnostics, "joi.input.retried", {
      inputId: record.inputId,
      supplemented: text !== "",
    });
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
    ...(record.workbenchProposal === undefined ? {} : { workbenchProposal: record.workbenchProposal }),
    ...(record.failedAt === undefined || record.failureCount === undefined || record.failureReasonCode === undefined ? {} : {
      failure: {
        attempts: record.failureCount,
        executionStarted: record.failureExecutionStarted ?? false,
        reasonCode: failureReasonCode,
        suggestedAction: suggestedActionForJoiInputFailure(failureReasonCode),
      },
    }),
    inputId: record.inputId,
    ...(record.questionId === undefined ? {} : { questionId: record.questionId }),
    ...(record.questionVersion === undefined ? {} : { questionVersion: record.questionVersion }),
    status: record.status,
    ...(preview === undefined ? {} : { textPreview: preview }),
  };
}
