import type { DatabaseSync } from "node:sqlite";
import type { JoiGoalDetailDto, JoiGoalMapDetailDto, JoiGoalMapPathDto } from "../../../shared/joi.js";
import { sanitizeAgentConversationText } from "../../application/partners/agent-conversation-presentation.js";

type Row = Record<string, string | number | null>;
const display = (value: string | number | null | undefined): string => sanitizeAgentConversationText(String(value ?? "")).replace(/\r\n?/gu, "\n").trim();

/** The caller holds one read snapshot; every relation is scoped to the same original goal. */
export function queryJoiGoalDetail(db: DatabaseSync, goalId: string, page: { offset: number; limit: number }): JoiGoalDetailDto | null {
  const goal = db.prepare(`SELECT body, workbench_id FROM joi_inbox_messages
    WHERE input_id=? AND goal_input_id IS NULL AND dismissed_at IS NULL
      AND input_id NOT LIKE 'joi_result_input:%' AND input_id NOT LIKE 'joi_harness_review:%'`).get(goalId) as Row | undefined;
  if (goal === undefined) return null;
  const result: JoiGoalDetailDto = { goalId, fullTitle: display(goal.body) || "未命名目标" };
  const map = db.prepare(`SELECT m.destination, m.status, m.revision,
    (SELECT COALESCE(MAX(layer),0) FROM joi_harness_paths WHERE goal_input_id=m.goal_input_id) AS current_layer,
    (SELECT COUNT(*) FROM joi_harness_paths WHERE goal_input_id=m.goal_input_id) AS path_count,
    (SELECT COUNT(*) FROM joi_harness_decisions WHERE goal_input_id=m.goal_input_id) AS decision_count,
    (SELECT COUNT(*) FROM joi_harness_fog WHERE goal_input_id=m.goal_input_id) AS fog_count
    FROM joi_harness_maps m WHERE m.goal_input_id=? AND m.workbench_id=?`).get(goalId, goal.workbench_id ?? null) as Row | undefined;
  if (map === undefined) return result;
  const paths = db.prepare(`SELECT p.path_id,p.layer,p.title,p.status,w.work_id,w.status AS work_status,d.decision_id
    FROM joi_harness_paths p JOIN joi_harness_maps m ON m.goal_input_id=p.goal_input_id
    LEFT JOIN work_items w ON w.work_id=p.work_id AND w.input_id=p.goal_input_id AND w.workbench_id=m.workbench_id
    LEFT JOIN joi_harness_decisions d ON d.decision_id=p.resolved_decision_id AND d.goal_input_id=p.goal_input_id
    WHERE p.goal_input_id=? ORDER BY p.layer DESC,p.created_at DESC,p.path_id DESC LIMIT ? OFFSET ?`)
    .all(goalId, page.limit, page.offset) as Row[];
  const decisions = db.prepare(`SELECT decision_id,kind,summary,detail,created_at FROM joi_harness_decisions
    WHERE goal_input_id=? ORDER BY created_at DESC,decision_id DESC LIMIT ? OFFSET ?`).all(goalId, page.limit, page.offset) as Row[];
  const fog = db.prepare(`SELECT f.fog_id,f.note,f.status,p.path_id FROM joi_harness_fog f
    LEFT JOIN joi_harness_paths p ON p.path_id=f.graduated_path_id AND p.goal_input_id=f.goal_input_id
    WHERE f.goal_input_id=? ORDER BY f.created_at DESC,f.fog_id DESC LIMIT ? OFFSET ?`).all(goalId, page.limit, page.offset) as Row[];
  result.harness = {
    ...(map.destination === null ? {} : { destination: display(map.destination) }),
    mapStatus: map.status as JoiGoalMapDetailDto["mapStatus"], revision: Number(map.revision), currentLayer: Number(map.current_layer),
    pathCount: Number(map.path_count), decisionCount: Number(map.decision_count), fogCount: Number(map.fog_count),
    paths: paths.map((row) => ({
      pathId: String(row.path_id), layer: Number(row.layer), title: display(row.title), status: row.status as JoiGoalMapPathDto["status"],
      ...(row.work_id === null ? {} : { workId: String(row.work_id), workStatus: row.work_status as NonNullable<JoiGoalMapPathDto["workStatus"]> }),
      ...(row.decision_id === null ? {} : { resolvedDecisionId: String(row.decision_id) }),
    })),
    decisions: decisions.map((row) => ({ decisionId: String(row.decision_id), kind: row.kind as JoiGoalMapDetailDto["decisions"][number]["kind"],
      summary: display(row.summary), detail: display(row.detail), createdAt: String(row.created_at) })),
    fog: fog.map((row) => ({ fogId: String(row.fog_id), note: display(row.note), status: row.status as JoiGoalMapDetailDto["fog"][number]["status"],
      ...(row.path_id === null ? {} : { graduatedPathId: String(row.path_id) }) })),
  };
  if (Math.max(result.harness.pathCount, result.harness.decisionCount, result.harness.fogCount) > page.offset + page.limit) {
    result.nextOffset = page.offset + page.limit;
  }
  return result;
}
