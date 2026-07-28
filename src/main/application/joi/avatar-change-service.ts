import { DomainError } from "../../domain/errors.js";
import type { AvatarChangeRepository, AvatarChangeRequest } from "../ports/avatar-change.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

function required(value: string, code: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new DomainError(code, "Avatar change field must not be empty.");
  return trimmed;
}

export class AvatarChangeService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; repository: AvatarChangeRepository }) {}

  async suggestArchive(input: { avatarId: string; reason: string; turnId: string }): Promise<AvatarChangeRequest> {
    const sourceAvatarId = required(input.avatarId, "avatar_change_source_required");
    await this.#requireActive(sourceAvatarId, "avatar_change_source_not_active");
    return this.#create({
      kind: "ARCHIVE",
      reason: required(input.reason, "avatar_change_reason_required"),
      sourceAvatarId,
      turnId: required(input.turnId, "avatar_change_turn_required"),
    });
  }

  async suggestMerge(input: { reason: string; sourceAvatarId: string; targetAvatarId: string; turnId: string }): Promise<AvatarChangeRequest> {
    const sourceAvatarId = required(input.sourceAvatarId, "avatar_change_source_required");
    const targetAvatarId = required(input.targetAvatarId, "avatar_change_target_required");
    if (sourceAvatarId === targetAvatarId) throw new DomainError("avatar_change_same_target", "An Avatar cannot be merged into itself.");
    await this.#requireActive(sourceAvatarId, "avatar_change_source_not_active");
    await this.#requireActive(targetAvatarId, "avatar_change_target_not_active");
    return this.#create({
      kind: "MERGE",
      reason: required(input.reason, "avatar_change_reason_required"),
      sourceAvatarId,
      targetAvatarId,
      turnId: required(input.turnId, "avatar_change_turn_required"),
    });
  }

  async decide(input: { decision: "CONFIRM" | "REJECT"; requestId: string }): Promise<AvatarChangeRequest> {
    const requestId = required(input.requestId, "avatar_change_request_required");
    const existing = await this.dependencies.repository.get(requestId);
    if (existing === null) throw new DomainError("avatar_change_not_found", "Avatar change request was not found.");
    if (existing.status !== "PENDING") {
      const expected = input.decision === "CONFIRM" ? "CONFIRMED" : "REJECTED";
      if (existing.status === expected) return existing;
      throw new DomainError("avatar_change_already_decided", "Avatar change request was already decided.");
    }
    return this.dependencies.repository.decide(requestId, input.decision, this.dependencies.clock.now().toISOString());
  }

  listPending(): Promise<AvatarChangeRequest[]> {
    return this.dependencies.repository.listPending();
  }

  async #create(input: Omit<AvatarChangeRequest, "createdAt" | "requestId" | "status">): Promise<AvatarChangeRequest> {
    const request: AvatarChangeRequest = {
      ...input,
      createdAt: this.dependencies.clock.now().toISOString(),
      requestId: this.dependencies.ids.next("avatar_change"),
      status: "PENDING",
    };
    await this.dependencies.repository.create(request);
    return request;
  }

  async #requireActive(avatarId: string, code: string): Promise<void> {
    if (!await this.dependencies.repository.isActive(avatarId)) throw new DomainError(code, "Avatar is not active.");
  }
}
