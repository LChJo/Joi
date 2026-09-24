import type { DatabaseSync } from "node:sqlite";
import type { EvolutionEvidence, EvolutionEvidenceSeed, EvolutionSourcePin, EvolutionState, EvolutionStore } from "../../application/ports/evolution.js";
import { DEFAULT_EVOLUTION_DAILY_CALL_LIMIT } from "../../../shared/evolution.js";
import { DomainError } from "../../domain/errors.js";

type Row = Record<string, unknown>;
const optionalText = (value: unknown): string | null => typeof value === "string" ? value : null;
/**
 * Weakest first. A goal is re-classified as its lifecycle converges, but a classification may only
 * be upgraded: a premature snapshot (a goal sampled before its first Work was dispatched) must never
 * freeze out the verification failures that follow, and a goal canceled after failing must keep the
 * failure signal instead of degrading to CANCELED.
 *
 * This ranks how much an outcome tells us about strategy quality, which is deliberately not the
 * same as the classification precedence in EvolutionService.scan. VERIFIED therefore outranks
 * ENVIRONMENT_FAILED: once Work was objectively verified, later infrastructure noise does not
 * retract that, and an environment failure is explicitly not the strategy's fault.
 *
 * One overlap is deliberate and quantified rather than overlooked. A goal that was revoked after
 * every one of its Work items was objectively verified still classifies as CANCELED, not VERIFIED,
 * so it stays out of the trigger pool: a revoked goal is evidence of the user giving up, not of the
 * orchestration succeeding. VERIFICATION_FAILED is the one outcome that outranks a revocation,
 * because that is the failure signal the pool exists to collect.
 */
const EVIDENCE_RANK: Readonly<Record<EvolutionEvidence["outcome"], number>> = {
  UNEVALUABLE: 0, ENVIRONMENT_FAILED: 1, CANCELED: 2, ACCEPTED_WITH_GAPS: 3, VERIFIED: 4, VERIFICATION_FAILED: 5,
};
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
  /**
   * Returns the classification actually persisted, or null when nothing changed. Re-recording the
   * same observation is a no-op, so the 10s scan stays idempotent and — critically — does not move
   * `observed_at`: that timestamp drives the "a verdict consumes its trigger" window, so touching an
   * already-judged goal (dismissing it later, say) must not re-arm the trigger. `classified_at`
   * carries the idempotence guard instead.
   */
  recordEvidence(evidence: EvolutionEvidence): EvolutionEvidence["outcome"] | null {
    return this.database.transaction((db) => {
      if (db.prepare("SELECT 1 FROM joi_inbox_messages WHERE input_id = ? AND workbench_id = ? AND goal_input_id IS NULL").get(evidence.goalId, evidence.workbenchId) === undefined) throw new DomainError("evolution_goal_invalid", "Goal does not belong to this workbench.");
      const existing = db.prepare("SELECT revision_id,outcome,observed_at,classified_at FROM evolution_evidence WHERE goal_id = ?").get(evidence.goalId) as Row | undefined;
      if (existing === undefined) {
        return db.prepare(`INSERT INTO evolution_evidence
          (goal_id,workbench_id,revision_id,outcome,observed_at,classified_at) VALUES (?,?,?,?,?,?)`)
          .run(evidence.goalId, evidence.workbenchId, evidence.revisionId, evidence.outcome, evidence.observedAt, evidence.observedAt).changes === 1
          ? evidence.outcome : null;
      }
      const previousOutcome = String(existing.outcome) as EvolutionEvidence["outcome"];
      const upgrades = EVIDENCE_RANK[evidence.outcome] > EVIDENCE_RANK[previousOutcome];
      const previousRevision = optionalText(existing.revision_id);
      const revisionId = evidence.revisionId ?? previousRevision;
      const classifiedAt = String(existing.classified_at ?? existing.observed_at);
      if (!upgrades && revisionId === previousRevision && classifiedAt >= evidence.observedAt) return null;
      const outcome = upgrades ? evidence.outcome : previousOutcome;
      db.prepare(`UPDATE evolution_evidence
        SET revision_id = ?, outcome = ?, observed_at = ?, classified_at = ? WHERE goal_id = ?`)
        .run(revisionId, outcome,
          // Only a real upgrade is new information about the goal; a re-look that confirms the
          // previous classification leaves the trigger window where it was.
          upgrades ? evidence.observedAt : String(existing.observed_at), evidence.observedAt, evidence.goalId);
      return outcome;
    });
  }
  /**
   * Cross-workbench trigger pool. Evaluation runs on fixed synthetic scenarios that are identical
   * for every workbench, so production evidence only answers "is orchestration failing somewhere?"
   * Aggregating it cannot leak one workbench's strategy into another's: revisions, goal pins and
   * rollbacks stay strictly per workbench. `since` is the asking workbench's last verdict; "" sorts
   * before every ISO-8601 timestamp, so null means "everything".
   */
  evidenceTotals(since: string | null): { evaluable: number; verificationFailed: number } {
    return this.database.transaction((db) => {
      const row = db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN outcome IN ('VERIFIED','VERIFICATION_FAILED') THEN 1 ELSE 0 END), 0) AS evaluable,
          COALESCE(SUM(CASE WHEN outcome = 'VERIFICATION_FAILED' THEN 1 ELSE 0 END), 0) AS failed
        FROM evolution_evidence WHERE observed_at > ?`).get(since ?? "") as Row;
      return { evaluable: Number(row.evaluable), verificationFailed: Number(row.failed) };
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
      // The strategy pin stays first-bind-wins so a goal remains attributable to exactly one
      // revision, but `eligible` is not part of that contract: migration 059 backfilled every
      // then-existing goal as unsampled, including goals still in flight whose entire outcome
      // landed afterwards. Re-admit those when they next start a turn. A row already bound to a
      // real revision was sampled under it and is deliberately left untouched.
      db.prepare(`INSERT INTO evolution_goal_pins(goal_id,workbench_id,revision_id,source_pin_json) VALUES (?,?,?,?)
        ON CONFLICT(goal_id) DO UPDATE SET eligible = 1
        WHERE evolution_goal_pins.revision_id IS NULL AND evolution_goal_pins.eligible = 0`)
        .run(goal, id, revision, sourcePin === undefined ? null : JSON.stringify(sourcePin));
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
      -- NOT_REQUIRED means no acceptance check was declared for that Work; it is the absence of a
      -- question, not a missing answer, so it must not veto a goal whose other Work was objectively
      -- verified. It never counts as verified either, so an all-NOT_REQUIRED goal stays UNEVALUABLE.
      (SELECT COUNT(*) FROM work_items w WHERE w.input_id = i.input_id AND NOT EXISTS (SELECT 1 FROM latest_verifications v WHERE v.work_id = w.work_id AND v.position = 1 AND v.status IN ('PASSED','FAILED','NOT_REQUIRED'))) AS unverified,
      (SELECT COUNT(*) FROM work_items w WHERE w.input_id = i.input_id AND w.status = 'FAILED') AS work_failed
      FROM joi_inbox_messages i JOIN evolution_goal_pins p ON p.goal_id = i.input_id AND p.eligible = 1
      JOIN workbenches b ON b.workbench_id = i.workbench_id AND b.status = 'ACTIVE'
      LEFT JOIN joi_goal_outcomes o ON o.input_id = i.input_id
      WHERE i.goal_input_id IS NULL AND i.status = 'CONSUMED'
      -- CONTINUE means the goal handed off to a continuation, so the continuation carries its
      -- outcome and this row would double-count it. A revoked goal has no continuation left to do
      -- that: its disposition freezes at whatever it was when it was abandoned, and excluding it
      -- would hide the verification failures that made the user give up in the first place.
      AND (o.disposition IS NULL OR o.disposition <> 'CONTINUE'
        OR i.canceled_at IS NOT NULL OR i.dismissed_at IS NOT NULL)
      AND (o.disposition IS NOT NULL OR i.canceled_at IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM work_items w WHERE w.input_id = i.input_id))
      AND NOT EXISTS(SELECT 1 FROM joi_inbox_messages child WHERE child.goal_input_id = i.input_id
        AND child.status <> 'CONSUMED' AND child.canceled_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM joi_turns t JOIN joi_inbox_messages turn_input ON turn_input.input_id = t.input_id
        WHERE t.status = 'RUNNING' AND (turn_input.input_id = i.input_id OR turn_input.goal_input_id = i.input_id))
      -- Re-sample a goal only when its facts moved since we last classified it. Without this the
      -- first snapshot is permanent: a goal sampled before its first Work was dispatched (no
      -- outcome, no work_items yet) is classified UNEVALUABLE and could never be upgraded by the
      -- verification failures that follow. classified_at carries idempotence; observed_at stays the
      -- trigger-window timestamp and only moves on a real upgrade.
      AND NOT EXISTS(SELECT 1 FROM evolution_evidence e WHERE e.goal_id = i.input_id
        AND COALESCE(e.classified_at, e.observed_at) >= i.updated_at)
      AND NOT EXISTS(SELECT 1 FROM work_items w WHERE w.input_id = i.input_id AND w.status IN ('PLANNED','READY','RUNNING','WAITING'))
      AND NOT EXISTS(SELECT 1 FROM joi_harness_maps m WHERE m.goal_input_id = i.input_id AND m.status = 'ACTIVE')
      ORDER BY i.updated_at,i.input_id LIMIT 50`).all() as Row[]).map((r) => ({
        goalId: String(r.input_id), workbenchId: String(r.workbench_id), observedAt: String(r.updated_at), canceled: r.canceled_at !== null,
        disposition: optionalText(r.disposition), verified: Number(r.verified), failed: Number(r.failed), unverified: Number(r.unverified), workFailed: Number(r.work_failed),
      })));
  }
}
