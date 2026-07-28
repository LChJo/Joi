import { DomainError } from "../errors.js";

export interface AvatarProfile {
  name: string;
  personaRevisionId: string;
  personaSummary: string;
  scopeSummary: string;
}

export interface AvatarProjectContext {
  label: string;
  workspaceRef?: string;
}

export interface AvatarMemoryNamespace {
  namespaceId: string;
}

export interface AvatarTaskContext {
  activeWorkIds: string[];
  summary: string;
}

export interface Avatar {
  avatarId: string;
  createdAt: string;
  memory: AvatarMemoryNamespace;
  profile: AvatarProfile;
  project: AvatarProjectContext;
  taskContext: AvatarTaskContext;
  updatedAt: string;
}

export interface CreateAvatarInput {
  avatarId: string;
  createdAt: string;
  memoryNamespaceId: string;
  name: string;
  personaRevisionId: string;
  personaSummary: string;
  project: AvatarProjectContext;
  scopeSummary: string;
  taskContext: AvatarTaskContext;
}

function requiredText(value: string, maxLength: number, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new DomainError(code, "Avatar context value is invalid.");
  }
  return normalized;
}

export function createAvatar(input: CreateAvatarInput): Avatar {
  const avatarId = requiredText(input.avatarId, 160, "avatar_id_invalid");
  const workspaceRef = input.project.workspaceRef?.trim();
  return {
    avatarId,
    createdAt: input.createdAt,
    memory: { namespaceId: requiredText(input.memoryNamespaceId, 160, "avatar_memory_namespace_invalid") },
    profile: {
      name: requiredText(input.name, 80, "avatar_name_invalid"),
      personaRevisionId: requiredText(input.personaRevisionId, 160, "avatar_persona_revision_invalid"),
      personaSummary: requiredText(input.personaSummary, 4_000, "avatar_persona_invalid"),
      scopeSummary: requiredText(input.scopeSummary, 1_000, "avatar_scope_invalid"),
    },
    project: {
      label: requiredText(input.project.label, 160, "avatar_project_label_invalid"),
      ...(workspaceRef === undefined || workspaceRef === "" ? {} : { workspaceRef }),
    },
    taskContext: {
      activeWorkIds: [...new Set(input.taskContext.activeWorkIds.map((id) => requiredText(id, 160, "avatar_work_id_invalid")))],
      summary: input.taskContext.summary.trim(),
    },
    updatedAt: input.createdAt,
  };
}

export function updateAvatarProfile(
  avatar: Avatar,
  input: { name: string; personaRevisionId: string; personaSummary: string; scopeSummary?: string; updatedAt: string },
): Avatar {
  return {
    ...avatar,
    memory: { ...avatar.memory },
    profile: {
      name: requiredText(input.name, 80, "avatar_name_invalid"),
      personaRevisionId: requiredText(input.personaRevisionId, 160, "avatar_persona_revision_invalid"),
      personaSummary: requiredText(input.personaSummary, 4_000, "avatar_persona_invalid"),
      scopeSummary: input.scopeSummary === undefined
        ? avatar.profile.scopeSummary
        : requiredText(input.scopeSummary, 1_000, "avatar_scope_invalid"),
    },
    project: { ...avatar.project },
    taskContext: { ...avatar.taskContext, activeWorkIds: [...avatar.taskContext.activeWorkIds] },
    updatedAt: input.updatedAt,
  };
}
