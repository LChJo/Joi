import { DomainError } from "../../domain/errors.js";
import type {
  AvatarCatalog,
  AvatarContextProjectionReader,
  AvatarContextSnapshot,
  AvatarContextSnapshotStore,
} from "../ports/avatar-context.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";

const PATH_FRAGMENT = /(?:[A-Za-z]:[\\/][^\s]+|\\\\[^\s\\]+\\[^\s]+|(?:^|\s)\/(?:Users|home|var|tmp|opt|mnt)\/[^\s]+)/gu;

function safeText(value: string): string {
  return value.replace(PATH_FRAGMENT, " [redacted-path]").trim();
}

export class AvatarContextAssembler {
  constructor(private readonly dependencies: {
    avatars: AvatarCatalog;
    clock: Clock;
    ids: IdGenerator;
    projections: AvatarContextProjectionReader;
    snapshots: AvatarContextSnapshotStore;
  }) {}

  async assemble(input: { avatarId: string; workId: string }): Promise<AvatarContextSnapshot> {
    const [avatar, facts] = await Promise.all([
      this.dependencies.avatars.getAvatar(input.avatarId),
      this.dependencies.projections.loadSnapshotFacts(input.avatarId, input.workId),
    ]);
    if (avatar === null || facts === null) throw new DomainError("avatar_context_not_found", "Avatar execution context was not found.");
    if (facts.work.accessMode !== "NONE" && facts.workspace?.status !== "READY") {
      throw new DomainError("avatar_workspace_not_ready", "Avatar workspace is not ready for file work.");
    }
    const snapshot: AvatarContextSnapshot = {
      avatarId: input.avatarId,
      contextSnapshotId: this.dependencies.ids.next("avatar_context_snapshot"),
      createdAt: this.dependencies.clock.now().toISOString(),
      memorySummaryRefs: [...new Set([`avatar_memory:${avatar.memory.namespaceId}`, ...facts.memorySummaryRefs])],
      personaRevisionId: avatar.profile.personaRevisionId,
      safeContext: {
        activeWork: facts.activeWork.map((item) => ({ ...item, title: safeText(item.title) })),
        avatarName: safeText(avatar.profile.name),
        projectLabel: safeText(avatar.project.label),
        recentResults: facts.recentResults.map((item) => ({ ...item, summary: safeText(item.summary) })),
        responsibility: safeText(avatar.profile.scopeSummary),
        work: { ...facts.work, title: safeText(facts.work.title) },
      },
      workId: input.workId,
      ...(facts.work.accessMode === "NONE" || facts.workspace === null ? {} : { workspaceRef: facts.workspace.workspaceRef }),
    };
    await this.dependencies.snapshots.save(snapshot);
    return snapshot;
  }
}
