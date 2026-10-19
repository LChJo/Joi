/* SQLite implements the asynchronous port with synchronous transactions. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import type { GoalEvidenceCatalog, GoalEvidenceRepository, GoalEvidenceScope } from "../../application/ports/goal-evidence.js";
import { DomainError } from "../../domain/errors.js";

interface TransactionalDatabase { transaction<T>(operation: (connection: DatabaseSync) => T): T }

export function loadGoalEvidenceCatalog(connection: DatabaseSync, scope: GoalEvidenceScope): GoalEvidenceCatalog {
  const results = connection.prepare(`SELECT r.result_id AS resultId,r.work_id AS workId,w.title,b.body,r.status,
    COALESCE(v.status,'UNVERIFIED') AS verificationStatus,r.is_late AS isLate,r.is_authoritative AS isAuthoritative,
    r.artifacts_json AS artifactsJson,
    (w.status='COMPLETED' AND r.action_id=(SELECT a.action_id FROM dispatch_attempts a WHERE a.work_id=w.work_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1)) AS eligible
    FROM work_results r JOIN work_items w ON w.work_id=r.work_id JOIN work_result_bodies b ON b.body_ref=r.body_ref
    LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
    WHERE w.input_id=? AND r.workbench_id=? AND w.workbench_id=?
    ORDER BY r.created_at DESC,r.rowid DESC`).all(scope.goalInputId,scope.workbenchId,scope.workbenchId) as unknown as (Omit<GoalEvidenceCatalog["results"][number], "isLate" | "isAuthoritative" | "eligible"> & { isLate: number; isAuthoritative: number; eligible: number; artifactsJson: string })[];
  const conclusions: GoalEvidenceCatalog["conclusions"] = [];
  if (connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='joi_goal_outcome_history'").get() !== undefined) {
    const history = connection.prepare(`SELECT result_revision,requirements_revision,disposition,completion_summary
      FROM joi_goal_outcome_history WHERE goal_input_id=? AND EXISTS (
        SELECT 1 FROM joi_inbox_messages i WHERE i.input_id=? AND (i.workbench_id=? OR (i.workbench_id IS NULL AND EXISTS (
          SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.workbench_id=?))))
      ORDER BY result_revision DESC,requirements_revision DESC`).all(scope.goalInputId,scope.goalInputId,scope.workbenchId,scope.workbenchId);
    for (const row of history) conclusions.push({ outcomeId: `r${String(row.result_revision)}:q${String(row.requirements_revision)}`, body: row.completion_summary as string, disposition: row.disposition as string, resultRevision: row.result_revision as number, requirementsRevision: row.requirements_revision as number });
  }
  const current = connection.prepare(`SELECT o.* FROM joi_goal_outcomes o JOIN joi_inbox_messages i ON i.input_id=o.input_id
    WHERE o.input_id=? AND (i.workbench_id=? OR (i.workbench_id IS NULL AND EXISTS (
      SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.workbench_id=?)))`).get(scope.goalInputId,scope.workbenchId,scope.workbenchId);
  const currentRequirementsRevision = typeof current?.requirements_revision === "number" ? current.requirements_revision : 0;
  const archived = conclusions.find(c => c.resultRevision === current?.result_revision && c.requirementsRevision === currentRequirementsRevision);
  if (current !== undefined && (archived === undefined || archived.body !== current.completion_summary || archived.disposition !== current.disposition)) {
    conclusions.unshift({ outcomeId: `r${String(current.result_revision)}:q${String(currentRequirementsRevision)}${archived === undefined ? "" : ":current"}`, body: current.completion_summary as string, disposition: current.disposition as string, resultRevision: current.result_revision as number, requirementsRevision: currentRequirementsRevision });
  }
  return { results: results.map(({ artifactsJson,...row }) => {
    const artifacts = JSON.parse(artifactsJson) as unknown[];
    return { ...row,eligible: Boolean(row.eligible),isLate: Boolean(row.isLate),isAuthoritative: Boolean(row.isAuthoritative),artifactCount: artifacts.length,artifacts: artifacts.slice(0,25) };
  }),conclusions };
}

export function assertGoalEvidenceReferences(connection: DatabaseSync, input: GoalEvidenceScope & { resultIds: string[] }): void {
  for (const id of input.resultIds) {
    if (typeof id !== "string" || id.trim() === "" || connection.prepare(`SELECT 1 FROM work_results r JOIN work_items w ON w.work_id=r.work_id
      JOIN work_result_bodies b ON b.body_ref=r.body_ref WHERE r.result_id=? AND w.input_id=? AND w.workbench_id=? AND r.workbench_id=?`)
      .get(id,input.goalInputId,input.workbenchId,input.workbenchId) === undefined) throw new DomainError("work_evidence_reference_invalid", "Evidence must reference a stored result in this goal and Workbench.");
  }
}

function page(content: string,cursor?: string) {
  if (cursor !== undefined && !/^(?:0|[1-9]\d*)$/u.test(cursor)) throw new DomainError("work_result_cursor_invalid","Evidence cursor is invalid.");
  const offset = Number(cursor ?? 0);
  if (!Number.isSafeInteger(offset)) throw new DomainError("work_result_cursor_invalid","Evidence cursor is invalid.");
  const chunk = content.slice(offset,offset + 8_000);
  return { content: chunk,totalCharacters: content.length,...(offset + chunk.length < content.length ? { nextCursor: String(offset + chunk.length) } : {}) };
}

export function goalEvidenceIndex(catalog: GoalEvidenceCatalog): string {
  return JSON.stringify({ results: catalog.results.map(({ body,...row },index) => ({ ...row,bodyCharacters: body.length,file: `result-${String(index)}.txt` })),
    conclusions: catalog.conclusions.map(({ body,...row },index) => ({ ...row,bodyCharacters: body.length,file: `conclusion-${String(index)}.txt` })),
    read: "work_read_result(resultId,cursor); work_read_evidence(mode=conclusion,outcomeId,cursor). Default page 8000 characters. Failed, late and unverified results are historical evidence, not accepted success." });
}

export class SqliteGoalEvidenceRepository implements GoalEvidenceRepository {
  constructor(private readonly database: TransactionalDatabase) {}
  async readIdentity(input: GoalEvidenceScope & { resultId: string }) {
    return this.database.transaction(c => {
      const row = c.prepare(`SELECT r.status,r.is_late,r.is_authoritative FROM work_results r JOIN work_items w ON w.work_id=r.work_id
        WHERE r.result_id=? AND w.input_id=? AND w.workbench_id=? AND r.workbench_id=?`).get(input.resultId,input.goalInputId,input.workbenchId,input.workbenchId);
      return row === undefined ? null : { status: row.status as string,isLate: Boolean(row.is_late),isAuthoritative: Boolean(row.is_authoritative) };
    });
  }
  async assertReferences(input: GoalEvidenceScope & { resultIds: string[] }) { this.database.transaction(c => assertGoalEvidenceReferences(c,input)); }
  async index(input: GoalEvidenceScope & { cursor?: string }) { return this.database.transaction(c => page(goalEvidenceIndex(loadGoalEvidenceCatalog(c,input)),input.cursor)); }
  async readConclusion(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }) {
    return this.database.transaction(c => {
      const conclusion = loadGoalEvidenceCatalog(c,input).conclusions.find(row => row.outcomeId === input.outcomeId);
      if (conclusion === undefined) throw new DomainError("goal_evidence_not_found","Conclusion was not found in this goal.");
      return page(conclusion.body,input.cursor);
    });
  }
}
