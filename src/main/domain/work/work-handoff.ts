/** Private semantic result metadata. Acceptance remains an independent runtime fact. */
export interface WorkHandoff {
  version: 1;
  conclusion: string;
  requirementIds: string[];
  evidenceResultIds: string[];
  artifactRefs: string[];
  unresolved: string[];
  conflicts: string[];
}

export type WorkHandoffStatus = "INVALID" | "MISSING" | "PROVIDED";
export type ParsedWorkHandoff = { status: "INVALID" | "MISSING" } | { status: "PROVIDED"; handoff: WorkHandoff };

const referenceArray = { type: "array", maxItems: 128, items: { type: "string", minLength: 1, maxLength: 256 } } as const;
const issueArray = { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2000 } } as const;
export const WORK_HANDOFF_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["version", "conclusion", "requirementIds", "evidenceResultIds", "artifactRefs", "unresolved", "conflicts"],
  properties: {
    version: { type: "integer", enum: [1] },
    conclusion: { type: "string", minLength: 1, maxLength: 6000 },
    requirementIds: referenceArray, evidenceResultIds: referenceArray, artifactRefs: referenceArray,
    unresolved: issueArray, conflicts: issueArray,
  },
} as const;

export const WORK_HANDOFF_INSTRUCTION = "Deliver the complete requested answer and a private semantic handoff in your final completion. The handoff states the conclusion, requirementIds, evidenceResultIds, artifactRefs, unresolved issues and conflicts; use empty arrays when none. Cite only identifiers actually present in your evidence. Do not claim verifier acceptance. Preserve qualifications and gaps; the display preview is not the handoff.";

function strings(value: unknown, count: number, length: number): value is string[] {
  return Array.isArray(value) && value.length <= count
    && value.every((item: unknown) => typeof item === "string" && item.trim().length > 0 && item.length <= length);
}

export function parseWorkHandoff(value: unknown): ParsedWorkHandoff {
  if (value === undefined || value === null) return { status: "MISSING" };
  if (typeof value !== "object" || Array.isArray(value)) return { status: "INVALID" };
  const row = value as Record<string, unknown>;
  const keys = WORK_HANDOFF_SCHEMA.required;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !(keys as readonly string[]).includes(key))
    || row.version !== 1 || typeof row.conclusion !== "string" || row.conclusion.trim() === "" || row.conclusion.length > 6000
    || !strings(row.requirementIds, 128, 256) || !strings(row.evidenceResultIds, 128, 256) || !strings(row.artifactRefs, 128, 256)
    || !strings(row.unresolved, 32, 2000) || !strings(row.conflicts, 32, 2000)) return { status: "INVALID" };
  return { status: "PROVIDED", handoff: {
    version: 1, conclusion: row.conclusion,
    requirementIds: [...new Set(row.requirementIds)], evidenceResultIds: [...new Set(row.evidenceResultIds)],
    artifactRefs: [...new Set(row.artifactRefs)], unresolved: [...row.unresolved], conflicts: [...row.conflicts],
  } };
}
