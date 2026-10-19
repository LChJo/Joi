export interface GoalSynthesisClaim { statement: string; requirementIds: string[]; resultIds: string[] }
export interface GoalSynthesisGap { description: string; requirementIds: string[]; resultIds: string[] }
export interface GoalSynthesisConflict { description: string; resultIds: string[] }
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

const references = { type: "array", maxItems: 128, items: { type: "string", minLength: 1, maxLength: 256 } } as const;
const description = { type: "string", minLength: 1, maxLength: 2000 } as const;
export const GOAL_SYNTHESIS_STATE_SCHEMA = { type: "object", additionalProperties: false,
  required: ["version", "claims", "unresolved", "conflicts"], properties: {
    version: { type: "integer", enum: [1] },
    claims: { type: "array", maxItems: 128, items: { type: "object", additionalProperties: false,
      required: ["statement", "requirementIds", "resultIds"], properties: { statement: description, requirementIds: references, resultIds: references } } },
    unresolved: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
      required: ["description", "requirementIds", "resultIds"], properties: { description, requirementIds: references, resultIds: references } } },
    conflicts: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
      required: ["description", "resultIds"], properties: { description, resultIds: references } } },
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

/** Validates semantic state only; evidence identity and acceptance are runtime facts. */
export function parseGoalSynthesisDraft(value: unknown): GoalSynthesisDraft | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || Object.keys(data).length !== 4 || Object.keys(data).some(key => !["version", "claims", "unresolved", "conflicts"].includes(key))
    || !Array.isArray(data.claims) || data.claims.length > 128 || !data.claims.every(item => row(item, "statement", true))
    || !Array.isArray(data.unresolved) || data.unresolved.length > 64 || !data.unresolved.every(item => row(item, "description", true))
    || !Array.isArray(data.conflicts) || data.conflicts.length > 64 || !data.conflicts.every(item => row(item, "description", false))
    || JSON.stringify(value).length > 60_000) return undefined;
  return JSON.parse(JSON.stringify(value)) as GoalSynthesisDraft;
}
