import type { DatabaseSync } from "node:sqlite";
import type { JoiGoalCardBaseDto, WorkbenchArtifactDto } from "../../../shared/joi.js";
import { GOAL_ARTIFACT_PREVIEW_LIMIT, type GoalArtifactPage, type GoalArtifactPageDto } from "../../../shared/goal-artifacts.js";
import { DomainError } from "../../domain/errors.js";
import { workResultArtifactId } from "../../domain/work/workspace-artifact-reference.js";

interface ArtifactRow {
  result_id: string; artifact_index: number; relative_path: string; name: string;
  mime_type: string; size: number; directory: string; file_count: number;
}

const ROOT_KEY = "COALESCE(work_root.root_path,bound_root.root_path,r.workbench_id)";
const SOURCES = `FROM work_items w
  CROSS JOIN work_results r INDEXED BY idx_work_results_work_page ON r.work_id=w.work_id
  JOIN joi_inbox_messages goal ON goal.input_id=w.input_id
  LEFT JOIN work_run_directories work_root ON work_root.work_id=r.work_id AND work_root.workbench_id=r.workbench_id AND work_root.status='READY'
  LEFT JOIN workbench_workspace_bindings binding ON binding.workbench_id=r.workbench_id AND binding.status='READY'
  LEFT JOIN workbench_workspace_roots bound_root ON bound_root.workspace_ref=binding.workspace_ref`;
const SCOPE = `w.input_id=? AND r.workbench_id=? AND r.is_authoritative=1 AND r.status='COMPLETED'
  AND r.created_at>=COALESCE(goal.reopened_at,goal.created_at)`;
const ELIGIBLE = `${SOURCES} JOIN work_result_artifact_index a ON a.result_id=r.result_id
  WHERE ${SCOPE} AND a.mime_type<>'inode/directory'
    AND a.relative_path NOT GLOB '.*' AND a.relative_path NOT GLOB '*/.*'
    AND instr('/'||a.relative_path||'/','/node_modules/')=0
    AND instr('/'||a.relative_path||'/','/__pycache__/')=0
    AND lower(a.relative_path) NOT GLOB '*.py[co]'`;

// A file is identified inside its physical Work root; its newest authoritative observation supplies the metadata.
const FILES = `WITH ranked AS (
    SELECT a.*,${ROOT_KEY} AS root_key,
      ROW_NUMBER() OVER (PARTITION BY ${ROOT_KEY},a.relative_path ORDER BY r.created_at DESC,r.result_id DESC,a.artifact_index DESC) AS ordinal
    ${ELIGIBLE}
  ), files AS (
    SELECT *,rtrim(rtrim(relative_path,replace(relative_path,'/','')),'/') AS directory FROM ranked WHERE ordinal=1
  )`;
// Folder thresholds apply to the full current-round set, before a page is selected.
const DISPLAY = `${FILES}, directories AS (
    SELECT root_key,directory,COUNT(*) AS file_count,MIN(relative_path) AS representative FROM files GROUP BY root_key,directory
  ), display AS (
    SELECT f.result_id,f.artifact_index,f.relative_path,f.name,f.mime_type,f.size,f.root_key,f.directory,0 AS file_count,f.relative_path AS sort_path
      FROM files f JOIN directories d USING(root_key,directory) WHERE d.file_count<=3
    UNION ALL
    SELECT f.result_id,f.artifact_index,f.relative_path,CASE WHEN d.directory='' THEN '.' ELSE d.directory END AS name,
      'inode/directory' AS mime_type,0 AS size,f.root_key,d.directory,d.file_count,d.directory||'/' AS sort_path
      FROM directories d JOIN files f ON f.root_key=d.root_key AND f.relative_path=d.representative WHERE d.file_count>3
  )`;

function invalidPage(): never {
  throw new DomainError("goal_artifact_page_invalid", "Artifact paging is invalid.");
}

function dto(row: ArtifactRow): WorkbenchArtifactDto {
  return {
    artifactId: workResultArtifactId(row.result_id, row.artifact_index),
    kind: row.file_count > 0 ? "DIRECTORY" : "FILE", name: row.name, mimeType: row.mime_type, size: row.size,
    ...(row.directory === "" ? {} : { directory: row.directory }),
    ...(row.file_count > 0 ? { fileCount: row.file_count } : {}),
  };
}

export function readGoalArtifactPage(db: DatabaseSync, goalId: string, workbenchId: string, page: GoalArtifactPage): GoalArtifactPageDto {
  const limit = page.limit ?? GOAL_ARTIFACT_PREVIEW_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidPage();
  let anchor: { root_key: string; sort_path: string } | undefined;
  if (page.cursor !== undefined) {
    const parts = /^work_result_artifact:(.+):(\d+)$/u.exec(page.cursor);
    if (parts === null || !Number.isSafeInteger(Number(parts[2]))) invalidPage();
    anchor = db.prepare(`${DISPLAY} SELECT root_key,sort_path FROM display WHERE result_id=? AND artifact_index=?`)
      .get(goalId, workbenchId, parts[1] ?? "", Number(parts[2])) as typeof anchor;
    if (anchor === undefined) invalidPage();
  }
  const rows = db.prepare(`${DISPLAY} SELECT * FROM display
    WHERE (? IS NULL OR (root_key,sort_path)>(?,?)) ORDER BY root_key,sort_path LIMIT ?`)
    .all(goalId, workbenchId, anchor?.root_key ?? null, anchor?.root_key ?? null, anchor?.sort_path ?? null, limit + 1) as unknown as ArtifactRow[];
  const items = rows.slice(0, limit).map(dto);
  const last = items.at(-1);
  return { items, ...(rows.length > limit && last?.artifactId !== undefined ? { nextCursor: last.artifactId } : {}) };
}

export function goalArtifactPreview(db: DatabaseSync, goalId: string, workbenchId: string): Pick<JoiGoalCardBaseDto, "artifacts" | "artifactCount" | "artifactNextCursor"> {
  const count = db.prepare(`${FILES} SELECT COUNT(*) AS total FROM files`).get(goalId, workbenchId) as { total: number };
  if (count.total === 0) return {};
  const page = readGoalArtifactPage(db, goalId, workbenchId, {});
  return { artifacts: page.items, artifactCount: count.total, ...(page.nextCursor === undefined ? {} : { artifactNextCursor: page.nextCursor }) };
}

/** Source versions keep previews coherent with the same WAL snapshot as their callers. */
export class GoalArtifactPreviewCache {
  #connection: DatabaseSync | undefined;
  readonly #entries = new Map<string, { version: string; preview: ReturnType<typeof goalArtifactPreview> }>();

  retain(goalIds: ReadonlySet<string>): void {
    for (const goalId of this.#entries.keys()) if (!goalIds.has(goalId)) this.#entries.delete(goalId);
  }

  read(db: DatabaseSync, goalId: string, workbenchId: string): ReturnType<typeof goalArtifactPreview> {
    if (db !== this.#connection) { this.#connection = db; this.#entries.clear(); }
    const sources = db.prepare(`SELECT r.result_id,r.created_at,v.revision,${ROOT_KEY} AS root_key ${SOURCES}
      JOIN work_result_artifact_versions v ON v.result_id=r.result_id WHERE ${SCOPE} ORDER BY r.result_id`).all(goalId, workbenchId);
    const version = JSON.stringify([workbenchId, sources]);
    const cached = this.#entries.get(goalId);
    if (cached?.version === version) return structuredClone(cached.preview);
    const preview = sources.length === 0 ? {} : goalArtifactPreview(db, goalId, workbenchId);
    this.#entries.set(goalId, { version, preview });
    return structuredClone(preview);
  }
}

export function queryGoalArtifacts(db: DatabaseSync, goalId: string, page: GoalArtifactPage): GoalArtifactPageDto | null {
  const goal = db.prepare(`SELECT workbench_id FROM joi_inbox_messages
    WHERE input_id=? AND goal_input_id IS NULL AND dismissed_at IS NULL`).get(goalId) as { workbench_id: string | null } | undefined;
  if (goal === undefined) return null;
  return readGoalArtifactPage(db, goalId, goal.workbench_id ?? "", page);
}
