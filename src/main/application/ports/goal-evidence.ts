import type { GoalEvidenceResult } from "../../domain/work/goal-evidence.js";
import type { WorkHandoff,WorkHandoffStatus } from "../../domain/work/work-handoff.js";

export interface GoalEvidenceScope { goalInputId: string; workbenchId: string }
export interface GoalEvidencePage { content: string; nextCursor?: string; totalCharacters: number }
export interface GoalEvidenceConclusion { outcomeId: string; body: string; disposition: string; resultRevision: number; requirementsRevision: number }
export interface GoalEvidenceCatalog {
  results: GoalEvidenceResult[];
  conclusions: GoalEvidenceConclusion[];
}
export interface GoalEvidenceChangesQuery extends GoalEvidenceScope {
  resultRevision: number;
  requirementsRevision: number;
  afterResultRevision: number;
  afterUpdatedAt?: string;
  cursor?: string;
}
export interface GoalEvidenceChange {
  revision: number;
  resultId: string;
  workId: string;
  status: string;
  verification: string;
  summary: string;
  isLate: boolean;
  isAuthoritative: boolean;
  handoffStatus: WorkHandoffStatus;
  handoffCharacters: number;
  handoff?: WorkHandoff;
  handoffOmitted?: true;
  handoffRef?: string;
  handoffReadHint?: string;
}
export interface GoalEvidenceChangesPage { changedResults: GoalEvidenceChange[]; totalChanges: number; nextCursor?: string }
export interface GoalEvidenceHandoffPage extends GoalEvidencePage { resultId: string; handoffStatus: WorkHandoffStatus }
export interface GoalEvidenceStatePage extends GoalEvidencePage { outcomeId: string; stateStatus: "PROVIDED" | "MISSING" }
export interface GoalEvidenceRepository {
  readIdentity?(input: GoalEvidenceScope & { resultId: string }): Promise<{ status: string; isLate: boolean; isAuthoritative: boolean } | null>;
  assertReferences(input: GoalEvidenceScope & { resultIds: string[] }): Promise<void>;
  index(input: GoalEvidenceScope & { cursor?: string }): Promise<GoalEvidencePage>;
  readConclusion(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }): Promise<GoalEvidencePage>;
  readChanges?(input: GoalEvidenceChangesQuery): Promise<GoalEvidenceChangesPage>;
  readHandoff?(input: GoalEvidenceScope & { resultId: string; cursor?: string }): Promise<GoalEvidenceHandoffPage>;
  readState?(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }): Promise<GoalEvidenceStatePage>;
}
