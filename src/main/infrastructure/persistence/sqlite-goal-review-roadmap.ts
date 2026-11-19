import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { GoalRoadmapPage, GoalRoadmapQuery } from "../../application/ports/goal-evidence.js";
import { DomainError } from "../../domain/errors.js";
import { workResultArtifactId } from "../../domain/work/workspace-artifact-reference.js";

const PAGE_SIZE = 8;
const unmapped = `NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.goal_input_id=w.input_id AND p.work_id=w.work_id)`;

function readOffset(cursor: string | undefined, scope: string, snapshot: string): number {
  if (cursor === undefined) return 0;
  let value: { scope?: unknown; snapshot?: unknown; offset?: unknown } | undefined;
  try {
    if (cursor.length <= 4096) value = JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")) as typeof value;
  } catch { /* Invalid cursors share one error. */ }
  if (value?.scope !== scope || typeof value.offset !== "number" || !Number.isSafeInteger(value.offset) || value.offset < 0) {
    throw new DomainError("work_result_cursor_invalid","Roadmap cursor is invalid.");
  }
  if (value.snapshot !== snapshot) throw new DomainError("goal_evidence_snapshot_stale","The goal changed. Read the first roadmap page again.");
  return value.offset;
}

export function readGoalRoadmap(db: DatabaseSync, input: GoalRoadmapQuery): GoalRoadmapPage {
  const { goalInputId,workbenchId,section = "paths",layer,workId,runId,resultId } = input;
  const goal = db.prepare(`SELECT m.revision AS mapRevision,substr(m.destination,1,320) AS destination,
      COALESCE(rs.revision,0) AS resultRevision,COALESCE(q.revision,0) AS requirementsRevision,
      COALESCE((SELECT MAX(source_revision) FROM joi_goal_requirement_sources s WHERE s.goal_input_id=g.input_id),0) AS sourceRevision,
      m.review_recovery_epoch AS reviewEpoch,rs.synthetic_input_id AS owner,
      o.result_revision AS outcomeResult,o.requirements_revision AS outcomeRequirements,o.disposition,o.completion_key AS completionKey,
      b.workspace_ref AS workspaceRef,b.kind AS workspaceKind,b.status AS workspaceStatus,substr(b.display_name,1,160) AS workspaceName
    FROM joi_inbox_messages g JOIN workbenches wb ON wb.workbench_id=? AND wb.status='ACTIVE'
    LEFT JOIN joi_harness_maps m ON m.goal_input_id=g.input_id AND m.workbench_id=wb.workbench_id
    LEFT JOIN joi_goal_result_sets rs ON rs.original_input_id=g.input_id
    LEFT JOIN joi_goal_requirements q ON q.goal_input_id=g.input_id AND q.workbench_id=wb.workbench_id
    LEFT JOIN joi_current_goal_outcomes o ON o.input_id=g.input_id
    LEFT JOIN workbench_workspace_bindings b ON b.workbench_id=wb.workbench_id
    WHERE g.input_id=? AND g.goal_input_id IS NULL AND g.dismissed_at IS NULL AND g.canceled_at IS NULL
      AND (g.workbench_id=wb.workbench_id OR (g.workbench_id IS NULL AND EXISTS
        (SELECT 1 FROM work_items w WHERE w.input_id=g.input_id AND w.workbench_id=wb.workbench_id)))`).get(workbenchId,goalInputId);
  if (goal === undefined) throw new DomainError("goal_evidence_not_found","Evidence was not found in this goal.");

  const counts = {
    paths: db.prepare("SELECT COUNT(*) AS n FROM joi_harness_paths WHERE goal_input_id=?").get(goalInputId)?.n as number,
    decisions: db.prepare("SELECT COUNT(*) AS n FROM joi_harness_decisions WHERE goal_input_id=?").get(goalInputId)?.n as number,
    fog: db.prepare("SELECT COUNT(*) AS n FROM joi_harness_fog WHERE goal_input_id=?").get(goalInputId)?.n as number,
    unmapped: db.prepare(`SELECT COUNT(*) AS n FROM work_items w WHERE w.input_id=? AND w.workbench_id=? AND ${unmapped}`).get(goalInputId,workbenchId)?.n as number,
    requirements: Number(db.prepare(`SELECT json_array_length(requirements_json) AS n FROM joi_goal_requirement_snapshots
      WHERE goal_input_id=? AND revision=?`).get(goalInputId,goal.requirementsRevision ?? 0)?.n ?? 0),
  };
  const version = { mapRevision: goal.mapRevision as number | null,resultRevision: goal.resultRevision as number,requirementsRevision: goal.requirementsRevision as number };
  const params: SQLInputValue[] = [goalInputId];
  let select: string;
  let from: string;
  let order: string;
  switch (section) {
    case "paths":
      select = "p.path_id AS pathId,substr(p.title,1,240) AS title,p.layer,p.status,w.work_id AS workId,w.status AS workStatus,p.resolved_decision_id AS decisionId";
      from = "FROM joi_harness_paths p LEFT JOIN work_items w ON w.work_id=p.work_id AND w.input_id=p.goal_input_id AND w.workbench_id=? WHERE p.goal_input_id=?";
      params.unshift(workbenchId);
      if (layer !== undefined) { from += " AND p.layer=?"; params.push(layer); }
      order = "p.layer DESC,p.created_at DESC,p.path_id";
      break;
    case "decisions":
      select = "decision_id AS decisionId,kind,substr(summary,1,240) AS summary,substr(detail,1,480) AS detail";
      from = "FROM joi_harness_decisions WHERE goal_input_id=?";
      order = "created_at DESC,decision_id";
      break;
    case "fog":
      select = "fog_id AS fogId,status,substr(note,1,480) AS note,graduated_path_id AS pathId";
      from = "FROM joi_harness_fog WHERE goal_input_id=?";
      order = "created_at DESC,fog_id";
      break;
    case "unmapped":
      select = "w.work_id AS workId,substr(w.title,1,240) AS title,w.status";
      from = `FROM work_items w WHERE w.input_id=? AND w.workbench_id=? AND ${unmapped}`;
      params.push(workbenchId);
      order = "w.created_at DESC,w.work_id";
      break;
    case "runs":
      if (workId === undefined || db.prepare("SELECT 1 FROM work_items WHERE work_id=? AND input_id=? AND workbench_id=?")
        .get(workId,goalInputId,workbenchId) === undefined) throw new DomainError("goal_evidence_not_found","Evidence was not found in this goal.");
      select = `a.dispatch_attempt_id AS attemptId,a.status AS attemptStatus,run.run_id AS runId,
        run.kind AS engine,run.status AS runStatus,run.partner_revision_id AS partnerRevisionId,run.requirements_revision AS runRequirementsRevision,
        r.result_id AS resultId,r.status AS resultStatus,r.is_late AS isLate,r.is_authoritative AS isAuthoritative,
        CASE WHEN r.result_id IS NOT NULL THEN COALESCE(v.status,'UNVERIFIED') END AS verification,
        COALESCE(json_array_length(r.artifacts_json),0) AS artifactCount,
        a.dispatch_attempt_id=(SELECT latest.dispatch_attempt_id FROM dispatch_attempts latest
          WHERE latest.work_id=w.work_id ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1) AS isCurrentAttempt`;
      from = `FROM work_items w JOIN dispatch_attempts a ON a.work_id=w.work_id
        LEFT JOIN partner_runs run ON run.dispatch_attempt_id=a.dispatch_attempt_id AND run.workbench_id=w.workbench_id AND run.work_id=w.work_id
        LEFT JOIN work_results r ON r.run_id=run.run_id AND r.workbench_id=w.workbench_id AND r.work_id=w.work_id
        LEFT JOIN work_result_verifications v ON v.result_id=r.result_id
        WHERE w.input_id=? AND w.workbench_id=? AND w.work_id=?`;
      params.push(workbenchId,workId);
      order = "a.created_at DESC,a.rowid DESC,run.run_id,r.result_id";
      break;
    case "dependencies":
      select = "parent.work_id AS workId,substr(parent.title,1,240) AS title,parent.status";
      from = `FROM work_items w JOIN work_dependencies d ON d.work_id=w.work_id
        JOIN work_items parent ON parent.work_id=d.depends_on_work_id AND parent.input_id=w.input_id AND parent.workbench_id=w.workbench_id
        WHERE w.input_id=? AND w.workbench_id=? AND w.work_id=?`;
      params.push(workbenchId,workId ?? "");
      order = "parent.work_id";
      break;
    case "activity":
      select = "e.sequence,e.kind,e.role,substr(e.tool_name,1,120) AS toolName,e.created_at AS createdAt";
      from = `FROM work_items w JOIN partner_runs run ON run.work_id=w.work_id AND run.workbench_id=w.workbench_id
        JOIN workbench_agent_conversation_entries e ON e.run_id=run.run_id
        JOIN workbench_agent_sessions a ON a.agent_id=e.agent_id AND a.workbench_id=w.workbench_id AND a.dismissed_at IS NULL
        WHERE w.input_id=? AND w.workbench_id=? AND run.run_id=? AND e.kind IN ('TOOL_CALL','TOOL_RESULT','ARTIFACT','ERROR')`;
      params.push(workbenchId,runId ?? "");
      order = "e.sequence,e.entry_id";
      break;
    case "artifacts":
      select = "r.result_id AS resultId,a.artifact_index AS artifactIndex,substr(a.name,1,240) AS name,a.mime_type AS mimeType,a.size";
      from = `FROM work_items w JOIN work_results r ON r.work_id=w.work_id AND r.workbench_id=w.workbench_id
        JOIN work_result_artifact_index a ON a.result_id=r.result_id WHERE w.input_id=? AND w.workbench_id=? AND r.result_id=?`;
      params.push(workbenchId,resultId ?? "");
      order = "a.artifact_index";
      break;
    case "requirements":
      select = `json_extract(item.value,'$.id') AS requirementId,json_extract(item.value,'$.kind') AS kind,
        json_extract(item.value,'$.mandatory') AS mandatory,substr(json_extract(item.value,'$.text'),1,400) AS preview,
        json_extract(item.value,'$.source') AS source`;
      from = `FROM joi_goal_requirement_snapshots q JOIN json_each(q.requirements_json) item
        WHERE q.goal_input_id=? AND q.revision=?`;
      params.push(version.requirementsRevision);
      order = "mandatory DESC,item.key";
      break;
    case "reads":
      select = "DISTINCT e.result_id AS resultId,e.start_offset AS start,e.end_offset AS end";
      from = `FROM joi_goal_evidence_reads e JOIN work_results r ON r.result_id=e.result_id AND r.body_ref=e.source_ref
        WHERE e.goal_input_id=? AND r.workbench_id=? AND e.requirements_revision=? AND e.result_revision<=?`;
      params.push(workbenchId,version.requirementsRevision,version.resultRevision);
      if (resultId !== undefined) { from += " AND e.result_id=?"; params.push(resultId); }
      order = "resultId,start,end";
      break;
  }
  const countSql = section === "reads" ? `SELECT COUNT(*) AS n FROM (SELECT ${select} ${from})` : `SELECT COUNT(*) AS n ${from}`;
  const total = db.prepare(countSql).get(...params)?.n as number;
  const scope = JSON.stringify([goalInputId,workbenchId,section,layer ?? null,workId ?? null,runId ?? null,resultId ?? null]);
  const snapshot = JSON.stringify([version,goal.sourceRevision,goal.reviewEpoch,goal.owner,goal.completionKey,goal.workspaceRef,goal.workspaceStatus,counts,total]);
  const offset = readOffset(input.cursor,scope,snapshot);
  const rows = db.prepare(`SELECT ${select} ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params,PAGE_SIZE,offset);
  const entries = section === "artifacts" ? rows.map(({ resultId: id,artifactIndex,...row }) =>
    ({ ...row,artifactRef: workResultArtifactId(id as string,artifactIndex as number) })) : rows;
  const nextOffset = offset + entries.length;
  return { counts,entries,total,version,
    ...(typeof goal.destination === "string" ? { destination: goal.destination } : {}),
    ...(typeof goal.outcomeResult === "number" ? { outcomeId: `r${String(goal.outcomeResult)}:q${String(goal.outcomeRequirements ?? 0)}:current` } : {}),
    ...(typeof goal.disposition === "string" ? { disposition: goal.disposition } : {}),
    ...(typeof goal.workspaceRef === "string" && typeof goal.workspaceKind === "string" && typeof goal.workspaceStatus === "string"
      ? { workspace: { ref: goal.workspaceRef,name: typeof goal.workspaceName === "string" ? goal.workspaceName : null,kind: goal.workspaceKind,status: goal.workspaceStatus } } : {}),
    ...(nextOffset < total && entries.length > 0 ? { nextCursor: Buffer.from(JSON.stringify({ scope,snapshot,offset: nextOffset })).toString("base64url") } : {}),
  };
}
