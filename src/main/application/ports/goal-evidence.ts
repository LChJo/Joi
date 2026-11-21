import type { GoalEvidenceResult } from "../../domain/work/goal-evidence.js";
import type { WorkHandoff,WorkHandoffStatus } from "../../domain/work/work-handoff.js";

export interface GoalEvidenceScope { goalInputId: string; workbenchId: string }
export interface GoalResultReadReceipt extends GoalEvidenceScope {
  turnId: string;
  toolCallId: string;
  resultId: string;
  start: number;
  end: number;
}
export type GoalRoadmapSection = "paths" | "decisions" | "fog" | "unmapped" | "runs" | "dependencies" | "artifacts" | "activity" | "requirements" | "reads";
export interface GoalRoadmapQuery extends GoalEvidenceScope {
  section?: GoalRoadmapSection;
  workId?: string;
  runId?: string;
  resultId?: string;
  layer?: number;
  cursor?: string;
}
export interface GoalRoadmapPage {
  counts: Record<"paths" | "decisions" | "fog" | "unmapped" | "requirements", number>;
  currentLayer: number;
  currentLayerHasOpenPaths: boolean;
  entries: Record<string, unknown>[];
  total: number;
  version: { mapRevision: number | null; resultRevision: number; requirementsRevision: number };
  destination?: string;
  outcomeId?: string;
  disposition?: string;
  workspace?: { ref: string; name: string | null; kind: string; status: string };
  nextCursor?: string;
}
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
  metadataOnly?: boolean;
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
  recordResultRead?(input: GoalResultReadReceipt): Promise<void>;
  readRoadmap?(input: GoalRoadmapQuery): Promise<GoalRoadmapPage>;
  readIdentity?(input: GoalEvidenceScope & { resultId: string }): Promise<{ status: string; isLate: boolean; isAuthoritative: boolean } | null>;
  assertReferences(input: GoalEvidenceScope & { resultIds: string[] }): Promise<void>;
  index(input: GoalEvidenceScope & { cursor?: string }): Promise<GoalEvidencePage>;
  readConclusion(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }): Promise<GoalEvidencePage>;
  readChanges?(input: GoalEvidenceChangesQuery): Promise<GoalEvidenceChangesPage>;
  readHandoff?(input: GoalEvidenceScope & { resultId: string; cursor?: string }): Promise<GoalEvidenceHandoffPage>;
  readState?(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }): Promise<GoalEvidenceStatePage>;
}
