import { DomainError } from "../errors.js";

export interface WorkbenchProfile {
  name: string;
  personaRevisionId: string;
  personaSummary: string;
  scopeSummary: string;
}

export interface WorkbenchProjectContext {
  label: string;
}

export interface WorkbenchMemoryNamespace {
  namespaceId: string;
}

export interface WorkbenchTaskContext {
  activeWorkIds: string[];
  summary: string;
}

export interface Workbench {
  workbenchId: string;
  createdAt: string;
  memory: WorkbenchMemoryNamespace;
  profile: WorkbenchProfile;
  project: WorkbenchProjectContext;
  taskContext: WorkbenchTaskContext;
  updatedAt: string;
}

export interface CreateWorkbenchInput {
  workbenchId: string;
  createdAt: string;
  memoryNamespaceId: string;
  name: string;
  personaRevisionId: string;
  personaSummary: string;
  project: WorkbenchProjectContext;
  scopeSummary: string;
  taskContext: WorkbenchTaskContext;
}

function requiredText(value: string, maxLength: number, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new DomainError(code, "Workbench context value is invalid.");
  }
  return normalized;
}

export function createWorkbench(input: CreateWorkbenchInput): Workbench {
  const workbenchId = requiredText(input.workbenchId, 160, "workbench_id_invalid");
  return {
    workbenchId,
    createdAt: input.createdAt,
    memory: { namespaceId: requiredText(input.memoryNamespaceId, 160, "workbench_memory_namespace_invalid") },
    profile: {
      name: requiredText(input.name, 80, "workbench_name_invalid"),
      personaRevisionId: requiredText(input.personaRevisionId, 160, "workbench_persona_revision_invalid"),
      personaSummary: requiredText(input.personaSummary, 4_000, "workbench_persona_invalid"),
      scopeSummary: requiredText(input.scopeSummary, 1_000, "workbench_scope_invalid"),
    },
    project: {
      label: requiredText(input.project.label, 160, "workbench_project_label_invalid"),
    },
    taskContext: {
      activeWorkIds: [...new Set(input.taskContext.activeWorkIds.map((id) => requiredText(id, 160, "workbench_work_id_invalid")))],
      summary: input.taskContext.summary.trim(),
    },
    updatedAt: input.createdAt,
  };
}

export function updateWorkbenchProfile(
  workbench: Workbench,
  input: { name: string; personaRevisionId: string; personaSummary: string; scopeSummary?: string; updatedAt: string },
): Workbench {
  return {
    ...workbench,
    memory: { ...workbench.memory },
    profile: {
      name: requiredText(input.name, 80, "workbench_name_invalid"),
      personaRevisionId: requiredText(input.personaRevisionId, 160, "workbench_persona_revision_invalid"),
      personaSummary: requiredText(input.personaSummary, 4_000, "workbench_persona_invalid"),
      scopeSummary: input.scopeSummary === undefined
        ? workbench.profile.scopeSummary
        : requiredText(input.scopeSummary, 1_000, "workbench_scope_invalid"),
    },
    project: { ...workbench.project },
    taskContext: { ...workbench.taskContext, activeWorkIds: [...workbench.taskContext.activeWorkIds] },
    updatedAt: input.updatedAt,
  };
}
