import type { Avatar } from "../../domain/avatar/avatar.js";
import { createAvatar } from "../../domain/avatar/avatar.js";
import type { AvatarRepository } from "../ports/avatar-context.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

export class AvatarRegistryService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; repository: AvatarRepository }) {}

  async create(input: {
    name: string;
    personaSummary: string;
    projectLabel: string;
    scopeSummary: string;
  }): Promise<Avatar> {
    const createdAt = this.dependencies.clock.now().toISOString();
    const avatarId = this.dependencies.ids.next("avatar");
    const avatar = createAvatar({
      avatarId,
      createdAt,
      memoryNamespaceId: this.dependencies.ids.next("memory"),
      name: input.name,
      personaRevisionId: this.dependencies.ids.next("persona_revision"),
      personaSummary: input.personaSummary,
      project: { label: input.projectLabel },
      scopeSummary: input.scopeSummary,
      taskContext: { activeWorkIds: [], summary: "" },
    });
    await this.dependencies.repository.createAvatar(avatar);
    return avatar;
  }
}
