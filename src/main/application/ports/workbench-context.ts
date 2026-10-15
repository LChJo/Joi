import type { Workbench } from "../../domain/workbench/workbench.js";
import type { WorkAccessMode } from "../../domain/work/work.js";
import type { WorkbenchBindingDto, WorkbenchDetailDto } from "../../../shared/joi.js";

export interface WorkbenchSummary {
  workbenchId: string;
  name: string;
  scopeSummary: string;
  updatedAt: string;
}

export interface WorkbenchCatalog {
  getWorkbench(workbenchId: string): Promise<Workbench | null>;
  listSummaries(): Promise<WorkbenchSummary[]>;
}

export interface WorkbenchRepository extends WorkbenchCatalog {
  createWorkbench(workbench: Workbench): Promise<void>;
  createAndBindWorkbench?(workbench: Workbench, binding: WorkbenchBindingDto): Promise<Workbench>;
}

export type WorkbenchWorkspaceKind = "BOUND" | "MANAGED";
export type WorkbenchWorkspaceStatus = "FAILED" | "PROVISIONING" | "READY";

export interface WorkbenchWorkspaceSummary {
  displayName: string;
  failureReasonCode?: string;
  kind: WorkbenchWorkspaceKind;
  status: WorkbenchWorkspaceStatus;
  workspaceRef: string;
}

export interface WorkbenchContextSnapshot {
  workbenchId: string;
  contextSnapshotId: string;
  createdAt: string;
  memorySummaryRefs: string[];
  personaRevisionId: string;
  safeContext: {
    activeWork: { status: string; title: string; workId: string }[];
    workbenchName: string;
    projectLabel: string;
    recentResults: { resultId: string; status: string; summary: string; workId: string }[];
    responsibility: string;
    work: { accessMode: WorkAccessMode; title: string; workId: string };
  };
  workId: string;
  workspaceRef?: string;
}

export interface WorkbenchContextSnapshotStore {
  load(contextSnapshotId: string): Promise<WorkbenchContextSnapshot | null>;
  save(snapshot: WorkbenchContextSnapshot): Promise<void>;
}

export interface WorkbenchContextProjectionReader {
  loadSnapshotFacts(workbenchId: string, workId: string): Promise<{
    activeWork: { status: string; title: string; workId: string }[];
    memorySummaryRefs: string[];
    recentResults: { resultId: string; status: string; summary: string; workId: string }[];
    work: { accessMode: WorkAccessMode; title: string; workId: string };
    workspace: WorkbenchWorkspaceSummary | null;
  } | null>;
}

export interface WorkbenchWorkspaceRepository {
  bindExisting(input: { workbenchId: string; displayName: string; rootPath: string; updatedAt: string }): Promise<WorkbenchWorkspaceSummary>;
  getWorkspace(workbenchId: string): Promise<WorkbenchWorkspaceSummary | null>;
  hasNonTerminalFileWork(workbenchId: string): Promise<boolean>;
  requestManagedRebuild(input: { workbenchId: string; outboxId: string; updatedAt: string }): Promise<WorkbenchWorkspaceSummary>;
}

export interface WorkbenchManagementRepository {
  getDetail(workbenchId: string): Promise<WorkbenchDetailDto | null>;
  updateContext(input: {
    workbenchId: string;
    name?: string;
    personaBody?: string;
    personaRevisionId?: string;
    projectLabel?: string;
    responsibility?: string;
    updatedAt: string;
  }): Promise<WorkbenchDetailDto | null>;
}

/** Infrastructure-only seam. Absolute paths never cross this port into DTOs. */
export interface WorkbenchExecutionContextReader {
  loadForExecution(contextSnapshotId: string): Promise<{
    promptSection: string;
    sanitized: Record<string, unknown>;
    workspacePath?: string;
  } | null>;
}

export interface LegacyWorkbenchPolicyReader {
  getPreferredPartnerId(workbenchId: string): Promise<string | null>;
}
