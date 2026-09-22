import type { DatabaseSync } from "node:sqlite";
import type { EvolutionEvidence, EvolutionEvidenceSeed, EvolutionSourcePin, EvolutionState, EvolutionStore } from "../../application/ports/evolution.js";
import { DEFAULT_EVOLUTION_DAILY_CALL_LIMIT } from "../../../shared/evolution.js";
import { DomainError } from "../../domain/errors.js";

type Row = Record<string, unknown>;
const optionalText = (value: unknown): string | null => typeof value === "string" ? value : null;
interface Database { transaction<T>(operation: (db: DatabaseSync) => T): T; }
const initialState = (): EvolutionState => ({ callSequence: 0, developmentHistory: [], dailyCallLimit: DEFAULT_EVOLUTION_DAILY_CALL_LIMIT, usage: {}, activeRevisionId: null, reason: "collecting", lastCandidateDay: null, revisions: [], batch: null, call: null, paused: false });
function assertWorkbench(db: DatabaseSync, id: string): void {
  if (db.prepare("SELECT 1 FROM workbenches WHERE workbench_id = ? AND status = 'ACTIVE'").get(id) === undefined) throw new DomainError("workbench_not_found", "Workbench was not found.");
}
function readState(db: DatabaseSync, id: string): EvolutionState {
  assertWorkbench(db, id);
  const row = db.prepare("SELECT state_json FROM evolution_states WHERE workbench_id = ?").get(id) as Row | undefined;
  return row === undefined ? initialState() : JSON.parse(String(row.state_json)) as EvolutionState;
}

export class SqliteEvolutionStore implements EvolutionStore {
  constructor(private readonly database: Database) {}

  listWorkbenchIds(): string[] {
    return this.database.transaction((db) => (db.prepare("SELECT workbench_id FROM workbenches WHERE status = 'ACTIVE' ORDER BY workbench_id LIMIT 100").all() as Row[]).map((r) => String(r.workbench_id)));
  }
  read(id: string): EvolutionState { return this.database.transaction((db) => readState(db, id)); }
  update<T>(id: string, operation: (state: EvolutionState) => T): T {
    return this.database.transaction((db) => {
      const state = readState(db, id);
      const result = operation(state);
      db.prepare("INSERT INTO evolution_states VALUES (?,?) ON CONFLICT(workbench_id) DO UPDATE SET state_json = excluded.state_json").run(id, JSON.stringify(state));
      if (state.call !== null) {
        const call = state.call;
        db.prepare(`INSERT INTO outbox (outbox_id,kind,payload_json,status,available_at,created_at,claim_owner)
          VALUES (?,'evolution.model',?,?,?,?,'evolution') ON CONFLICT(outbox_id) DO UPDATE SET status = excluded.status`)
          .run(call.id, JSON.stringify({ workbenchId: id, callId: call.id }), call.state === "RUNNING" ? "CLAIMED" : call.state, call.createdAt, call.createdAt);
      }
      return result;
    });
  }
  evidence(id: string): EvolutionEvidence[] {
    return this.database.transaction((db) => (db.prepare("SELECT * FROM evolution_evidence WHERE workbench_id = ? ORDER BY observed_at DESC,goal_id LIMIT 500").all(id) as Row[]).map((r) => ({
      goalId: String(r.goal_id), workbenchId: String(r.workbench_id), revisionId: optionalText(r.revision_id),
      outcome: r.outcome as EvolutionEvidence["outcome"], observedAt: String(r.observed_at),
    })));
  }
  recordEvidence(evidence: EvolutionEvidence): boolean {
    return this.database.transaction((db) => {
      if (db.prepare("SELECT 1 FROM joi_inbox_messages WHERE input_id = ? AND workbench_id = ? AND goal_input_id IS NULL").get(evidence.goalId, evidence.workbenchId) === undefined) throw new DomainError("evolution_goal_invalid", "Goal does not belong to this workbench.");
      return db.prepare("INSERT OR IGNORE INTO evolution_evidence VALUES (?,?,?,?,?)").run(evidence.goalId, evidence.workbenchId, evidence.revisionId, evidence.outcome, evidence.observedAt).changes === 1;
    });
  }
  goalRevision(id: string, goal: string): string | null | undefined {
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT revision_id FROM evolution_goal_pins WHERE workbench_id = ? AND goal_id = ?").get(id, goal) as Row | undefined;
      return row === undefined ? undefined : optionalText(row.revision_id);
    });
  }
  bindGoal(id: string, goal: string, revision: string | null, sourcePin?: EvolutionSourcePin): string | null {
    return this.database.transaction((db) => {
      if (db.prepare("SELECT 1 FROM joi_inbox_messages WHERE input_id = ? AND workbench_id = ? AND goal_input_id IS NULL").get(goal, id) === undefined) throw new DomainError("evolution_goal_invalid", "Goal does not belong to this workbench.");
      db.prepare("INSERT OR IGNORE INTO evolution_goal_pins(goal_id,workbench_id,revision_id,source_pin_json) VALUES (?,?,?,?)").run(goal, id, revision, sourcePin === undefined ? null : JSON.stringify(sourcePin));
      const row = db.prepare("SELECT revision_id FROM evolution_goal_pins WHERE goal_id = ? AND workbench_id = ?").get(goal, id) as Row;
      return optionalText(row.revision_id);
    });
  }
  idle(): boolean {
    return this.database.transaction((db) => db.prepare(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM joi_inbox_messages WHERE status = 'PENDING' AND canceled_at IS NULL AND dismissed_at IS NULL)
      OR EXISTS(SELECT 1 FROM joi_turns WHERE status = 'RUNNING')
      OR EXISTS(SELECT 1 FROM work_items WHERE status IN ('PLANNED','READY','RUNNING','WAITING'))`).get() === undefined);
  }
  evidenceSeeds(): EvolutionEvidenceSeed[] {
    return this.database.transaction((db) => (db.prepare(`WITH latest_verifications AS (
      SELECT r.work_id,v.status,ROW_NUMBER() OVER (PARTITION BY r.work_id ORDER BY r.created_at DESC,r.rowid DESC) AS position
      FROM work_results r LEFT JOIN work_result_verifications v ON v.result_id = r.result_id
      WHERE r.is_authoritative = 1 AND r.is_late = 0
    ) SELECT i.input_id, i.workbench_id, i.updated_at, i.canceled_at, o.disposition,
      (SELECT COUNT(*) FROM work_items w JOIN latest_verifications v ON v.work_id = w.work_id AND v.position = 1 WHERE w.input_id = i.input_id AND v.status = 'PASSED') AS verified,
      (SELECT COUNT(*) FROM work_items w JOIN latest_verifications v ON v.work_id = w.work_id AND v.position = 1 WHERE w.input_id = i.input_id AND v.status = 'FAILED') AS failed,
      (SELECT COUNT(*) FROM work_items w WHERE w.input_id = i.input_id AND NOT EXISTS (SELECT 1 FROM latest_verifications v WHERE v.work_id = w.work_id AND v.position = 1 AND v.status IN ('PASSED','FAILED'))) AS unverified,
      (SELECT COUNT(*) FROM work_items w WHERE w.input_id = i.input_id AND w.status = 'FAILED') AS work_failed
      FROM joi_inbox_messages i JOIN evolution_goal_pins p ON p.goal_id = i.input_id AND p.eligible = 1
      JOIN workbenches b ON b.workbench_id = i.workbench_id AND b.status = 'ACTIVE'
      LEFT JOIN joi_goal_outcomes o ON o.input_id = i.input_id
      WHERE i.goal_input_id IS NULL AND i.status = 'CONSUMED'
      AND (o.disposition IS NULL OR o.disposition <> 'CONTINUE')
      AND (o.disposition IS NOT NULL OR i.canceled_at IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM work_items w WHERE w.input_id = i.input_id))
      AND NOT EXISTS(SELECT 1 FROM joi_inbox_messages child WHERE child.goal_input_id = i.input_id
        AND child.status <> 'CONSUMED' AND child.canceled_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM joi_turns t JOIN joi_inbox_messages turn_input ON turn_input.input_id = t.input_id
        WHERE t.status = 'RUNNING' AND (turn_input.input_id = i.input_id OR turn_input.goal_input_id = i.input_id))
      AND NOT EXISTS(SELECT 1 FROM evolution_evidence e WHERE e.goal_id = i.input_id)
      AND NOT EXISTS(SELECT 1 FROM work_items w WHERE w.input_id = i.input_id AND w.status IN ('PLANNED','READY','RUNNING','WAITING'))
      AND NOT EXISTS(SELECT 1 FROM joi_harness_maps m WHERE m.goal_input_id = i.input_id AND m.status = 'ACTIVE')
      ORDER BY i.updated_at,i.input_id LIMIT 50`).all() as Row[]).map((r) => ({
        goalId: String(r.input_id), workbenchId: String(r.workbench_id), observedAt: String(r.updated_at), canceled: r.canceled_at !== null,
        disposition: optionalText(r.disposition), verified: Number(r.verified), failed: Number(r.failed), unverified: Number(r.unverified), workFailed: Number(r.work_failed),
      })));
  }
}
