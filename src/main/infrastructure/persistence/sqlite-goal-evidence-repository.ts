/* SQLite implements the asynchronous port with synchronous transactions. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import type { GoalEvidenceCatalog,GoalEvidenceChange,GoalEvidenceChangesPage,GoalEvidenceChangesQuery,GoalEvidenceRepository,GoalEvidenceScope } from "../../application/ports/goal-evidence.js";
import { DomainError } from "../../domain/errors.js";
import { parseWorkHandoff,type WorkHandoffStatus } from "../../domain/work/work-handoff.js";

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

// UTF-8 leading bytes F0..F4 identify exactly the codepoints that occupy two UTF-16 units.
function utf16Length(expression: string): string {
  const stripped = ["F0","F1","F2","F3","F4"].reduce((value,byte) => `replace(${value},CAST(x'${byte}' AS TEXT),'')`,expression);
  return `(length(${expression})+length(CAST(${expression} AS BLOB))-length(CAST(${stripped} AS BLOB)))`;
}

function hasColumn(connection: DatabaseSync,table: string,column: string): boolean {
  return connection.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name=?").get(table,column) !== undefined;
}

function conclusionQuery(connection: DatabaseSync, historySnapshot?: number,version?: { result: number; requirements: number },includeState = false): string {
  const hasHistory = connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='joi_goal_outcome_history'").get() !== undefined;
  const stateEqual = !hasHistory || !hasColumn(connection,"joi_goal_outcome_history","synthesis_state_json") || !hasColumn(connection,"joi_goal_outcomes","synthesis_state_json") ? "" : `AND NOT EXISTS (
    SELECT 1 FROM joi_goal_outcome_history oldState JOIN joi_goal_outcomes newState ON newState.input_id=oldState.goal_input_id
    JOIN scope requestedScope ON requestedScope.goalId=newState.input_id
    WHERE oldState.result_revision=c.resultRevision AND oldState.requirements_revision=c.requirementsRevision
      AND newState.result_revision=c.resultRevision AND COALESCE(newState.requirements_revision,0)=c.requirementsRevision
      AND oldState.synthesis_state_json IS NOT newState.synthesis_state_json)`;
  return `WITH scope AS (SELECT ? AS goalId,? AS workbenchId), authorized AS (
    SELECT i.input_id FROM joi_inbox_messages i JOIN scope s ON s.goalId=i.input_id
    WHERE i.workbench_id=s.workbenchId OR (i.workbench_id IS NULL AND EXISTS (
      SELECT 1 FROM work_items w WHERE w.input_id=i.input_id AND w.workbench_id=s.workbenchId))),
    history AS (${hasHistory ? `SELECT h.result_revision AS resultRevision,h.requirements_revision AS requirementsRevision,
      h.disposition,h.completion_summary AS body ${includeState ? `,${hasColumn(connection,"joi_goal_outcome_history","synthesis_state_json") ? "h.synthesis_state_json" : "NULL"} AS synthesisState` : ""}
      FROM joi_goal_outcome_history h JOIN authorized a ON a.input_id=h.goal_input_id
      WHERE 1 ${historySnapshot === undefined ? "" : `AND h.rowid<=${String(historySnapshot)}`}
      ${version === undefined ? "" : `AND h.result_revision=${String(version.result)} AND h.requirements_revision=${String(version.requirements)}`}` : `SELECT 0 AS resultRevision,0 AS requirementsRevision,'' AS disposition,'' AS body ${includeState ? ",NULL AS synthesisState" : ""} WHERE 0`}),
    current AS (SELECT o.result_revision AS resultRevision,COALESCE(o.requirements_revision,0) AS requirementsRevision,
      o.disposition,o.completion_summary AS body ${includeState ? `,${hasColumn(connection,"joi_goal_outcomes","synthesis_state_json") ? "o.synthesis_state_json" : "NULL"} AS synthesisState` : ""}
      FROM joi_goal_outcomes o JOIN authorized a ON a.input_id=o.input_id
      ${version === undefined ? "" : `WHERE o.result_revision=${String(version.result)} AND COALESCE(o.requirements_revision,0)=${String(version.requirements)}`}),
    conclusions AS (SELECT 'r'||resultRevision||':q'||requirementsRevision AS outcomeId,1 AS sortKind,* FROM history
      UNION ALL SELECT 'r'||c.resultRevision||':q'||c.requirementsRevision||CASE WHEN EXISTS (
        SELECT 1 FROM history h WHERE h.resultRevision=c.resultRevision AND h.requirementsRevision=c.requirementsRevision) THEN ':current' ELSE '' END,
      0,c.* FROM current c WHERE NOT EXISTS (SELECT 1 FROM history h WHERE h.resultRevision=c.resultRevision
        AND h.requirementsRevision=c.requirementsRevision AND h.body=c.body AND h.disposition=c.disposition ${stateEqual}))`;
}

interface IndexCursor {
  scope: string;
  snapshot: number;
  historySnapshot: number;
  phase: "results" | "conclusions";
  after?: [string,number] | [number,number,number];
}
const evidenceReadHint = "Each page is independent JSON metadata. Follow nextCursor; work_read_result(resultId,cursor) and work_read_evidence(mode=conclusion,outcomeId,cursor) read full bodies. Failed, late and unverified results are historical evidence, not accepted success.";

function decodeCursor<T>(cursor: string,prefix: string,valid: (value: unknown) => value is T): T {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor.slice(prefix.length),"base64url").toString("utf8")) as unknown; } catch { /* Invalid cursors share one public error. */ }
  if (!cursor.startsWith(prefix) || !valid(value)) throw new DomainError("work_result_cursor_invalid","Evidence cursor is invalid.");
  return value;
}

function encodeCursor(prefix: string,value: unknown): string { return prefix + Buffer.from(JSON.stringify(value)).toString("base64url"); }

function outcomeVersion(outcomeId: string) {
  const match = /^r(0|[1-9]\d*):q(0|[1-9]\d*)(?::current)?$/u.exec(outcomeId);
  if (match === null || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))) throw new DomainError("goal_evidence_not_found","Conclusion was not found in this goal.");
  return { result: Number(match[1]),requirements: Number(match[2]) };
}

function readSqlText(connection: DatabaseSync,query: string,parameters: (string | number)[],binding: string,cursor?: string) {
  const identity = connection.prepare(`${query} SELECT text IS NOT NULL AS available,length(COALESCE(text,'')) AS codepoints,${utf16Length("COALESCE(text,'')")} AS total FROM requested`).get(...parameters);
  if (identity === undefined) throw new DomainError("goal_evidence_not_found","Evidence was not found in this goal.");
  let offset = 0;
  if (cursor !== undefined) {
    if (/^(?:0|[1-9]\d*)$/u.test(cursor)) {
      const legacyOffset = Number(cursor);
      if (!Number.isSafeInteger(legacyOffset)) throw new DomainError("work_result_cursor_invalid","Evidence cursor is invalid.");
      let low = 0; let high = identity.codepoints as number;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const units = connection.prepare(`${query}, prefix AS (SELECT substr(text,1,?) AS bodyPrefix FROM requested)
          SELECT ${utf16Length("bodyPrefix")} AS n FROM prefix`).get(...parameters,middle)?.n as number;
        if (units <= legacyOffset) low = middle; else high = middle - 1;
      }
      offset = low;
    } else offset = decodeCursor(cursor,"c1:",(value): value is { binding: string; offset: number } => value !== null && typeof value === "object"
      && (value as { binding?: unknown }).binding === binding && Number.isSafeInteger((value as { offset?: unknown }).offset) && ((value as { offset: number }).offset >= 0)).offset;
  }
  const row = connection.prepare(`${query} SELECT substr(COALESCE(text,''),?+1,8000) AS content FROM requested`).get(...parameters,offset);
  const bounded = (row?.content as string).slice(0,8000);
  const content = /[\uD800-\uDBFF]$/u.test(bounded) ? bounded.slice(0,-1) : bounded;
  const nextOffset = offset + Array.from(content).length;
  return { content,totalCharacters: identity.total as number,available: identity.available === 1,
    ...(nextOffset < (identity.codepoints as number) ? { nextCursor: encodeCursor("c1:",{ binding,offset: nextOffset }) } : {}) };
}

function textPage({ available: _available,...page }: ReturnType<typeof readSqlText>) { return page; }

/** The result/requirements pair and delta baseline bind every continuation to one synthesis view. */
export function loadGoalEvidenceChanges(connection: DatabaseSync,input: GoalEvidenceChangesQuery): GoalEvidenceChangesPage {
  if ([input.resultRevision,input.requirementsRevision,input.afterResultRevision].some(value => !Number.isSafeInteger(value) || value < 0)
    || input.afterResultRevision > input.resultRevision) throw new DomainError("goal_evidence_revision_invalid","Evidence revisions are invalid.");
  const binding = JSON.stringify([input.goalInputId,input.workbenchId,input.resultRevision,input.requirementsRevision,input.afterResultRevision,input.afterUpdatedAt ?? null]);
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor,"d1:",(value): value is { binding: string; revision: number; resultId: string } => value !== null && typeof value === "object"
    && (value as { binding?: unknown }).binding === binding && Number.isSafeInteger((value as { revision?: unknown }).revision)
    && typeof (value as { resultId?: unknown }).resultId === "string");
  const query = `WITH candidates AS (
    SELECT MIN(m.revision) AS revision,r.result_id AS resultId
    FROM joi_goal_result_members m JOIN partner_result_events e ON e.event_id=m.event_id
    JOIN work_results r ON r.run_id=e.run_id AND r.status=e.status
    JOIN work_items w ON w.work_id=r.work_id JOIN joi_inbox_messages i ON i.input_id=m.original_input_id
    LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
    WHERE m.original_input_id=? AND m.revision<=? AND w.workbench_id=? AND w.input_id=m.original_input_id
      ${hasColumn(connection,"work_results","workbench_id") ? "AND r.workbench_id=w.workbench_id" : ""}
      AND (i.workbench_id=w.workbench_id OR i.workbench_id IS NULL)
      AND (m.revision>? OR (? IS NOT NULL AND v.created_at>?) OR EXISTS (
        SELECT 1 FROM joi_goal_result_members newer JOIN partner_result_events ne ON ne.event_id=newer.event_id
        WHERE newer.original_input_id=m.original_input_id AND ne.work_id=r.work_id AND newer.revision>? AND newer.revision<=?))
    GROUP BY r.result_id)`;
  const parameters = [input.goalInputId,input.resultRevision,input.workbenchId,input.afterResultRevision,input.afterUpdatedAt ?? null,input.afterUpdatedAt ?? null,input.afterResultRevision,input.resultRevision];
  const totalChanges = connection.prepare(`${query} SELECT COUNT(*) AS n FROM candidates`).get(...parameters)?.n as number;
  const handoff = hasColumn(connection,"work_results","handoff_json") ? "r.handoff_json" : "NULL";
  const handoffStatus = hasColumn(connection,"work_results","handoff_status") ? "r.handoff_status" : "'MISSING'";
  const rows = connection.prepare(`${query}, selected AS MATERIALIZED (SELECT revision,resultId FROM candidates ${after === undefined ? "" : "WHERE (revision,resultId)>(?,?)"}
    ORDER BY revision,resultId LIMIT 17)
    SELECT selected.revision,r.result_id AS resultId,r.work_id AS workId,r.status,substr(r.summary,1,320) AS summary,
      r.is_late AS isLate,r.is_authoritative AS isAuthoritative,COALESCE(v.status,'UNVERIFIED') AS verification,
      ${handoffStatus} AS handoffStatus,${utf16Length(`COALESCE(${handoff},'')`)} AS handoffCharacters,
      CASE WHEN ${utf16Length(`COALESCE(${handoff},'')`)}<=4000 THEN ${handoff} ELSE NULL END AS handoffJson
    FROM selected JOIN work_results r ON r.result_id=selected.resultId LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
    ORDER BY selected.revision,r.result_id`).all(...parameters,...(after === undefined ? [] : [after.revision,after.resultId]));
  const changedResults = rows.slice(0,16).map(row => {
    const result: GoalEvidenceChange = { revision: row.revision as number,resultId: row.resultId as string,workId: row.workId as string,
      status: row.status as string,verification: row.verification as string,summary: row.summary as string,isLate: row.isLate === 1,isAuthoritative: row.isAuthoritative === 1,
      handoffStatus: ["PROVIDED","INVALID"].includes(row.handoffStatus as string) ? row.handoffStatus as WorkHandoffStatus : "MISSING",handoffCharacters: row.handoffCharacters as number };
    if (result.handoffStatus === "PROVIDED" && result.handoffCharacters > 4000) return { ...result,handoffOmitted: true as const,handoffRef: result.resultId,handoffReadHint: "Read work_read_evidence(mode=handoff,resultId,cursor) for the complete private handoff; the display preview does not replace it." };
    if (result.handoffStatus === "PROVIDED") {
      let value: unknown;
      try { value = JSON.parse(row.handoffJson as string) as unknown; } catch { /* Invalid stored metadata remains untrusted. */ }
      const parsed = parseWorkHandoff(value);
      if (parsed.status === "PROVIDED") result.handoff = parsed.handoff; else result.handoffStatus = "INVALID";
    }
    return result;
  });
  const last = changedResults.at(-1);
  return { changedResults,totalChanges,...(rows.length > 16 && last !== undefined ? { nextCursor: encodeCursor("d1:",{ binding,revision: last.revision,resultId: last.resultId }) } : {}) };
}

function resultMetadataQuery(source = "work_results",rowId = "r.rowid",includeArtifacts = false): string {
  return `SELECT r.result_id AS resultId,r.work_id AS workId,${includeArtifacts ? "w.title" : "substr(w.title,1,240)"} AS title,r.status,
    COALESCE(v.status,'UNVERIFIED') AS verificationStatus,r.is_late AS isLate,r.is_authoritative AS isAuthoritative,
    (w.status='COMPLETED' AND r.action_id=(SELECT a.action_id FROM dispatch_attempts a WHERE a.work_id=w.work_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1)) AS eligible,
    json_array_length(r.artifacts_json) AS artifactCount,${utf16Length("b.body")} AS bodyCharacters,r.created_at AS createdAt,${rowId} AS rowId
    ${includeArtifacts ? ",r.artifacts_json AS artifactsJson" : ""}
    FROM ${source} r JOIN work_items w ON w.work_id=r.work_id JOIN work_result_bodies b ON b.body_ref=r.body_ref
    LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
    WHERE w.input_id=? AND r.workbench_id=? AND w.workbench_id=?`;
}

type ResultMetadata = Omit<GoalEvidenceCatalog["results"][number],"body" | "artifacts" | "isLate" | "isAuthoritative" | "eligible"> & {
  isLate: number; isAuthoritative: number; eligible: number; bodyCharacters: number; createdAt: string; rowId: number;
  artifactsJson?: string;
};

function projectMetadata({ createdAt: _createdAt,rowId: _rowId,...row }: ResultMetadata) {
  return { ...row,isLate: Boolean(row.isLate),isAuthoritative: Boolean(row.isAuthoritative),eligible: Boolean(row.eligible) };
}

function legacyIndex(connection: DatabaseSync,input: GoalEvidenceScope & { cursor: string }) {
  const rows = connection.prepare(`${resultMetadataQuery("work_results","r.rowid",true)} ORDER BY r.created_at DESC,r.rowid DESC`).all(input.goalInputId,input.workbenchId,input.workbenchId) as unknown as ResultMetadata[];
  const conclusions = connection.prepare(`${conclusionQuery(connection)} SELECT outcomeId,disposition,resultRevision,requirementsRevision,${utf16Length("body")} AS bodyCharacters
    FROM conclusions ORDER BY sortKind,resultRevision DESC,requirementsRevision DESC`).all(input.goalInputId,input.workbenchId);
  const content = JSON.stringify({ results: rows.map((row,index) => ({ resultId: row.resultId,workId: row.workId,title: row.title,status: row.status,
    verificationStatus: row.verificationStatus,isLate: Boolean(row.isLate),isAuthoritative: Boolean(row.isAuthoritative),eligible: Boolean(row.eligible),
    artifactCount: row.artifactCount,artifacts: (JSON.parse(row.artifactsJson ?? "[]") as unknown[]).slice(0,25),bodyCharacters: row.bodyCharacters,file: `result-${String(index)}.txt` })),
    conclusions: conclusions.map((row,index) => ({ ...row,file: `conclusion-${String(index)}.txt` })),
    read: "work_read_result(resultId,cursor); work_read_evidence(mode=conclusion,outcomeId,cursor). Default page 8000 characters. Failed, late and unverified results are historical evidence, not accepted success." });
  return page(content,input.cursor);
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
  async index(input: GoalEvidenceScope & { cursor?: string }) {
    return this.database.transaction(c => {
      if (input.cursor !== undefined && /^(?:0|[1-9]\d*)$/u.test(input.cursor)) return legacyIndex(c,{ ...input,cursor: input.cursor });
      const scope = JSON.stringify([input.goalInputId,input.workbenchId]);
      const state: IndexCursor = input.cursor === undefined ? {
        scope,snapshot: c.prepare("SELECT COALESCE(MAX(r.rowid),0) AS n FROM work_results r JOIN work_items w ON w.work_id=r.work_id WHERE w.input_id=? AND w.workbench_id=? AND r.workbench_id=?").get(input.goalInputId,input.workbenchId,input.workbenchId)?.n as number,
        historySnapshot: c.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='joi_goal_outcome_history'").get() === undefined ? 0
          : c.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM joi_goal_outcome_history WHERE goal_input_id=?").get(input.goalInputId)?.n as number,
        phase: "results",
      } : decodeCursor(input.cursor,"e1:",(value): value is IndexCursor => {
        if (value === null || typeof value !== "object") return false;
        const candidate = value as { scope?: unknown; snapshot?: unknown; historySnapshot?: unknown; phase?: unknown; after?: unknown };
        return candidate.scope === scope && typeof candidate.snapshot === "number" && Number.isSafeInteger(candidate.snapshot) && candidate.snapshot >= 0
          && typeof candidate.historySnapshot === "number" && Number.isSafeInteger(candidate.historySnapshot) && candidate.historySnapshot >= 0
          && (candidate.phase === "results" || candidate.phase === "conclusions") && (candidate.after === undefined
            || (Array.isArray(candidate.after) && (candidate.phase === "results" ? candidate.after.length === 2 && typeof candidate.after[0] === "string" && Number.isSafeInteger(candidate.after[1])
              : candidate.after.length === 3 && candidate.after.every(part => typeof part === "number" && Number.isSafeInteger(part)))));
      });
      let next: IndexCursor | undefined;
      let results: ReturnType<typeof projectMetadata>[] = [];
      let conclusions: Record<string,unknown>[] = [];
      if (state.phase === "results") {
        const parameters: (string | number)[] = [input.goalInputId,input.workbenchId,input.workbenchId,state.snapshot];
        if (state.after !== undefined) parameters.push(...state.after);
        const rows = c.prepare(`WITH selected AS MATERIALIZED (SELECT r.rowid AS storageRowId,r.result_id,r.work_id,r.workbench_id,r.body_ref,r.status,
          r.is_late,r.is_authoritative,r.artifacts_json,r.created_at,r.action_id FROM work_results r JOIN work_items w ON w.work_id=r.work_id
          WHERE w.input_id=? AND r.workbench_id=? AND w.workbench_id=? AND r.rowid<=? ${state.after === undefined ? "" : "AND (r.created_at,r.rowid)<(?,?)"}
          AND EXISTS (SELECT 1 FROM work_result_bodies stored WHERE stored.body_ref=r.body_ref)
          ORDER BY r.created_at DESC,r.rowid DESC LIMIT 9)
          ${resultMetadataQuery("selected","r.storageRowId")} ORDER BY r.created_at DESC,r.storageRowId DESC`)
          .all(...parameters,input.goalInputId,input.workbenchId,input.workbenchId) as unknown as ResultMetadata[];
        const selected = rows.slice(0,8);
        results = selected.map(projectMetadata);
        const last = selected.at(-1);
        next = rows.length > 8 && last !== undefined ? { ...state,after: [last.createdAt,last.rowId] } : { ...state,phase: "conclusions" };
        if (next.phase === "conclusions") delete next.after;
      } else {
        const parameters: (string | number)[] = [input.goalInputId,input.workbenchId];
        if (state.after !== undefined) { const [kind,revision,requirements] = state.after as [number,number,number]; parameters.push(kind,kind,revision,requirements); }
        const rows = c.prepare(`${conclusionQuery(c,state.historySnapshot)} SELECT outcomeId,disposition,resultRevision,requirementsRevision,sortKind,${utf16Length("body")} AS bodyCharacters
          FROM conclusions ${state.after === undefined ? "" : "WHERE sortKind>? OR (sortKind=? AND (resultRevision,requirementsRevision)<(?,?))"}
          ORDER BY sortKind,resultRevision DESC,requirementsRevision DESC LIMIT 9`).all(...parameters);
        const selected = rows.slice(0,8);
        conclusions = selected.map(({ sortKind: _sortKind,...row }) => row);
        const last = selected.at(-1);
        if (rows.length > 8 && last !== undefined) next = { ...state,after: [last.sortKind as number,last.resultRevision as number,last.requirementsRevision as number] };
      }
      const content = JSON.stringify({ results,conclusions,read: evidenceReadHint });
      if (content.length > 8000) throw new DomainError("goal_evidence_metadata_capacity","Evidence metadata exceeded its page capacity.");
      return { content,totalCharacters: content.length,...(next === undefined ? {} : { nextCursor: encodeCursor("e1:",next) }) };
    });
  }
  async readConclusion(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }) {
    return this.database.transaction(c => {
      const query = `${conclusionQuery(c,undefined,outcomeVersion(input.outcomeId))}, requested AS (SELECT body AS text FROM conclusions WHERE outcomeId=?)`;
      return textPage(readSqlText(c,query,[input.goalInputId,input.workbenchId,input.outcomeId],JSON.stringify([input.goalInputId,input.workbenchId,input.outcomeId]),input.cursor));
    });
  }

  async readChanges(input: GoalEvidenceChangesQuery) { return this.database.transaction(c => loadGoalEvidenceChanges(c,input)); }

  async readHandoff(input: GoalEvidenceScope & { resultId: string; cursor?: string }) {
    return this.database.transaction(c => {
      const hasHandoff = hasColumn(c,"work_results","handoff_json");
      const status = hasColumn(c,"work_results","handoff_status") ? "r.handoff_status" : "'MISSING'";
      const query = `WITH requested AS (SELECT ${hasHandoff ? "r.handoff_json" : "NULL"} AS text,${status} AS handoffStatus
        FROM work_results r JOIN work_items w ON w.work_id=r.work_id WHERE r.result_id=? AND w.input_id=? AND w.workbench_id=? AND r.workbench_id=?)`;
      const parameters = [input.resultId,input.goalInputId,input.workbenchId,input.workbenchId];
      const identity = c.prepare(`${query} SELECT handoffStatus FROM requested`).get(...parameters);
      const page = textPage(readSqlText(c,query,parameters,JSON.stringify(["handoff",input.goalInputId,input.workbenchId,input.resultId]),input.cursor));
      const handoffStatus: WorkHandoffStatus = identity?.handoffStatus === "PROVIDED" || identity?.handoffStatus === "INVALID" ? identity.handoffStatus : "MISSING";
      return { ...page,resultId: input.resultId,handoffStatus };
    });
  }

  async readState(input: GoalEvidenceScope & { outcomeId: string; cursor?: string }) {
    return this.database.transaction(c => {
      const query = `${conclusionQuery(c,undefined,outcomeVersion(input.outcomeId),true)}, requested AS (SELECT synthesisState AS text FROM conclusions WHERE outcomeId=?)`;
      const { available,...page } = readSqlText(c,query,[input.goalInputId,input.workbenchId,input.outcomeId],JSON.stringify(["state",input.goalInputId,input.workbenchId,input.outcomeId]),input.cursor);
      return { ...page,outcomeId: input.outcomeId,stateStatus: available ? "PROVIDED" as const : "MISSING" as const };
    });
  }
}
