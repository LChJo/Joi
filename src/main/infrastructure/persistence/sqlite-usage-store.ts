import type { DatabaseSync } from "node:sqlite";
import type { StatisticsSnapshot, UsageContext, UsageObservation, UsageRecord, UsageStore } from "../../application/ports/usage.js";
import type { TokenUsage, UsageStatus } from "../../../shared/statistics.js";
import { sanitizeAgentConversationText, stripPathRedactions } from "../../application/partners/agent-conversation-presentation.js";

interface Database { transaction<T>(operation: (db: DatabaseSync) => T): T; }
type Row = Record<string, unknown>;
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const label = (value: string) => stripPathRedactions(sanitizeAgentConversationText(value)).replace(/\s+/gu, " ").slice(0, 160);
export class SqliteUsageStore implements UsageStore {
  constructor(private readonly database: Database, now: () => string) {
    database.transaction((db) => db.prepare("INSERT OR IGNORE INTO statistics_metadata(singleton,collected_since) VALUES (1,?)").run(now()));
  }
  markDegraded(): void { this.database.transaction((db) => db.prepare("UPDATE statistics_metadata SET collection_degraded = 1 WHERE singleton = 1").run()); }
  begin(id: string, context: UsageContext, at: string): void {
    this.database.transaction((db) => {
      const work = context.workId === undefined ? undefined : db.prepare("SELECT input_id,workbench_id FROM work_items WHERE work_id = ?").get(context.workId) as Row | undefined;
      const workbenchId = context.workbenchId ?? string(work?.workbench_id);
      const candidateGoal = context.goalId ?? string(work?.input_id);
      const goal = candidateGoal === undefined ? undefined : db.prepare("SELECT COALESCE(goal_input_id,input_id) AS goal_id,workbench_id FROM joi_inbox_messages WHERE input_id = ?").get(candidateGoal) as Row | undefined;
      const goalId = goal?.workbench_id === workbenchId ? string(goal?.goal_id) : undefined;
      const workbench = workbenchId === undefined ? undefined : db.prepare("SELECT name FROM workbenches WHERE workbench_id = ?").get(workbenchId) as Row | undefined;
      const source = context.sourceId === undefined ? undefined : db.prepare(`SELECT r.display_name FROM model_sources s JOIN model_source_revisions r ON r.source_revision_id = s.active_source_revision_id WHERE s.source_id = ?`).get(context.sourceId) as Row | undefined;
      db.prepare(`INSERT OR IGNORE INTO usage_invocations VALUES (?,?,'running',?,?,?,?,?,?,?,?,?,?)`).run(id, at, context.engine, context.purpose,
        workbenchId ?? null, string(workbench?.name) ?? null, goalId ?? null, context.workId ?? null, context.partnerId ?? null, context.sourceId ?? null, string(source?.display_name) ?? context.sourceName ?? null, context.modelId ?? null);
    });
  }
  observe(id: string, observation: UsageObservation, at: string): void {
    this.database.transaction((db) => {
      db.prepare(`INSERT INTO usage_observations VALUES (?,?,?,?,?,?,?) ON CONFLICT(invocation_id,observation_key) DO UPDATE SET
        observed_at = excluded.observed_at, model_id = excluded.model_id, source_id = excluded.source_id, source_name = excluded.source_name,
        tokens_json = COALESCE(excluded.tokens_json,usage_observations.tokens_json)`).run(id, observation.key, at, observation.modelId ?? null, observation.sourceId ?? null, observation.sourceName ?? null, observation.tokens === null ? null : JSON.stringify(observation.tokens));
    });
  }
  finish(id: string, status: Exclude<UsageStatus, "running">): void {
    this.database.transaction((db) => db.prepare("UPDATE usage_invocations SET status = ? WHERE invocation_id = ? AND status = 'running'").run(status, id));
  }
  recover(): void { this.database.transaction((db) => db.prepare("UPDATE usage_invocations SET status = 'interrupted' WHERE status = 'running'").run()); }
  snapshot(fromUtc: string, toUtc: string): StatisticsSnapshot {
    return this.database.transaction((db) => {
      const metadata = db.prepare("SELECT collected_since,collection_degraded FROM statistics_metadata WHERE singleton = 1").get() as Row;
      const rows = db.prepare(`SELECT i.*, o.observation_key, COALESCE(o.observed_at,i.started_at) AS at,
        COALESCE(o.model_id,i.model_id) AS effective_model,COALESCE(o.source_id,i.source_id) AS effective_source,
        COALESCE(o.source_name,i.source_name) AS effective_name,o.tokens_json
        FROM usage_invocations i LEFT JOIN usage_observations o ON o.invocation_id = i.invocation_id
        WHERE COALESCE(o.observed_at,i.started_at) >= ? AND COALESCE(o.observed_at,i.started_at) < ?
        ORDER BY at,i.invocation_id,o.observation_key`).all(fromUtc, toUtc) as Row[];
      const records: UsageRecord[] = rows.map((r) => ({ id: `${String(r.invocation_id)}:${string(r.observation_key) ?? "pending"}`, invocationId: String(r.invocation_id), at: String(r.at),
        engine: r.engine as UsageRecord["engine"], purpose: r.purpose as UsageRecord["purpose"], status: r.status as UsageStatus,
        ...(typeof r.workbench_id === "string" ? { workbenchId: r.workbench_id } : {}), ...(typeof r.goal_id === "string" ? { goalId: r.goal_id } : {}),
        ...(typeof r.effective_model === "string" ? { modelId: r.effective_model } : {}), ...(typeof r.effective_source === "string" ? { sourceId: r.effective_source } : {}),
        ...(typeof r.effective_name === "string" ? { sourceName: label(r.effective_name) } : {}), tokens: typeof r.tokens_json === "string" ? JSON.parse(r.tokens_json) as TokenUsage : null,
      }));
      const current = db.prepare("SELECT workbench_id,name,status FROM workbenches").all() as Row[];
      const workbenches = new Map(current.map((r) => [String(r.workbench_id), { workbenchId: String(r.workbench_id), name: label(String(r.name)), archived: r.status !== "ACTIVE" }]));
      for (const r of rows) if (typeof r.workbench_id === "string" && !workbenches.has(r.workbench_id)) workbenches.set(r.workbench_id, { workbenchId: r.workbench_id, name: label(string(r.workbench_name) ?? "已归档工作台"), archived: true });
      const facts = db.prepare(`SELECT i.input_id,i.workbench_id,i.canceled_at,i.failed_at,i.status AS inbox_status,
        gate.status AS gate_status,m.destination,m.status AS map_status,o.disposition,tc.outcome_kind,
        CASE WHEN o.result_revision = rs.revision AND rs.revision > 0 THEN 1 ELSE 0 END AS outcome_current,
        COALESCE(m.cleared_at,o.completed_at,tc.completed_at) AS completed_at,
        EXISTS(SELECT 1 FROM joi_inbox_messages child WHERE child.goal_input_id = i.input_id AND child.status IN ('PENDING','ROUTED') AND child.canceled_at IS NULL) AS pending_child,
        EXISTS(SELECT 1 FROM work_items w WHERE w.input_id = i.input_id AND w.status IN ('PLANNED','READY','RUNNING','WAITING')) AS active_work,
        EXISTS(SELECT 1 FROM work_items w WHERE w.input_id = i.input_id AND w.status = 'FAILED') AS failed_work
        FROM joi_inbox_messages i LEFT JOIN joi_goal_outcomes o ON o.input_id = i.input_id
        LEFT JOIN joi_turn_completions tc ON tc.input_id = i.input_id
        LEFT JOIN joi_goal_result_sets rs ON rs.original_input_id = i.input_id
        LEFT JOIN joi_harness_maps m ON m.goal_input_id = i.input_id
        LEFT JOIN joi_goal_execution_gates gate ON gate.goal_input_id = i.input_id
        WHERE i.goal_input_id IS NULL AND i.workbench_id IS NOT NULL AND
          (i.input_id IN (SELECT value FROM json_each(?))
           OR (COALESCE(m.cleared_at,o.completed_at,tc.completed_at) >= ? AND COALESCE(m.cleared_at,o.completed_at,tc.completed_at) < ?))`).all(JSON.stringify([...new Set(records.flatMap((r) => r.goalId === undefined ? [] : [r.goalId]))]), fromUtc, toUtc) as Row[];
      const goals: StatisticsSnapshot["goals"] = facts.map((r) => {
        const waiting = r.inbox_status === "CLARIFICATION_REQUIRED" || r.gate_status === "WAITING_INPUT";
        const active = r.map_status === "ACTIVE" || r.pending_child === 1 || r.inbox_status !== "CONSUMED" || r.active_work === 1 || r.gate_status === "REVIEWING";
        const done = !active && ((r.outcome_current === 1 && (r.disposition === "COMPLETED" || r.disposition === "ACCEPTED_WITH_GAPS")) || (r.disposition === null && r.outcome_kind === "DIRECT_ANSWER"));
        const status = r.failed_at !== null ? "failed" : r.canceled_at !== null ? "canceled" : waiting ? "waiting" : done ? "completed" : !active && (r.failed_work === 1 || r.disposition === "BLOCKED") ? "failed" : "running";
        const title = typeof r.destination === "string" ? label(r.destination) : undefined;
        return { goalId: String(r.input_id), workbenchId: String(r.workbench_id), title: title === undefined || title === "" ? "未命名目标" : title, status, completedAt: string(r.completed_at) ?? null };
      });
      return { collectedSince: String(metadata.collected_since), collectionDegraded: metadata.collection_degraded === 1, records, workbenches: [...workbenches.values()], goals };
    });
  }
}
