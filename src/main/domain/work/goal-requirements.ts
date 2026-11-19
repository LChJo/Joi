import { DomainError } from "../errors.js";

export interface RequirementSource {
  sourceRevision: number;
  start: number;
  end: number;
}

export interface GoalRequirement {
  id: string;
  kind: "OBJECTIVE" | "DELIVERABLE" | "CONSTRAINT" | "PREFERENCE";
  mandatory: boolean;
  scope: "GLOBAL" | "SCOPED";
  text: string;
  source: RequirementSource;
  explicitUserCorrection?: true;
}

export interface GoalRequirements {
  goalInputId: string;
  workbenchId: string;
  revision: number;
  sourceRevision: number;
  processedSourceRevision: number;
  status: "DIRTY" | "READY";
  requirements: GoalRequirement[];
  executionPrompt?: string;
  nextUnreadSource?: { sourceRevision: number; offset: number; totalChars: number };
}

export interface RequirementsUpdate {
  goalInputId: string;
  workbenchId: string;
  expectedRevision: number;
  processedSourceRevision: number;
  upserts: GoalRequirement[];
  retirements: { id: string; source: RequirementSource; explicitUserCorrection?: true }[];
}

export function sameGoalRequirement(left: GoalRequirement, right: GoalRequirement): boolean {
  return left.text === right.text && left.kind === right.kind && left.mandatory === right.mandatory && left.scope === right.scope;
}

export function assertCurrentRequirements(contract: GoalRequirements, expectedRevision?: number): void {
  if (contract.status !== "READY" || contract.processedSourceRevision !== contract.sourceRevision) {
    throw new DomainError("goal_requirements_pending", "Process the new user inputs first.");
  }
  if (expectedRevision !== contract.revision) throw new DomainError("goal_requirements_stale", "Read the current requirements and refresh the task.");
}

/** Untouched requirements remain active; every replacement needs a new trusted source. */
export function mergeGoalRequirements(current: GoalRequirements, update: RequirementsUpdate): GoalRequirement[] {
  if (update.expectedRevision !== current.revision) throw new DomainError("goal_requirements_stale", "Read the current requirements before updating them.");
  if (!Number.isInteger(update.processedSourceRevision) || update.processedSourceRevision < current.processedSourceRevision || update.processedSourceRevision > current.sourceRevision) {
    throw new DomainError("goal_requirements_pending", "Acknowledge only the sequentially processed user sources.");
  }
  const requirements = new Map(current.requirements.map(item => [item.id, item]));
  const touched = new Set<string>();
  for (const change of [...update.upserts, ...update.retirements]) {
    if (!change.id.trim() || change.id.length > 120 || touched.has(change.id)) throw new DomainError("goal_requirements_invalid", "Requirement identifiers must be unique and nonblank.");
    touched.add(change.id);
    const previous = requirements.get(change.id);
    const candidate = "text" in change ? change as GoalRequirement : undefined;
    const unchanged = previous !== undefined && candidate !== undefined && sameGoalRequirement(previous, candidate);
    const laterUnprocessedSpan = change.source.sourceRevision === previous?.source.sourceRevision
      && change.source.start >= previous.source.end && change.source.sourceRevision > current.processedSourceRevision;
    if (!unchanged && (change.source.sourceRevision <= current.processedSourceRevision
      || (previous !== undefined && change.source.sourceRevision <= previous.source.sourceRevision && !laterUnprocessedSpan))) {
      throw new DomainError("goal_requirements_source_invalid", "Replacing a requirement needs an unprocessed user correction.");
    }
    if (!unchanged && previous !== undefined && change.explicitUserCorrection !== true) {
      throw new DomainError("goal_requirements_user_correction_required", "Explicitly identify the user's correction before replacing or retiring a requirement.");
    }
    if ("text" in change) {
      const item = change as GoalRequirement;
      if (!item.text.trim() || !["OBJECTIVE", "DELIVERABLE", "CONSTRAINT", "PREFERENCE"].includes(item.kind)
        || !["GLOBAL", "SCOPED"].includes(item.scope) || typeof item.mandatory !== "boolean") {
        throw new DomainError("goal_requirements_invalid", "A requirement must have text, kind and scope.");
      }
      // Existing identifiers retain their own correction and provenance even when their texts converge.
      if (previous !== undefined || ![...requirements.values()].some(existing => sameGoalRequirement(existing, item))) {
        requirements.set(item.id, unchanged ? previous : item);
      }
    } else {
      if (previous === undefined) throw new DomainError("goal_requirements_invalid", "Cannot retire an unknown requirement.");
      requirements.delete(change.id);
    }
  }
  return [...requirements.values()];
}

/** Private rendering omits provenance bodies and replaces one transient request section. */
export function renderGoalRequirements(contract: GoalRequirements, selectedIds?: readonly string[], all = true, maxCharacters?: number): string {
  if (selectedIds?.some(id => !contract.requirements.some(item => item.id === id))) {
    throw new DomainError("goal_requirements_selection_invalid", "Select requirement identifiers from the current contract.");
  }
  const requirements = all ? contract.requirements : contract.requirements.filter(item =>
    (item.scope === "GLOBAL" && item.mandatory) || selectedIds?.includes(item.id));
  const header = [
    "Effective user requirements (user scope; runtime permissions remain authoritative):",
    `requirementsRevision=${String(contract.revision)} sourceRevision=${String(contract.sourceRevision)} processedSourceRevision=${String(contract.processedSourceRevision)} status=${contract.status}`,
    ...(contract.nextUnreadSource === undefined ? [] : [`nextUnreadSource=${JSON.stringify(contract.nextUnreadSource)}`]),
  ];
  const guidance = contract.status === "DIRTY" ? ["Before dispatch, resume or completion: page through all unprocessed goal_read_inputs sources, merge goal_update_requirements, preserve every unmentioned requirement. Only an explicit user correction may replace or retire one. Read pages sequentially; checkpoint newly extracted requirements from each page while keeping processedSourceRevision unchanged until that entire source is read. Acknowledge even inputs that do not change requirements."] : [];
  const lines = requirements.map(item => ({ priority: item.mandatory ? item.kind === "CONSTRAINT" ? 0 : 1 : 2,
    text: JSON.stringify({ id: item.id, kind: item.kind, mandatory: item.mandatory, scope: item.scope, text: item.text }) }));
  const rendered = [...header, ...lines.map(line => line.text), ...guidance].join("\n");
  if (maxCharacters === undefined || characterCount(rendered) <= maxCharacters) return rendered;
  const omission = (count: number) => `omittedRequirements=${String(count)}. Read work_read_evidence(mode=roadmap,section=requirements) to enumerate all requirements and goal_read_inputs for their complete source text.`;
  let remaining = maxCharacters - characterCount([...header, omission(lines.length), ...guidance].join("\n"));
  const included: string[] = [];
  for (const line of lines.sort((a, b) => a.priority - b.priority)) {
    const size = characterCount(line.text) + 1;
    if (size > remaining) continue;
    included.push(line.text);
    remaining -= size;
  }
  return [...header, ...included, omission(lines.length - included.length), ...guidance].join("\n");
}

function characterCount(text: string): number {
  let count = 0;
  for (let offset = 0; offset < text.length; count++) {
    offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  }
  return count;
}
