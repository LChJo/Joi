import { DomainError } from "../errors.js";

export interface GoalSynthesisClaim { statement: string; requirementIds: string[]; resultIds: string[] }
export interface GoalSynthesisGap { description: string; requirementIds: string[]; resultIds: string[]; advisory?: true }
export interface GoalSynthesisConflict {
  description: string;
  resultIds: string[];
  requirementIds?: string[];
  resolution?: { rationale: string; resultIds: string[] };
}
export interface GoalSynthesisDraft {
  version: 1;
  claims: GoalSynthesisClaim[];
  unresolved: GoalSynthesisGap[];
  conflicts: GoalSynthesisConflict[];
}
export interface GoalSynthesisState extends Omit<GoalSynthesisDraft, "claims"> {
  claims: (GoalSynthesisClaim & { verification: "VERIFIED" | "UNVERIFIED" })[];
  resultRevision: number;
  requirementsRevision: number;
  source: "MODEL" | "LEGACY";
}

/** Additional verification is not a reason for another automatic evidence layer. */
export function assertMaterialContinuationDraft(draft: GoalSynthesisDraft | undefined): void {
  if (draft !== undefined && draft.unresolved.length > 0
    && draft.unresolved.every(gap => gap.advisory === true)
    && draft.conflicts.every(conflict => conflict.resolution !== undefined)) {
    throw new DomainError("goal_synthesis_state_invalid", "Only advisory observations remain. Submit RESULT_SYNTHESIZED with verified coverage, or identify a material gap.");
  }
}

/** A repeat must have the same gaps and no newly verified evidence in their scope. */
export function hasRepeatedSynthesisGaps(
  previous: GoalSynthesisState,
  current: GoalSynthesisState,
  supportsGap: (resultId: string, requirementIds: ReadonlySet<string> | undefined) => boolean,
): boolean {
  if (previous.requirementsRevision !== current.requirementsRevision || previous.resultRevision >= current.resultRevision) return false;
  const gaps = (state: GoalSynthesisState) => [
    ...state.unresolved.filter(item => item.advisory !== true).map(item => ({ ...item, kind: "gap" })),
    ...state.conflicts.filter(item => item.resolution === undefined).map(item => ({ ...item, kind: "conflict" })),
  ];
  // Scoped gaps have a stable requirement identity; unscoped gaps still need matching descriptions.
  const signatures = (items: ReturnType<typeof gaps>) => [...new Set(items.flatMap(({ kind, description, requirementIds }) =>
    requirementIds !== undefined && requirementIds.length > 0 ? requirementIds.map(id => JSON.stringify([kind, id]))
      : [JSON.stringify([kind, description.trim().replace(/\s+/gu, " ")])]))].sort();
  const currentGaps = gaps(current);
  if (currentGaps.length === 0 || JSON.stringify(signatures(currentGaps)) !== JSON.stringify(signatures(gaps(previous)))) return false;
  const gapScope = currentGaps.some(item => (item.requirementIds?.length ?? 0) === 0)
    ? undefined : new Set(currentGaps.flatMap(item => item.requirementIds ?? []));
  const evidence = (state: GoalSynthesisState) => state.claims
    .filter(claim => claim.verification === "VERIFIED"
      && (gapScope === undefined || claim.requirementIds.some(id => gapScope.has(id))))
    .flatMap(claim => claim.resultIds.filter(id => supportsGap(id, gapScope)));
  const previousEvidence = new Set(evidence(previous));
  return evidence(current).every(id => previousEvidence.has(id));
}

export interface GoalSynthesisCoverageIssues {
  requirementsStatus: "READY" | "DIRTY" | "STALE";
  missingRequirementIds: string[];
  unresolvedRequirementIds: string[];
  blockingConflicts: { index: number; requirementIds: string[]; reason: "MISSING_RESOLUTION" | "UNSUPPORTED_RESOLUTION" }[];
  citations: (
    | { resultId: string; reason: "INELIGIBLE_RESULT" | "MISSING_READ_RECEIPT" }
    | { resultId: string; reason: "REQUIREMENT_CHANGED"; requirementIds: string[] }
  )[];
  truncated: boolean;
}

export class GoalSynthesisCoverageError extends DomainError {
  constructor(public readonly issues: GoalSynthesisCoverageIssues) {
    super("goal_synthesis_coverage_incomplete", "Read and link eligible evidence for each mandatory requirement, or report the remaining gaps.");
  }
}

const references = { type: "array", maxItems: 128, items: { type: "string", minLength: 1, maxLength: 256 } } as const;
const description = { type: "string", minLength: 1, maxLength: 2000 } as const;
export const GOAL_SYNTHESIS_STATE_SCHEMA = { type: "object", additionalProperties: false,
  required: ["version", "claims", "unresolved", "conflicts"], properties: {
    version: { type: "integer", enum: [1] },
    claims: { type: "array", maxItems: 128, items: { type: "object", additionalProperties: false,
      required: ["statement", "requirementIds", "resultIds"], properties: { statement: description, requirementIds: references, resultIds: references } } },
    unresolved: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
      required: ["description", "requirementIds", "resultIds"], properties: { description, requirementIds: references, resultIds: references, advisory: { type: "boolean", const: true } } } },
    conflicts: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
      required: ["description", "resultIds"], properties: {
        description, resultIds: references, requirementIds: references,
        resolution: { type: "object", additionalProperties: false, required: ["rationale", "resultIds"],
          properties: { rationale: description, resultIds: { ...references, minItems: 1 } } },
      } } },
  },
} as const;

function refs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 128 && value.every((id: unknown) => typeof id === "string" && id.trim() !== "" && id.length <= 256);
}
function row(value: unknown, text: string, withRequirements: boolean): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = withRequirements ? [text, "requirementIds", "resultIds"] : [text, "resultIds"];
  return Object.keys(item).length === keys.length && Object.keys(item).every(key => keys.includes(key))
    && typeof item[text] === "string" && item[text].trim() !== "" && item[text].length <= 2000
    && refs(item.resultIds) && (!withRequirements || refs(item.requirementIds));
}

function conflict(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { requirementIds, resolution, ...base } = value as Record<string, unknown>;
  if (!row(base, "description", false) || (requirementIds !== undefined && !refs(requirementIds))) return false;
  if (resolution === undefined) return true;
  return row(resolution, "rationale", false) && (resolution as { resultIds: string[] }).resultIds.length > 0;
}

function gap(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const { advisory, ...base } = value as Record<string, unknown>;
  return (advisory === undefined || advisory === true) && row(base, "description", true);
}

/** Validates semantic state only; evidence identity and acceptance are runtime facts. */
export function parseGoalSynthesisDraft(value: unknown): GoalSynthesisDraft | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || Object.keys(data).length !== 4 || Object.keys(data).some(key => !["version", "claims", "unresolved", "conflicts"].includes(key))
    || !Array.isArray(data.claims) || data.claims.length > 128 || !data.claims.every(item => row(item, "statement", true))
    || !Array.isArray(data.unresolved) || data.unresolved.length > 64 || !data.unresolved.every(gap)
    || !Array.isArray(data.conflicts) || data.conflicts.length > 64 || !data.conflicts.every(conflict)
    || JSON.stringify(value).length > 60_000) return undefined;
  return JSON.parse(JSON.stringify(value)) as GoalSynthesisDraft;
}
