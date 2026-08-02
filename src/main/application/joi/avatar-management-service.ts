import { DomainError } from "../../domain/errors.js";
import type { AvatarDetailDto } from "../../../shared/joi.js";
import type { AvatarManagementRepository } from "../ports/avatar-context.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";

function optionalText(value: string | undefined, maxLength: number, code: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maxLength) throw new DomainError(code, "Avatar context value is invalid.");
  return normalized;
}

export class AvatarManagementService {
  constructor(private readonly dependencies: {
    clock: Clock;
    events?: DurableUiEventEmitter;
    ids: IdGenerator;
    repository: AvatarManagementRepository;
  }) {}

  async get(avatarId: string): Promise<AvatarDetailDto> {
    const detail = await this.dependencies.repository.getDetail(avatarId);
    if (detail === null) throw new DomainError("avatar_not_found", "Avatar was not found.");
    return detail;
  }

  async update(avatarId: string, input: { name?: string; persona?: string; projectLabel?: string; responsibility?: string }): Promise<AvatarDetailDto> {
    if (input.name === undefined && input.persona === undefined && input.projectLabel === undefined && input.responsibility === undefined) {
      throw new DomainError("avatar_update_empty", "Avatar update is empty.");
    }
    const name = optionalText(input.name, 80, "avatar_name_invalid");
    const persona = optionalText(input.persona, 4_000, "avatar_persona_invalid");
    const projectLabel = optionalText(input.projectLabel, 160, "avatar_project_label_invalid");
    const responsibility = optionalText(input.responsibility, 1_000, "avatar_scope_invalid");
    const detail = await this.dependencies.repository.updateContext({
      avatarId,
      ...(name === undefined ? {} : { name }),
      ...(persona === undefined ? {} : { personaBody: persona, personaRevisionId: this.dependencies.ids.next("persona_revision") }),
      ...(projectLabel === undefined ? {} : { projectLabel }),
      ...(responsibility === undefined ? {} : { responsibility }),
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
    if (detail === null) throw new DomainError("avatar_not_found", "Avatar was not found.");
    await this.dependencies.events?.emit("avatar.context.updated", avatarId, {
      avatarId,
      personaRevisionId: detail.personaRevisionId,
      updatedAt: detail.updatedAt,
    });
    return detail;
  }
}
