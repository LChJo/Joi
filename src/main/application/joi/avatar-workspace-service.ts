import { DomainError } from "../../domain/errors.js";
import type { AvatarWorkspaceDto } from "../../../shared/joi.js";
import type { AvatarCatalog, AvatarWorkspaceRepository, AvatarWorkspaceSummary } from "../ports/avatar-context.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";

export class AvatarWorkspaceService {
  constructor(private readonly dependencies: {
    avatars: AvatarCatalog;
    clock: Clock;
    events?: DurableUiEventEmitter;
    ids: IdGenerator;
    repository: AvatarWorkspaceRepository;
  }) {}

  async get(avatarId: string): Promise<AvatarWorkspaceDto> {
    const value = await this.dependencies.repository.getWorkspace(avatarId);
    if (value === null) throw new DomainError("avatar_workspace_not_found", "Avatar workspace was not found.");
    return safeWorkspace(value);
  }

  async bindExisting(avatarId: string, rootPath: string): Promise<AvatarWorkspaceDto> {
    await this.#assertSwitchable(avatarId);
    const normalized = rootPath.trim();
    if (normalized === "") throw new DomainError("avatar_workspace_path_required", "A workspace directory is required.");
    const displayName = normalized.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? "已绑定目录";
    const value = await this.dependencies.repository.bindExisting({
      avatarId,
      displayName,
      rootPath: normalized,
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
    await this.#changed(avatarId, value);
    return safeWorkspace(value);
  }

  async rebuildManaged(avatarId: string): Promise<AvatarWorkspaceDto> {
    await this.#assertSwitchable(avatarId);
    const value = await this.dependencies.repository.requestManagedRebuild({
      avatarId,
      outboxId: this.dependencies.ids.next("outbox"),
      updatedAt: this.dependencies.clock.now().toISOString(),
    });
    await this.#changed(avatarId, value);
    return safeWorkspace(value);
  }

  async #assertSwitchable(avatarId: string): Promise<void> {
    if (await this.dependencies.avatars.getAvatar(avatarId) === null) throw new DomainError("avatar_not_found", "Avatar was not found.");
    if (await this.dependencies.repository.hasNonTerminalFileWork(avatarId)) {
      throw new DomainError("avatar_workspace_busy", "Avatar has non-terminal file work.");
    }
  }

  async #changed(avatarId: string, value: AvatarWorkspaceSummary): Promise<void> {
    await this.dependencies.events?.emit("avatar.workspace.changed", avatarId, {
      avatarId,
      kind: value.kind,
      status: value.status,
    });
  }
}

function safeWorkspace(value: AvatarWorkspaceSummary): AvatarWorkspaceDto {
  return {
    displayName: value.displayName,
    ...(value.failureReasonCode === undefined ? {} : { failureReasonCode: value.failureReasonCode }),
    kind: value.kind,
    status: value.status,
  };
}
