import type { Avatar } from "../../domain/avatar/avatar.js";
import type { WorkAccessMode } from "../../domain/work/work.js";
import type { AvatarDetailDto } from "../../../shared/joi.js";

export interface AvatarSummary {
  avatarId: string;
  name: string;
  scopeSummary: string;
  updatedAt: string;
}

export interface AvatarCatalog {
  getAvatar(avatarId: string): Promise<Avatar | null>;
  listSummaries(): Promise<AvatarSummary[]>;
}

export interface AvatarRepository extends AvatarCatalog {
  createAvatar(avatar: Avatar): Promise<void>;
}

export type AvatarWorkspaceKind = "BOUND" | "MANAGED";
export type AvatarWorkspaceStatus = "FAILED" | "PROVISIONING" | "READY";

export interface AvatarWorkspaceSummary {
  displayName: string;
  failureReasonCode?: string;
  kind: AvatarWorkspaceKind;
  status: AvatarWorkspaceStatus;
  workspaceRef: string;
}

export interface AvatarContextSnapshot {
  avatarId: string;
  contextSnapshotId: string;
  createdAt: string;
  memorySummaryRefs: string[];
  personaRevisionId: string;
  safeContext: {
    activeWork: { status: string; title: string; workId: string }[];
    avatarName: string;
    projectLabel: string;
    recentResults: { resultId: string; status: string; summary: string; workId: string }[];
    responsibility: string;
    work: { accessMode: WorkAccessMode; title: string; workId: string };
  };
  workId: string;
  workspaceRef?: string;
}

export interface AvatarContextSnapshotStore {
  load(contextSnapshotId: string): Promise<AvatarContextSnapshot | null>;
  save(snapshot: AvatarContextSnapshot): Promise<void>;
}

export interface AvatarContextProjectionReader {
  loadSnapshotFacts(avatarId: string, workId: string): Promise<{
    activeWork: { status: string; title: string; workId: string }[];
    memorySummaryRefs: string[];
    recentResults: { resultId: string; status: string; summary: string; workId: string }[];
    work: { accessMode: WorkAccessMode; title: string; workId: string };
    workspace: AvatarWorkspaceSummary | null;
  } | null>;
}

export interface AvatarWorkspaceRepository {
  bindExisting(input: { avatarId: string; displayName: string; rootPath: string; updatedAt: string }): Promise<AvatarWorkspaceSummary>;
  getWorkspace(avatarId: string): Promise<AvatarWorkspaceSummary | null>;
  hasNonTerminalFileWork(avatarId: string): Promise<boolean>;
  requestManagedRebuild(input: { avatarId: string; outboxId: string; updatedAt: string }): Promise<AvatarWorkspaceSummary>;
}

export interface AvatarManagementRepository {
  getDetail(avatarId: string): Promise<AvatarDetailDto | null>;
  updateContext(input: {
    avatarId: string;
    name?: string;
    personaBody?: string;
    personaRevisionId?: string;
    projectLabel?: string;
    responsibility?: string;
    updatedAt: string;
  }): Promise<AvatarDetailDto | null>;
}

/** Infrastructure-only seam. Absolute paths never cross this port into DTOs. */
export interface AvatarExecutionContextReader {
  loadForExecution(contextSnapshotId: string): Promise<{
    promptSection: string;
    sanitized: Record<string, unknown>;
    workspacePath?: string;
  } | null>;
}

export interface LegacyAvatarPolicyReader {
  getPreferredPartnerId(avatarId: string): Promise<string | null>;
}
