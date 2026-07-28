import { DomainError } from "../errors.js";

export type WorkAccessMode = "READ" | "WRITE";
export type WorkStatus = "PLANNED" | "READY" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELED";

export interface WorkItem {
  accessMode: WorkAccessMode;
  avatarId: string;
  createdAt: string;
  status: WorkStatus;
  title: string;
  updatedAt: string;
  workId: string;
  workspaceRef?: string;
}

export interface WorkDependency {
  dependsOnWorkId: string;
  workId: string;
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) throw new DomainError(code, "Work value is invalid.");
  return normalized;
}

export function createWorkItem(input: {
  accessMode: WorkAccessMode;
  avatarId: string;
  createdAt: string;
  title: string;
  workId: string;
  workspaceRef?: string;
}): WorkItem {
  const workspaceRef = input.workspaceRef?.trim();
  return {
    accessMode: input.accessMode,
    avatarId: required(input.avatarId, "work_avatar_invalid"),
    createdAt: input.createdAt,
    status: "PLANNED",
    title: required(input.title, "work_title_invalid"),
    updatedAt: input.createdAt,
    workId: required(input.workId, "work_id_invalid"),
    ...(workspaceRef === undefined || workspaceRef === "" ? {} : { workspaceRef }),
  };
}

function conflicts(candidate: WorkItem, selected: WorkItem[]): boolean {
  if (candidate.workspaceRef === undefined) return false;
  return selected.some((item) => item.workspaceRef === candidate.workspaceRef
    && (item.accessMode === "WRITE" || candidate.accessMode === "WRITE"));
}

export function buildWorkExecutionWaves(items: WorkItem[], dependencies: WorkDependency[]): string[][] {
  const byId = new Map(items.map((item) => [item.workId, item]));
  if (byId.size !== items.length) throw new DomainError("work_id_duplicate", "Work IDs must be unique.");
  const prerequisites = new Map<string, Set<string>>(items.map((item) => [item.workId, new Set()]));
  for (const dependency of dependencies) {
    const work = byId.get(dependency.workId);
    const prerequisite = byId.get(dependency.dependsOnWorkId);
    if (work === undefined || prerequisite === undefined) throw new DomainError("work_dependency_unknown", "Work dependency is unknown.");
    if (work.avatarId !== prerequisite.avatarId) throw new DomainError("work_dependency_cross_avatar", "Work cannot depend on another Avatar.");
    prerequisites.get(work.workId)?.add(prerequisite.workId);
  }

  const completed = new Set<string>();
  const pending = new Set(items.map((item) => item.workId));
  const waves: string[][] = [];
  while (pending.size > 0) {
    const ready = items.filter((item) => pending.has(item.workId)
      && [...(prerequisites.get(item.workId) ?? [])].every((id) => completed.has(id)));
    if (ready.length === 0) throw new DomainError("work_dependency_cycle", "Work dependency cycle detected.");
    const selected: WorkItem[] = [];
    for (const item of ready) if (!conflicts(item, selected)) selected.push(item);
    const wave = selected.map((item) => item.workId);
    waves.push(wave);
    for (const workId of wave) { pending.delete(workId); completed.add(workId); }
  }
  return waves;
}
