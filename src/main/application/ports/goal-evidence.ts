import type { GoalEvidenceResult } from "../../domain/work/goal-evidence.js";

export interface GoalEvidenceScope { goalInputId: string; workbenchId: string }
export interface GoalEvidencePage { content: string; nextCursor?: string; totalCharacters: number }
export interface GoalEvidenceConclusion { outcomeId: string; body: string; disposition: string; resultRevision: number; requirementsRevision: number }
export interface GoalEvidenceCatalog {
  results: GoalEvidenceResult[];
  conclusions: GoalEvidenceConclusion[];
}
export interface GoalEvidenceRepository {
  readIdentity?(input: GoalEvidenceScope & { resultId: string }): Promise<{ status: string; isLate: boolean; isAuthoritative: boolean } | null>;
  assertReferences(input: GoalEvidenceScope & { resultIds: string[] }): Promise<void>;
  index(input: GoalEvidenceScope & { cursor?: string }): Promise<GoalEvidencePage>;
  readConclusion(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }): Promise<GoalEvidencePage>;
}
