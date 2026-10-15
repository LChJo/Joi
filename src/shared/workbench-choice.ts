import type { WorkbenchProposalDto } from "./joi.js";

export function needsWorkbenchChoice(reasonCode: string | undefined): boolean {
  return reasonCode === "workbench_selection_invalid" || reasonCode === "workbench_creation_unavailable" || reasonCode === "workbench_not_found";
}

/** Public drafts contain labels and scope only; stored persona and workbench bodies never enter them. */
export function readWorkbenchProposal(value: unknown): WorkbenchProposalDto | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const draft = value as Record<string, unknown>;
  if (typeof draft.name !== "string" || !draft.name.trim() || draft.name.length > 80
    || typeof draft.projectLabel !== "string" || !draft.projectLabel.trim() || draft.projectLabel.length > 120
    || typeof draft.scopeSummary !== "string" || !draft.scopeSummary.trim() || draft.scopeSummary.length > 1000) return undefined;
  return { name: draft.name, projectLabel: draft.projectLabel, scopeSummary: draft.scopeSummary };
}

export function parseWorkbenchProposal(json: unknown): WorkbenchProposalDto | undefined {
  if (typeof json !== "string") return undefined;
  try { return readWorkbenchProposal(JSON.parse(json)); } catch { return undefined; }
}
