import type { JoiAcceptedMessageDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import type { JoiInboxRecord, JoiInboxRepository } from "../ports/joi-inbox.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

export class JoiInboxService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; repository: JoiInboxRepository }) {}

  async accept(input: { idempotencyKey: string; text: string }): Promise<JoiAcceptedMessageDto> {
    const body = input.text.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (body.length === 0 || body.length > 32_000) throw new DomainError("joi_message_invalid", "Message is invalid.");
    if (idempotencyKey.length === 0 || idempotencyKey.length > 240) throw new DomainError("idempotency_key_invalid", "Idempotency key is invalid.");
    const now = this.dependencies.clock.now().toISOString();
    return toDto(await this.dependencies.repository.create({
      body,
      createdAt: now,
      idempotencyKey,
      inputId: this.dependencies.ids.next("input"),
      status: "PENDING",
      updatedAt: now,
    }));
  }

  async list(): Promise<JoiAcceptedMessageDto[]> {
    return (await this.dependencies.repository.list()).map(toDto);
  }
}

function toDto(record: JoiInboxRecord): JoiAcceptedMessageDto {
  return { acceptedAt: record.createdAt, inputId: record.inputId, status: "PENDING" };
}
