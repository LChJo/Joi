import type { DatabaseSync } from "node:sqlite";
import type { JoiGoalContext } from "../../application/ports/joi-coordinator.js";
import { loadCompletedGoalEvidence } from "./sqlite-workbench-context-repository.js";

export function loadJoiGoalContext(connection: DatabaseSync, goalInputId: string, workbenchId: string): JoiGoalContext | undefined {
  const goal = connection.prepare("SELECT body FROM joi_inbox_messages WHERE input_id = ? AND workbench_id = ?")
    .get(goalInputId, workbenchId);
  if (typeof goal?.body !== "string") return undefined;
  const { results, totalResults } = loadCompletedGoalEvidence(connection, { goalInputId, workbenchId, preserveConclusion: true, maxResults: 24 });
  const outcome = connection.prepare(`SELECT completion_summary AS summary, disposition FROM joi_goal_outcomes
    WHERE input_id = ? ORDER BY result_revision DESC LIMIT 1`).get(goalInputId) as JoiGoalContext["completion"] | undefined;
  const direct = outcome === undefined ? connection.prepare(`SELECT completion_summary AS summary, outcome_kind AS disposition
    FROM joi_turn_completions WHERE input_id = ?`).get(goalInputId) as JoiGoalContext["completion"] | undefined : undefined;
  const completion = outcome ?? direct;
  const map = connection.prepare("SELECT destination FROM joi_harness_maps WHERE goal_input_id = ? AND workbench_id = ?")
    .get(goalInputId, workbenchId);
  const decisions = connection.prepare(`SELECT kind, summary, detail FROM joi_harness_decisions
    WHERE goal_input_id = ? ORDER BY created_at DESC, decision_id DESC LIMIT 8`).all(goalInputId) as JoiGoalContext["decisions"];
  const fog = connection.prepare(`SELECT note FROM joi_harness_fog WHERE goal_input_id = ? AND status = 'ACTIVE'
    ORDER BY created_at DESC, fog_id DESC LIMIT 6`).all(goalInputId);
  if (results.length === 0 && completion === undefined && decisions.length === 0) return undefined;
  return {
    originalRequest: goal.body.length <= 16_000 ? goal.body : `${goal.body.slice(0, 8000)}\n[truncated; middle omitted]\n${goal.body.slice(-8000)}`,
    ...(typeof map?.destination === "string" ? { destination: map.destination } : {}),
    ...(completion === undefined ? {} : { completion }),
    decisions: decisions.reverse(),
    fogNotes: fog.map((row) => String(row.note)),
    totalResults,
    results,
  };
}
