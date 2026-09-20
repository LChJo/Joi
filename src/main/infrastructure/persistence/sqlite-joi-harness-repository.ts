/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  HarnessContinuationDecisionSeed,
  HarnessDecisionKind,
  HarnessFeedbackTarget,
  HarnessGoalProjection,
  HarnessGoalSeed,
  HarnessMapStatus,
  HarnessPathStatus,
  HarnessReviewDigest,
  HarnessReviewRecoveryCandidate,
  HarnessReviewRecoveryResult,
  HarnessWorkRecoverySeed,
  JoiHarnessScan,
  JoiHarnessStore,
  JoiHarnessWriter,
} from "../../application/ports/joi-harness.js";
import { composeReviewBody } from "../../application/joi/joi-harness-review-body.js";
import { DomainError } from "../../domain/errors.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

const DECISION_KINDS: readonly HarnessDecisionKind[] = ["APPROACH", "WORKBENCH_REFINE", "OUT_OF_SCOPE", "SCOPE"];
const DESTINATION_LIMIT = 240;
const PATH_TITLE_LIMIT = 160;
const DECISION_SUMMARY_LIMIT = 240;
const DECISION_DETAIL_LIMIT = 4_000;
const FOG_NOTE_LIMIT = 480;
const LAYER_MIN = 1;
const LAYER_MAX = 32;
const TASK_SUMMARY_KEEP_CHARS = 2_000;

/**
 * Shared review-recovery predicates. The scan (listReviewRecoveries) and its write-time
 * recheck (reconcileReview) must stay in lockstep: a candidate that passes the scan but
 * no longer passes the recheck is rejected instead of written. Both queries bind these
 * fragments against the same aliases (m = joi_harness_maps, r = review input, o = outcome).
 */
const REVIEW_GATE_OPEN_SQL = `NOT EXISTS (SELECT 1 FROM joi_goal_execution_gates gate
                            WHERE gate.goal_input_id = m.goal_input_id AND gate.status <> 'OPEN')`;
const REVIEW_FACTS_COMPLETE_SQL = `
                r.status = 'CONSUMED' AND o.disposition = 'COMPLETED'
                AND EXISTS (SELECT 1 FROM joi_turns finished_review
                             WHERE finished_review.input_id = r.input_id AND finished_review.status = 'COMPLETED')
                AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p
                                 WHERE p.goal_input_id = m.goal_input_id AND p.status = 'OPEN')
                AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = m.goal_input_id
                                 AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id))`;

function textValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("joi_harness_row_invalid");
  return value;
}

function optionalText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("joi_harness_row_invalid");
  return value;
}

function numberValue(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error("joi_harness_row_invalid");
  return value;
}

function decisionKind(value: unknown): HarnessDecisionKind {
  if (typeof value === "string" && (DECISION_KINDS as readonly string[]).includes(value)) {
    return value as HarnessDecisionKind;
  }
  throw new Error("joi_harness_row_invalid");
}

function requireText(value: string, limit: number, code: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > limit) throw new DomainError(code, "Harness map entry is out of bounds.");
  return trimmed;
}

function reviewInputId(goalInputId: string, resultRevision: number): string {
  return `joi_harness_review:goal:${goalInputId}:r${String(resultRevision)}`;
}

function reviewDigest(connection: DatabaseSync, row: Row): HarnessReviewDigest {
  const goalInputId = textValue(row, "goal_input_id");
  const decisions = (connection.prepare(`
    SELECT kind, summary FROM joi_harness_decisions
     WHERE goal_input_id = ?
     ORDER BY created_at DESC, decision_id DESC LIMIT 8`).all(goalInputId) as Row[])
    .map((decisionRow) => ({ kind: decisionKind(decisionRow.kind), summary: textValue(decisionRow, "summary") }))
    .reverse();
  const decisionCount = numberValue(connection.prepare(`
    SELECT COUNT(*) AS n FROM joi_harness_decisions WHERE goal_input_id = ?`).get(goalInputId) as Row, "n");
  const fogNotes = (connection.prepare(`
    SELECT note FROM joi_harness_fog
     WHERE goal_input_id = ? AND status = 'ACTIVE'
     ORDER BY created_at, fog_id LIMIT 6`).all(goalInputId) as Row[])
    .map((fogRow) => textValue(fogRow, "note"));
  const openPaths = (connection.prepare(`
    SELECT path_id, layer, title FROM joi_harness_paths
     WHERE goal_input_id = ? AND status = 'OPEN'
     ORDER BY layer, created_at, path_id LIMIT 6`).all(goalInputId) as Row[])
    .map((pathRow) => ({
      layer: numberValue(pathRow, "layer"),
      pathId: textValue(pathRow, "path_id"),
      title: textValue(pathRow, "title"),
    }));
  return {
    ...(optionalText(row, "outcome_disposition") === "CONTINUE" ? { continuationRequested: true as const } : {}),
    workbenchId: textValue(row, "workbench_id"),
    completionSummary: optionalText(row, "completion_summary") ?? "",
    decisionCount,
    decisions,
    destination: optionalText(row, "destination"),
    fogNotes,
    goalInputId,
    openPaths,
    resultRevision: numberValue(row, "result_revision"),
  };
}

/**
 * Bounded per-goal harness projection. Exported so the home-feed repository can run
 * it inside its own transaction instead of nesting transactions.
 */
export function queryHarnessGoalProjections(connection: DatabaseSync): HarnessGoalProjection[] {
  const maps = connection.prepare(`
    SELECT m.goal_input_id, m.destination, m.status, m.revision, m.reviewed_revision,
           (SELECT COUNT(*) FROM joi_harness_decisions d
             WHERE d.goal_input_id = m.goal_input_id) AS decision_count,
           (SELECT COUNT(*) FROM joi_harness_fog f
             WHERE f.goal_input_id = m.goal_input_id AND f.status = 'ACTIVE') AS fog_count,
           (SELECT COALESCE(MAX(p.layer), 0) FROM joi_harness_paths p
             WHERE p.goal_input_id = m.goal_input_id) AS current_layer,
           (SELECT COUNT(*) FROM joi_harness_paths p
             WHERE p.goal_input_id = m.goal_input_id AND p.status = 'OPEN') AS open_path_count,
           (SELECT f.note FROM joi_harness_fog f
             WHERE f.goal_input_id = m.goal_input_id AND f.status = 'ACTIVE'
             ORDER BY f.created_at, f.fog_id LIMIT 1) AS top_fog_note
      FROM joi_harness_maps m
     ORDER BY m.created_at, m.goal_input_id`).all() as Row[];
  const pathRows = connection.prepare(`
    SELECT goal_input_id, path_id, status, substr(title, 1, 80) AS title, layer
      FROM joi_harness_paths
     ORDER BY goal_input_id, layer DESC, created_at DESC, path_id DESC LIMIT 500`).all() as Row[];
  const pathsByGoal = new Map<string, HarnessGoalProjection["topPaths"]>();
  const seenTitlesByGoal = new Map<string, Set<string>>();
  for (const pathRow of pathRows) {
    const goalInputId = textValue(pathRow, "goal_input_id");
    const list = pathsByGoal.get(goalInputId) ?? [];
    if (list.length >= 5) continue;
    // The same work can be re-charted in deeper layers; show it once, deepest row first.
    const title = textValue(pathRow, "title");
    const seen = seenTitlesByGoal.get(goalInputId) ?? new Set<string>();
    if (seen.has(title)) continue;
    seen.add(title);
    list.push({
      pathId: textValue(pathRow, "path_id"),
      status: textValue(pathRow, "status") as HarnessPathStatus,
      title,
    });
    pathsByGoal.set(goalInputId, list);
    seenTitlesByGoal.set(goalInputId, seen);
  }
  return maps.map((row) => {
    const goalInputId = textValue(row, "goal_input_id");
    return {
      currentLayer: numberValue(row, "current_layer"),
      decisionCount: numberValue(row, "decision_count"),
      destination: optionalText(row, "destination"),
      fogCount: numberValue(row, "fog_count"),
      goalInputId,
      mapStatus: textValue(row, "status") as HarnessMapStatus,
      openPathCount: numberValue(row, "open_path_count"),
      reviewedRevision: numberValue(row, "reviewed_revision"),
      revision: numberValue(row, "revision"),
      topFogNote: optionalText(row, "top_fog_note"),
      topPaths: pathsByGoal.get(goalInputId) ?? [],
    };
  });
}

export class SqliteJoiHarnessRepository implements JoiHarnessScan, JoiHarnessWriter, JoiHarnessStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async listGoalsWithoutMap(): Promise<HarnessGoalSeed[]> {
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT i.input_id, i.workbench_id
        FROM joi_inbox_messages i
       WHERE i.workbench_id IS NOT NULL AND i.canceled_at IS NULL
         AND i.input_id NOT LIKE 'joi_result_input:%'
         AND i.input_id NOT LIKE 'joi_harness_review:%'
         AND i.input_id NOT LIKE 'joi_signal_input:%'
         AND EXISTS (SELECT 1 FROM joi_turns t WHERE t.input_id = i.input_id)
         AND NOT EXISTS (SELECT 1 FROM joi_harness_maps m WHERE m.goal_input_id = i.input_id)
       ORDER BY i.created_at, i.input_id LIMIT 20`).all()) as Row[])
      .map((row) => ({ workbenchId: textValue(row, "workbench_id"), goalInputId: textValue(row, "input_id") }));
  }

  async listReviewDigests(): Promise<HarnessReviewDigest[]> {
    return this.database.transaction((connection) => {
      const candidates = connection.prepare(`
        SELECT m.goal_input_id, m.workbench_id, m.destination, rs.revision AS result_revision,
               o.completion_summary, o.disposition AS outcome_disposition
          FROM joi_harness_maps m
          JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
          JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
          JOIN joi_inbox_messages g ON g.input_id = m.goal_input_id
         WHERE m.status = 'ACTIVE'
           AND rs.revision > m.reviewed_revision
           AND rs.synthesized_revision = rs.revision
           AND (o.disposition = 'COMPLETED' OR (
             o.disposition = 'CONTINUE'
             AND g.status = 'CONSUMED'
             AND g.clarification_reason_code IS NULL
             AND MAX(0, COALESCE((SELECT MAX(p.layer) FROM joi_harness_paths p
                                   WHERE p.goal_input_id = m.goal_input_id), 1) - 1) < m.continuation_allowance
           ))
           AND g.canceled_at IS NULL AND g.dismissed_at IS NULL AND g.failed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM work_items w
                            WHERE w.input_id = m.goal_input_id
                              AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
         ORDER BY m.updated_at, m.goal_input_id LIMIT 10`).all() as Row[];
      return candidates.map((row) => reviewDigest(connection, row));
    });
  }

  async listContinuationDecisionSeeds(): Promise<HarnessContinuationDecisionSeed[]> {
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT m.goal_input_id, m.workbench_id, rs.revision AS result_revision
        FROM joi_harness_maps m
        JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
        JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
        JOIN joi_inbox_messages g ON g.input_id = m.goal_input_id
       WHERE m.status = 'ACTIVE'
         AND rs.revision > m.reviewed_revision
         AND rs.synthesized_revision = rs.revision
         AND o.disposition = 'CONTINUE'
         AND MAX(0, COALESCE((SELECT MAX(p.layer) FROM joi_harness_paths p
                              WHERE p.goal_input_id = m.goal_input_id), 1) - 1) >= m.continuation_allowance
         AND g.status = 'CONSUMED'
         AND g.clarification_reason_code IS NULL
         AND g.canceled_at IS NULL AND g.dismissed_at IS NULL AND g.failed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = m.goal_input_id
                           AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
         AND NOT EXISTS (SELECT 1 FROM joi_user_action_requests a
                          WHERE a.input_id = m.goal_input_id AND a.status = 'OPEN')
       ORDER BY m.updated_at, m.goal_input_id LIMIT 10`).all()) as Row[])
      .map((row) => ({
        goalInputId: textValue(row, "goal_input_id"),
        resultRevision: numberValue(row, "result_revision"),
        workbenchId: textValue(row, "workbench_id"),
      }));
  }

  async listWorkRecoverySeeds(): Promise<HarnessWorkRecoverySeed[]> {
    return this.database.transaction((connection) => {
      const rows = connection.prepare(`SELECT m.goal_input_id, m.workbench_id,
        (SELECT failed.work_id FROM work_items failed
          WHERE failed.input_id = m.goal_input_id AND failed.status = 'FAILED'
            AND (SELECT COUNT(*) FROM work_recovery_attempts a WHERE a.source_work_id = failed.work_id) < 2
            AND (SELECT COUNT(*) FROM joi_inbox_messages recovery
                  WHERE recovery.goal_input_id = m.goal_input_id
                    AND substr(recovery.idempotency_key, 1, length('work_recovery:' || failed.work_id || ':'))
                      = 'work_recovery:' || failed.work_id || ':') < 2
          ORDER BY failed.updated_at DESC, failed.work_id DESC LIMIT 1) AS source_work_id
        FROM joi_harness_maps m
        JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
        JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
        WHERE m.status = 'ACTIVE' AND rs.synthesized_revision = rs.revision
          AND o.disposition = 'BLOCKED'
          AND NOT EXISTS (SELECT 1 FROM work_items active WHERE active.input_id = m.goal_input_id
            AND active.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
          AND NOT EXISTS (SELECT 1 FROM joi_inbox_messages pending WHERE pending.goal_input_id = m.goal_input_id
            AND pending.input_id LIKE 'joi_recovery:goal:%' AND pending.status IN ('PENDING', 'ROUTED'))
        ORDER BY m.updated_at, m.goal_input_id LIMIT 10`).all() as Row[];
      return rows.flatMap((row) => {
        const sourceWorkId = optionalText(row, "source_work_id");
        if (sourceWorkId === null) return [];
        const prefix = `work_recovery:${sourceWorkId}:`;
        const attemptRow = connection.prepare(`SELECT
          (SELECT COUNT(*) FROM work_recovery_attempts WHERE source_work_id = ?) AS recorded_attempts,
          (SELECT COUNT(*) FROM joi_inbox_messages WHERE goal_input_id = ?
            AND substr(idempotency_key, 1, length(?)) = ?) AS recovery_inputs`)
          .get(sourceWorkId, textValue(row, "goal_input_id"), prefix, prefix) as Row;
        return [{
          attemptNo: Math.max(
            numberValue(attemptRow, "recorded_attempts"),
            numberValue(attemptRow, "recovery_inputs"),
          ) + 1,
          goalInputId: textValue(row, "goal_input_id"),
          sourceWorkId,
          workbenchId: textValue(row, "workbench_id"),
        }];
      });
    });
  }

  async enqueueWorkRecovery(input: { now: string; seed: HarnessWorkRecoverySeed }): Promise<string | null> {
    return this.database.transaction((connection) => {
      const prefix = `work_recovery:${input.seed.sourceWorkId}:`;
      const recoveryCounts = connection.prepare(`SELECT
        (SELECT COUNT(*) FROM work_recovery_attempts WHERE source_work_id = ?) AS recorded_attempts,
        (SELECT COUNT(*) FROM joi_inbox_messages WHERE goal_input_id = ?
          AND substr(idempotency_key, 1, length(?)) = ?) AS recovery_inputs`).get(
        input.seed.sourceWorkId, input.seed.goalInputId, prefix, prefix,
      ) as Row;
      const currentAttempts = Math.max(
        numberValue(recoveryCounts, "recorded_attempts"),
        numberValue(recoveryCounts, "recovery_inputs"),
      );
      if (currentAttempts >= 2 || input.seed.attemptNo !== currentAttempts + 1) return null;
      const eligible = connection.prepare(`SELECT 1 FROM work_items w
        JOIN joi_harness_maps m ON m.goal_input_id = w.input_id AND m.status = 'ACTIVE'
        JOIN joi_goal_result_sets rs ON rs.original_input_id = w.input_id
        JOIN joi_goal_outcomes o ON o.input_id = w.input_id AND o.result_revision = rs.revision AND o.disposition = 'BLOCKED'
        WHERE w.work_id = ? AND w.input_id = ? AND w.workbench_id = ? AND w.status = 'FAILED'
          AND NOT EXISTS (SELECT 1 FROM work_items active WHERE active.input_id = w.input_id
            AND active.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))`).get(
        input.seed.sourceWorkId, input.seed.goalInputId, input.seed.workbenchId,
      );
      if (eligible === undefined) return null;
      const inputId = `joi_recovery:goal:${input.seed.goalInputId}:work:${input.seed.sourceWorkId}:a${String(input.seed.attemptNo)}`;
      const body = [
        "[joi work recovery] An essential Work failed and the goal is blocked.",
        `Source Work id: ${input.seed.sourceWorkId}. Recovery round: ${String(input.seed.attemptNo)} of 2.`,
        "Inspect the safe result facts. If side effects were OBSERVED or UNKNOWN, never replay the source Work.",
        "Use completed goal evidence and call work_supplement for only the missing deliverable. If a built-in tool was missing, call partner_set_tools first.",
        "The source Work acceptance checks and access mode are inherited automatically; do not replace a required file with a Markdown response.",
        "Do not use historical Work ids as work_dispatch dependency keys and do not ask the user to repair an internal orchestration failure.",
      ].join(" ");
      const inserted = connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
        VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`).run(
        inputId, `work_recovery:${input.seed.sourceWorkId}:${String(input.seed.attemptNo)}`, body,
        input.seed.workbenchId, input.seed.goalInputId, input.now, input.now,
      );
      if (inserted.changes === 0) return null;
      connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CONSUMED', clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
        WHERE (input_id = ? OR goal_input_id = ?) AND clarification_reason_code = 'work_dispatch_failed'`)
        .run(input.now, input.seed.goalInputId, input.seed.goalInputId);
      return inputId;
    });
  }

  async listReviewRecoveries(): Promise<HarnessReviewRecoveryCandidate[]> {
    return this.database.transaction((connection) => {
      // A successful review may finish before Work paths are synchronized. Once
      // those facts converge, close it mechanically instead of waiting for a
      // failure that will never occur or replaying the completed review.
      const candidates = connection.prepare(`
        SELECT m.goal_input_id, m.workbench_id, m.destination, rs.revision AS result_revision,
               o.completion_summary, o.disposition AS outcome_disposition, r.input_id AS review_input_id,
               (SELECT COUNT(*) FROM joi_turns t WHERE t.input_id = r.input_id) AS review_turn_count,
               (SELECT COUNT(*) FROM joi_turns t WHERE t.input_id = r.input_id AND t.side_effect_started = 1) AS side_effect_turn_count,
               (SELECT COUNT(*) FROM work_items w
                 WHERE w.input_id = m.goal_input_id AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED')) AS active_work_count,
               (SELECT COUNT(*) FROM joi_harness_paths p
                 WHERE p.goal_input_id = m.goal_input_id AND p.status = 'OPEN') AS open_path_count,
               (SELECT COUNT(*) FROM work_items w
                 WHERE w.input_id = m.goal_input_id
                   AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id)) AS missing_path_count
          FROM joi_harness_maps m
          JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
          JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
          JOIN joi_inbox_messages g ON g.input_id = m.goal_input_id
          LEFT JOIN joi_inbox_messages r
            ON r.input_id = 'joi_harness_review:goal:' || m.goal_input_id || ':r' || rs.revision
         WHERE m.status IN ('ACTIVE', 'CLEARED')
           AND rs.revision > 0
           AND rs.synthesized_revision = rs.revision
           AND m.reviewed_revision = rs.revision
           AND g.canceled_at IS NULL AND g.dismissed_at IS NULL AND g.failed_at IS NULL
           AND ${REVIEW_GATE_OPEN_SQL}
           AND (
             g.status = 'CONSUMED'
             OR (g.status = 'CLARIFICATION_REQUIRED'
                 AND g.clarification_reason_code = 'harness_review_unrecoverable'
                 AND o.disposition = 'COMPLETED'
                 AND NOT EXISTS (SELECT 1 FROM work_items w
                                  WHERE w.input_id = m.goal_input_id
                                    AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
                 AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p
                                  WHERE p.goal_input_id = m.goal_input_id AND p.status = 'OPEN')
                 AND NOT EXISTS (SELECT 1 FROM work_items w
                                  WHERE w.input_id = m.goal_input_id
                                    AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id)))
           )
           AND NOT EXISTS (SELECT 1 FROM work_items w
                            WHERE w.input_id = m.goal_input_id
                              AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
           AND NOT (o.disposition = 'BLOCKED' AND EXISTS (
             SELECT 1 FROM joi_inbox_messages recovery
              WHERE recovery.goal_input_id = m.goal_input_id
                AND recovery.input_id LIKE 'joi_recovery:goal:%'
           ))
            AND (r.input_id IS NULL OR (
              r.status IN ('CONSUMED', 'ROUTED')
              AND (r.failed_at IS NOT NULL OR EXISTS (
                SELECT 1 FROM joi_turns failed_review
                 WHERE failed_review.input_id = r.input_id AND failed_review.status = 'FAILED'
              ) OR (${REVIEW_FACTS_COMPLETE_SQL}
              ))
              AND NOT EXISTS (SELECT 1 FROM joi_turns live_review
                               WHERE live_review.input_id = r.input_id
                                 AND live_review.status IN ('PENDING', 'RUNNING', 'WAITING'))
            ) OR (
              g.status = 'CLARIFICATION_REQUIRED' AND r.status IN ('PENDING', 'FAILED', 'CLARIFICATION_REQUIRED', 'CONSUMED', 'ROUTED')
              AND NOT EXISTS (SELECT 1 FROM joi_turns live_review
                               WHERE live_review.input_id = r.input_id
                                 AND live_review.status IN ('PENDING', 'RUNNING', 'WAITING'))
            ))
           AND NOT (m.status = 'CLEARED' AND g.status = 'CONSUMED'
             AND g.failed_at IS NULL AND g.failure_reason_code IS NULL AND g.failure_count IS NULL
             AND g.clarification_reason_code IS NULL AND g.clarification_prompt IS NULL
             AND (r.input_id IS NULL OR r.status = 'CONSUMED'))
         ORDER BY m.updated_at, m.goal_input_id LIMIT 20`).all() as Row[];
      return candidates.map((row): HarnessReviewRecoveryCandidate => {
        const reviewInput = optionalText(row, "review_input_id");
        const turnCount = numberValue(row, "review_turn_count");
        const sideEffectTurns = numberValue(row, "side_effect_turn_count");
        const activeWork = numberValue(row, "active_work_count");
        const openPaths = numberValue(row, "open_path_count");
        const missingPaths = numberValue(row, "missing_path_count");
        const factsComplete = activeWork === 0 && openPaths === 0 && missingPaths === 0;
        const outcomeCompleted = optionalText(row, "outcome_disposition") === "COMPLETED";
        const action = factsComplete && outcomeCompleted
          ? "AUTO_CLEAR" as const
          : reviewInput === null || turnCount === 0 || sideEffectTurns > 0 || activeWork > 0 || openPaths > 0 || missingPaths > 0
          ? "QUARANTINE" as const
          : "REQUEUE" as const;
        const reasonCode = factsComplete && outcomeCompleted
          ? "review_facts_complete"
          : reviewInput === null
          ? "review_row_missing"
          : turnCount === 0
            ? "review_turn_missing"
            : sideEffectTurns > 0 || activeWork > 0 || openPaths > 0 || missingPaths > 0
              ? "review_side_effect_unknown"
              : "review_turn_failed_without_side_effect";
        return { action, digest: reviewDigest(connection, row), reasonCode };
      });
    });
  }

  async listFeedbackTargets(): Promise<HarnessFeedbackTarget[]> {
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT m.goal_input_id, m.workbench_id, m.destination,
             COALESCE((SELECT o.completion_summary FROM joi_goal_outcomes o
                        WHERE o.input_id = m.goal_input_id
                        ORDER BY o.result_revision DESC LIMIT 1), '') AS completion_summary,
             COALESCE((SELECT o.disposition FROM joi_goal_outcomes o
                        WHERE o.input_id = m.goal_input_id
                        ORDER BY o.result_revision DESC LIMIT 1), 'COMPLETED') AS outcome_disposition
        FROM joi_harness_maps m
       WHERE m.status = 'CLEARED' AND m.feedback_recorded_at IS NULL
       ORDER BY m.cleared_at, m.goal_input_id LIMIT 10`).all()) as Row[])
      .map((row) => ({
        ...(optionalText(row, "outcome_disposition") === "ACCEPTED_WITH_GAPS" ? { acceptedWithGaps: true as const } : {}),
        workbenchId: textValue(row, "workbench_id"),
        completionSummary: textValue(row, "completion_summary"),
        destination: optionalText(row, "destination"),
        goalInputId: textValue(row, "goal_input_id"),
      }));
  }

  async listTrivialMapCandidates(): Promise<{ goalInputId: string }[]> {
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT m.goal_input_id
        FROM joi_harness_maps m
       WHERE m.status = 'ACTIVE' AND m.destination IS NULL
         AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.goal_input_id = m.goal_input_id)
         AND NOT EXISTS (SELECT 1 FROM joi_harness_decisions d WHERE d.goal_input_id = m.goal_input_id)
         AND NOT EXISTS (SELECT 1 FROM joi_harness_fog f WHERE f.goal_input_id = m.goal_input_id)
         AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = m.goal_input_id)
         AND NOT EXISTS (SELECT 1 FROM joi_goal_result_sets rs
                          WHERE rs.original_input_id = m.goal_input_id AND rs.revision > 0)
         AND EXISTS (SELECT 1 FROM joi_inbox_messages g
                      WHERE g.input_id = m.goal_input_id
                        AND (g.status = 'CONSUMED' OR g.canceled_at IS NOT NULL))
       ORDER BY m.created_at, m.goal_input_id LIMIT 10`).all()) as Row[])
      .map((row) => ({ goalInputId: textValue(row, "goal_input_id") }));
  }

  async loadGoalProjections(): Promise<HarnessGoalProjection[]> {
    return this.database.transaction((connection) => queryHarnessGoalProjections(connection));
  }

  async createMap(input: { workbenchId: string; goalInputId: string; now: string }): Promise<boolean> {
    return this.database.transaction((connection) => connection.prepare(`
      INSERT OR IGNORE INTO joi_harness_maps
        (goal_input_id, workbench_id, status, created_at, updated_at)
      VALUES (?, ?, 'ACTIVE', ?, ?)`).run(input.goalInputId, input.workbenchId, input.now, input.now).changes > 0);
  }

  async synchronizeWorkPaths(input: { now: string }): Promise<{ closed: number; created: number }> {
    return this.database.transaction((connection) => {
      const missing = connection.prepare(`
        SELECT w.work_id, w.input_id AS goal_input_id, w.title, w.status, w.created_at,
               1 + (SELECT COUNT(*) FROM joi_inbox_messages r
                     WHERE r.goal_input_id = w.input_id
                       AND r.input_id LIKE 'joi_harness_review:goal:%'
                       AND r.created_at <= w.created_at) AS layer
          FROM work_items w
          JOIN joi_harness_maps m ON m.goal_input_id = w.input_id AND m.status = 'ACTIVE'
         WHERE NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id)
         ORDER BY w.created_at, w.work_id LIMIT 100`).all() as Row[];
      const insert = connection.prepare(`INSERT OR IGNORE INTO joi_harness_paths
        (path_id, goal_input_id, layer, title, status, work_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      let created = 0;
      for (const row of missing) {
        const workId = textValue(row, "work_id");
        const workStatus = textValue(row, "status");
        created += Number(insert.run(
          `harness_path:work:${workId}`,
          textValue(row, "goal_input_id"),
          Math.min(LAYER_MAX, numberValue(row, "layer")),
          textValue(row, "title").slice(0, PATH_TITLE_LIMIT),
          ["COMPLETED", "FAILED", "CANCELED"].includes(workStatus) ? "CLOSED" : "OPEN",
          workId,
          textValue(row, "created_at"),
          input.now,
        ).changes);
      }
      const closed = Number(connection.prepare(`UPDATE joi_harness_paths AS p
           SET status = 'CLOSED', updated_at = ?
         WHERE p.status = 'OPEN' AND p.work_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM work_items w WHERE w.work_id = p.work_id
                        AND w.status IN ('COMPLETED', 'FAILED', 'CANCELED'))`).run(input.now).changes);
      return { closed, created };
    });
  }

  async enqueueReview(input: { digest: HarnessReviewDigest; now: string }): Promise<string | null> {
    return this.database.transaction((connection) => {
      const { digest, now } = input;
      const gate = connection.prepare(`
        SELECT rs.revision AS result_revision
          FROM joi_harness_maps m
          JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
          JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
          JOIN joi_inbox_messages g ON g.input_id = m.goal_input_id
         WHERE m.goal_input_id = ? AND m.status = 'ACTIVE'
           AND rs.revision > m.reviewed_revision
           AND rs.synthesized_revision = rs.revision
           AND g.canceled_at IS NULL AND g.dismissed_at IS NULL AND g.failed_at IS NULL
           AND (o.disposition = 'COMPLETED' OR (
             o.disposition = 'CONTINUE'
             AND g.status = 'CONSUMED'
             AND g.clarification_reason_code IS NULL
             AND MAX(0, COALESCE((SELECT MAX(p.layer) FROM joi_harness_paths p
                                   WHERE p.goal_input_id = m.goal_input_id), 1) - 1) < m.continuation_allowance
           ))`).get(digest.goalInputId) as Row | undefined;
      if (gate === undefined) return null;
      const resultRevision = numberValue(gate, "result_revision");
      const active = connection.prepare(`
        SELECT 1 FROM work_items
         WHERE input_id = ? AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELED') LIMIT 1`)
        .get(digest.goalInputId);
      if (active !== undefined) return null;
      const goal = connection.prepare(`
        SELECT canceled_at, dismissed_at FROM joi_inbox_messages WHERE input_id = ?`)
        .get(digest.goalInputId) as Row | undefined;
      if (goal === undefined) return null;
      if (goal.canceled_at !== null || goal.dismissed_at !== null) return null;
      const inputId = `joi_harness_review:goal:${digest.goalInputId}:r${String(resultRevision)}`;
      connection.prepare(`
        INSERT OR IGNORE INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, workbench_id, goal_input_id, created_at, updated_at)
        VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`).run(
        inputId,
        `harness_review_goal:${digest.goalInputId}:${String(resultRevision)}`,
        composeReviewBody({ ...digest, resultRevision }),
        digest.workbenchId,
        digest.goalInputId,
        now,
        now,
      );
      connection.prepare(`
        UPDATE joi_harness_maps
           SET reviewed_revision = ?, revision = revision + 1, updated_at = ?
         WHERE goal_input_id = ? AND reviewed_revision < ?`).run(
        resultRevision, now, digest.goalInputId, resultRevision,
      );
      return inputId;
    });
  }

  async requestContinuationDecision(input: { now: string; seed: HarnessContinuationDecisionSeed }): Promise<boolean> {
    return this.database.transaction((connection) => {
      const eligible = connection.prepare(`SELECT 1
        FROM joi_harness_maps m
        JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
        JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
        JOIN joi_inbox_messages g ON g.input_id = m.goal_input_id
       WHERE m.goal_input_id = ? AND m.workbench_id = ? AND m.status = 'ACTIVE'
         AND rs.revision = ? AND rs.revision > m.reviewed_revision
         AND rs.synthesized_revision = rs.revision AND o.disposition = 'CONTINUE'
         AND MAX(0, COALESCE((SELECT MAX(p.layer) FROM joi_harness_paths p
                              WHERE p.goal_input_id = m.goal_input_id), 1) - 1) >= m.continuation_allowance
         AND g.status = 'CONSUMED'
         AND g.clarification_reason_code IS NULL
         AND g.canceled_at IS NULL AND g.dismissed_at IS NULL AND g.failed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = m.goal_input_id
                           AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
         AND NOT EXISTS (SELECT 1 FROM joi_user_action_requests a
                          WHERE a.input_id = m.goal_input_id AND a.status = 'OPEN')`).get(
        input.seed.goalInputId, input.seed.workbenchId, input.seed.resultRevision,
      );
      if (eligible === undefined) return false;
      const prompt = "已自动补充两轮，当前结果仍有明确缺口。可以继续补齐，或接受当前结果并保留缺口说明。";
      const inserted = connection.prepare(`INSERT OR IGNORE INTO joi_user_action_requests
        (action_id, input_id, result_revision, kind, status, reason_code, prompt, created_at, updated_at)
        VALUES (?, ?, ?, 'GOAL_CONTINUATION', 'OPEN', 'goal_continuation_required', ?, ?, ?)`).run(
        `joi_action:goal_continuation:${input.seed.goalInputId}:r${String(input.seed.resultRevision)}`,
        input.seed.goalInputId, input.seed.resultRevision, prompt, input.now, input.now,
      );
      if (inserted.changes === 0) return false;
      const raised = connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = 'goal_continuation_required',
            clarification_prompt = ?, updated_at = ?
        WHERE input_id = ? AND status = 'CONSUMED' AND clarification_reason_code IS NULL
          AND dismissed_at IS NULL AND canceled_at IS NULL AND failed_at IS NULL`).run(
        prompt, input.now, input.seed.goalInputId,
      );
      if (raised.changes !== 1) throw new Error("joi_goal_continuation_request_conflict");
      return true;
    });
  }

  async reconcileReview(input: { candidate: HarnessReviewRecoveryCandidate; now: string }): Promise<HarnessReviewRecoveryResult | null> {
    return this.database.transaction((connection) => {
      const { candidate, now } = input;
      const { goalInputId, resultRevision } = candidate.digest;
      const reviewId = reviewInputId(goalInputId, resultRevision);
      const current = connection.prepare(`
        SELECT m.reviewed_revision, m.status AS map_status, o.disposition AS outcome_disposition, rs.revision AS result_revision
          FROM joi_harness_maps m
          JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
          JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
          JOIN joi_inbox_messages g ON g.input_id = m.goal_input_id
          LEFT JOIN joi_inbox_messages r ON r.input_id = ?
         WHERE m.goal_input_id = ? AND m.status IN ('ACTIVE', 'CLEARED')
           AND rs.synthesized_revision = rs.revision
           AND rs.revision = ? AND m.reviewed_revision = rs.revision
           AND g.canceled_at IS NULL AND g.dismissed_at IS NULL AND g.failed_at IS NULL
           AND ${REVIEW_GATE_OPEN_SQL}
           AND (g.status = 'CONSUMED' OR (g.status = 'CLARIFICATION_REQUIRED'
             AND g.clarification_reason_code = 'harness_review_unrecoverable'))
           AND (r.input_id IS NULL OR (
             r.status IN ('CONSUMED', 'ROUTED')
             AND (r.failed_at IS NOT NULL OR EXISTS (
               SELECT 1 FROM joi_turns failed_review
                WHERE failed_review.input_id = r.input_id AND failed_review.status = 'FAILED'
             ) OR (${REVIEW_FACTS_COMPLETE_SQL}
             ))
             AND NOT EXISTS (SELECT 1 FROM joi_turns live_review
                              WHERE live_review.input_id = r.input_id
                                AND live_review.status IN ('PENDING', 'RUNNING', 'WAITING'))
           ) OR (g.status = 'CLARIFICATION_REQUIRED' AND r.status IN ('PENDING', 'FAILED', 'CLARIFICATION_REQUIRED', 'CONSUMED', 'ROUTED')
             AND NOT EXISTS (SELECT 1 FROM joi_turns live_review
                              WHERE live_review.input_id = r.input_id
                                AND live_review.status IN ('PENDING', 'RUNNING', 'WAITING')))
           )
           AND NOT EXISTS (SELECT 1 FROM work_items w
                            WHERE w.input_id = m.goal_input_id
                              AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))`).get(
        reviewId, goalInputId, resultRevision,
      ) as Row | undefined;
      if (current === undefined) return null;

      if (candidate.action === "AUTO_CLEAR") {
        if (optionalText(current, "outcome_disposition") !== "COMPLETED") return null;
        const safe = connection.prepare(`
          SELECT 1
            FROM joi_harness_maps m
           WHERE m.goal_input_id = ?
             AND NOT EXISTS (SELECT 1 FROM work_items w
                              WHERE w.input_id = m.goal_input_id
                                AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
             AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p
                              WHERE p.goal_input_id = m.goal_input_id AND p.status = 'OPEN')
             AND NOT EXISTS (SELECT 1 FROM work_items w
                              WHERE w.input_id = m.goal_input_id
                                AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id))`).get(goalInputId);
        if (safe === undefined) return null;
        const cleared = connection.prepare(`UPDATE joi_harness_maps
          SET status = 'CLEARED', cleared_at = COALESCE(cleared_at, ?), revision = revision + 1, updated_at = ?
          WHERE goal_input_id = ? AND status = 'ACTIVE'`).run(now, now, goalInputId);
        // Only touch rows that actually change: an already CLEARED map with clean inbox rows
        // must not bump updated_at again, or every actor tick re-sorts the home feed.
        const goalCleaned = connection.prepare(`UPDATE joi_inbox_messages
          SET status = 'CONSUMED', failed_at = NULL, failure_reason_code = NULL, failure_count = NULL,
              clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
          WHERE input_id = ? AND (
            (status = 'CLARIFICATION_REQUIRED' AND clarification_reason_code = 'harness_review_unrecoverable')
            OR (status = 'CONSUMED' AND (failed_at IS NOT NULL OR failure_reason_code IS NOT NULL
              OR failure_count IS NOT NULL OR clarification_reason_code IS NOT NULL OR clarification_prompt IS NOT NULL)))`).run(now, goalInputId);
        const reviewCleaned = connection.prepare(`UPDATE joi_inbox_messages
          SET status = 'CONSUMED', failed_at = NULL, failure_reason_code = NULL, failure_count = NULL,
              clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
          WHERE input_id = ? AND (
            status IN ('PENDING', 'FAILED', 'CLARIFICATION_REQUIRED', 'ROUTED')
            OR (status = 'CONSUMED' AND (failed_at IS NOT NULL OR failure_reason_code IS NOT NULL
              OR failure_count IS NOT NULL OR clarification_reason_code IS NOT NULL OR clarification_prompt IS NOT NULL)))
            AND NOT EXISTS (SELECT 1 FROM joi_turns t
                            WHERE t.input_id = joi_inbox_messages.input_id
                              AND t.status IN ('PENDING', 'RUNNING', 'WAITING'))`).run(now, reviewId);
        if (Number(cleared.changes) + Number(goalCleaned.changes) + Number(reviewCleaned.changes) === 0) return null;
        return { action: "AUTO_CLEARED" as const };
      }

      if (candidate.action === "REQUEUE") {
        const safe = connection.prepare(`
          SELECT 1
            FROM joi_inbox_messages r
           WHERE r.input_id = ? AND r.status IN ('CONSUMED', 'ROUTED')
             AND EXISTS (SELECT 1 FROM joi_turns t WHERE t.input_id = r.input_id)
             AND NOT EXISTS (SELECT 1 FROM joi_turns t WHERE t.input_id = r.input_id AND t.status IN ('PENDING', 'RUNNING', 'WAITING'))
             AND NOT EXISTS (SELECT 1 FROM joi_turns t WHERE t.input_id = r.input_id AND t.side_effect_started = 1)
             AND NOT EXISTS (SELECT 1 FROM work_items w
                              WHERE w.input_id = ? AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
             AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p
                              WHERE p.goal_input_id = ? AND p.status = 'OPEN')
             AND NOT EXISTS (SELECT 1 FROM work_items w
                              WHERE w.input_id = ?
                                AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id))`).get(
          reviewId, goalInputId, goalInputId, goalInputId,
        );
        if (safe === undefined) return null;
        const updated = connection.prepare(`UPDATE joi_inbox_messages
          SET status = 'PENDING', failed_at = NULL, failure_reason_code = NULL, failure_count = NULL,
              canceled_at = NULL, clarification_reason_code = NULL, clarification_prompt = NULL, updated_at = ?
          WHERE input_id = ? AND status IN ('CONSUMED', 'ROUTED')`).run(now, reviewId);
        return updated.changes === 1 ? { action: "REQUEUED" as const, inputId: reviewId } : null;
      }

      const quarantined = connection.prepare(`UPDATE joi_inbox_messages
        SET status = 'CLARIFICATION_REQUIRED', clarification_reason_code = 'harness_review_unrecoverable',
            clarification_prompt = '历史评审记录无法安全恢复。请补充新的要求后继续，或取消这条任务。', updated_at = ?
        WHERE input_id = ? AND status = 'CONSUMED' AND dismissed_at IS NULL AND canceled_at IS NULL AND failed_at IS NULL`).run(now, goalInputId);
      return quarantined.changes === 1 ? { action: "QUARANTINED" as const } : null;
    });
  }

  async recordCompletionFeedback(input: { workbenchId: string; entry: string; goalInputId: string; now: string }): Promise<boolean> {
    return this.database.transaction((connection) => {
      const gate = connection.prepare(`
        UPDATE joi_harness_maps
           SET feedback_recorded_at = ?, updated_at = ?
         WHERE goal_input_id = ? AND status = 'CLEARED' AND feedback_recorded_at IS NULL`)
        .run(input.now, input.now, input.goalInputId);
      if (gate.changes === 0) return false;
      const row = connection.prepare(`
        SELECT task_summary FROM workbenches WHERE workbench_id = ? AND status = 'ACTIVE'`)
        .get(input.workbenchId) as Row | undefined;
      if (row === undefined) return true;
      const current = typeof row.task_summary === "string" ? row.task_summary : "";
      const next = `${current}${current === "" ? "" : "\n"}${input.entry}`.slice(-TASK_SUMMARY_KEEP_CHARS);
      connection.prepare(`
        UPDATE workbenches SET task_summary = ?, updated_at = ? WHERE workbench_id = ? AND status = 'ACTIVE'`)
        .run(next, input.now, input.workbenchId);
      return true;
    });
  }

  async clearTrivialMap(input: { goalInputId: string; now: string }): Promise<boolean> {
    return this.database.transaction((connection) => connection.prepare(`
      UPDATE joi_harness_maps
         SET status = 'CLEARED', cleared_at = ?, feedback_recorded_at = ?,
             revision = revision + 1, updated_at = ?
       WHERE goal_input_id = ? AND status = 'ACTIVE' AND destination IS NULL
         AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.goal_input_id = joi_harness_maps.goal_input_id)
         AND NOT EXISTS (SELECT 1 FROM joi_harness_decisions d WHERE d.goal_input_id = joi_harness_maps.goal_input_id)
         AND NOT EXISTS (SELECT 1 FROM joi_harness_fog f WHERE f.goal_input_id = joi_harness_maps.goal_input_id)
         AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = joi_harness_maps.goal_input_id)
         AND NOT EXISTS (SELECT 1 FROM joi_goal_result_sets rs
                          WHERE rs.original_input_id = joi_harness_maps.goal_input_id AND rs.revision > 0)
         AND EXISTS (SELECT 1 FROM joi_inbox_messages g
                      WHERE g.input_id = joi_harness_maps.goal_input_id
                        AND (g.status = 'CONSUMED' OR g.canceled_at IS NOT NULL))`)
      .run(input.now, input.now, input.now, input.goalInputId).changes > 0);
  }

  async nameDestination(input: { destination: string; goalInputId: string; turnId: string }): Promise<{ destination: string; revision: number }> {
    const destination = requireText(input.destination, DESTINATION_LIMIT, "harness_destination_invalid");
    return this.database.transaction((connection) => {
      const now = new Date().toISOString();
      this.#requireActiveMap(connection, input.goalInputId, now);
      connection.prepare(`
        UPDATE joi_harness_maps SET destination = ?, revision = revision + 1, updated_at = ?
         WHERE goal_input_id = ?`).run(destination, now, input.goalInputId);
      const row = connection.prepare(`
        SELECT revision FROM joi_harness_maps WHERE goal_input_id = ?`).get(input.goalInputId) as Row;
      return { destination, revision: numberValue(row, "revision") };
    });
  }

  async chartPath(input: {
    close?: { pathId: string; status: "CLOSED" | "OUT_OF_SCOPE" };
    goalInputId: string;
    open?: { layer: number; title: string; workId?: string };
    turnId: string;
  }): Promise<{ pathId: string; status: HarnessPathStatus }> {
    const hasOpen = input.open !== undefined;
    const hasClose = input.close !== undefined;
    if (hasOpen === hasClose) throw new DomainError("harness_path_invalid", "Chart exactly one path action.");
    return this.database.transaction((connection) => {
      const now = new Date().toISOString();
      this.#requireActiveMap(connection, input.goalInputId, now);
      if (input.close !== undefined) {
        const result = connection.prepare(`
          UPDATE joi_harness_paths SET status = ?, updated_at = ?
           WHERE path_id = ? AND goal_input_id = ? AND status = 'OPEN'`)
          .run(input.close.status, now, input.close.pathId, input.goalInputId);
        if (result.changes === 0) throw new DomainError("harness_path_invalid", "Path is not open.");
        this.#bumpRevision(connection, input.goalInputId, now);
        return { pathId: input.close.pathId, status: input.close.status };
      }
      const open = input.open;
      if (open === undefined) throw new DomainError("harness_path_invalid", "Path action is missing.");
      if (!Number.isInteger(open.layer) || open.layer < LAYER_MIN || open.layer > LAYER_MAX) {
        throw new DomainError("harness_path_invalid", "Path layer is out of bounds.");
      }
      const title = requireText(open.title, PATH_TITLE_LIMIT, "harness_path_invalid");
      const workId = this.#validatedWorkId(connection, input.goalInputId, open.workId);
      const pathId = randomUUID();
      connection.prepare(`
        INSERT INTO joi_harness_paths
          (path_id, goal_input_id, layer, title, status, work_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?)`).run(
        pathId, input.goalInputId, open.layer, title, workId, now, now,
      );
      this.#bumpRevision(connection, input.goalInputId, now);
      return { pathId, status: "OPEN" as const };
    });
  }

  async recordDecision(input: {
    closePathId?: string;
    detail?: string;
    goalInputId: string;
    kind: HarnessDecisionKind;
    summary: string;
    turnId: string;
  }): Promise<{ decisionId: string }> {
    if (!(DECISION_KINDS as readonly string[]).includes(input.kind)) {
      throw new DomainError("harness_decision_invalid", "Decision kind is unknown.");
    }
    const summary = requireText(input.summary, DECISION_SUMMARY_LIMIT, "harness_decision_invalid");
    const detail = input.detail === undefined ? "" : input.detail.trim();
    if (detail.length > DECISION_DETAIL_LIMIT) throw new DomainError("harness_decision_invalid", "Decision detail is too long.");
    return this.database.transaction((connection) => {
      const now = new Date().toISOString();
      this.#requireActiveMap(connection, input.goalInputId, now);
      const decisionId = randomUUID();
      connection.prepare(`
        INSERT INTO joi_harness_decisions
          (decision_id, goal_input_id, kind, summary, detail, turn_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        decisionId, input.goalInputId, input.kind, summary, detail, input.turnId, now,
      );
      if (input.closePathId !== undefined) {
        connection.prepare(`
          UPDATE joi_harness_paths SET status = 'CLOSED', resolved_decision_id = ?, updated_at = ?
           WHERE path_id = ? AND goal_input_id = ? AND status = 'OPEN'`)
          .run(decisionId, now, input.closePathId, input.goalInputId);
      }
      this.#bumpRevision(connection, input.goalInputId, now);
      return { decisionId };
    });
  }

  async noteFog(input: { goalInputId: string; note: string; turnId: string }): Promise<{ fogId: string }> {
    const note = requireText(input.note, FOG_NOTE_LIMIT, "harness_fog_invalid");
    return this.database.transaction((connection) => {
      const now = new Date().toISOString();
      this.#requireActiveMap(connection, input.goalInputId, now);
      const fogId = randomUUID();
      connection.prepare(`
        INSERT INTO joi_harness_fog
          (fog_id, goal_input_id, note, status, created_at, updated_at)
        VALUES (?, ?, ?, 'ACTIVE', ?, ?)`).run(fogId, input.goalInputId, note, now, now);
      this.#bumpRevision(connection, input.goalInputId, now);
      return { fogId };
    });
  }

  async graduateFog(input: {
    fogId: string;
    goalInputId: string;
    layer: number;
    title: string;
    turnId: string;
    workId?: string;
  }): Promise<{ fogId: string; pathId: string }> {
    if (!Number.isInteger(input.layer) || input.layer < LAYER_MIN || input.layer > LAYER_MAX) {
      throw new DomainError("harness_fog_invalid", "Graduated path layer is out of bounds.");
    }
    const title = requireText(input.title, PATH_TITLE_LIMIT, "harness_fog_invalid");
    return this.database.transaction((connection) => {
      const now = new Date().toISOString();
      this.#requireActiveMap(connection, input.goalInputId, now);
      const workId = this.#validatedWorkId(connection, input.goalInputId, input.workId);
      const existing = connection.prepare(`
        SELECT 1 FROM joi_harness_fog WHERE fog_id = ? AND goal_input_id = ? AND status = 'ACTIVE'`)
        .get(input.fogId, input.goalInputId);
      if (existing === undefined) throw new DomainError("harness_fog_invalid", "Fog note is not active.");
      const pathId = randomUUID();
      connection.prepare(`
        INSERT INTO joi_harness_paths
          (path_id, goal_input_id, layer, title, status, work_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?)`).run(
        pathId, input.goalInputId, input.layer, title, workId, now, now,
      );
      connection.prepare(`
        UPDATE joi_harness_fog SET status = 'GRADUATED', graduated_path_id = ?, updated_at = ?
         WHERE fog_id = ? AND goal_input_id = ? AND status = 'ACTIVE'`)
        .run(pathId, now, input.fogId, input.goalInputId);
      this.#bumpRevision(connection, input.goalInputId, now);
      return { fogId: input.fogId, pathId };
    });
  }

  async clearMap(input: { goalInputId: string; turnId: string }): Promise<boolean> {
    return this.database.transaction((connection) => {
      const now = new Date().toISOString();
      return connection.prepare(`
        UPDATE joi_harness_maps AS m
           SET status = 'CLEARED', cleared_at = ?, revision = revision + 1, updated_at = ?
         WHERE m.goal_input_id = ? AND m.status = 'ACTIVE'
           AND EXISTS (
             SELECT 1 FROM joi_turns t
             JOIN joi_inbox_messages r ON r.input_id = t.input_id
             JOIN joi_goal_result_sets current_rs ON current_rs.original_input_id = m.goal_input_id
              WHERE t.turn_id = ? AND t.status IN ('RUNNING', 'WAITING')
                AND r.goal_input_id = m.goal_input_id
                AND r.input_id = 'joi_harness_review:goal:' || m.goal_input_id || ':r' || current_rs.revision
                AND current_rs.revision = m.reviewed_revision
           )
           AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = m.goal_input_id
                            AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
           AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.goal_input_id = m.goal_input_id
                            AND p.status = 'OPEN')
           AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = m.goal_input_id
                            AND NOT EXISTS (SELECT 1 FROM joi_harness_paths p WHERE p.work_id = w.work_id))
           AND EXISTS (
             SELECT 1 FROM joi_goal_result_sets rs
             JOIN joi_goal_outcomes o ON o.input_id = rs.original_input_id
                                      AND o.result_revision = rs.revision
              WHERE rs.original_input_id = m.goal_input_id
                AND rs.revision > 0
                AND rs.synthesized_revision = rs.revision
                AND m.reviewed_revision = rs.revision
                AND o.disposition = 'COMPLETED'
           )`)
        .run(now, now, input.goalInputId, input.turnId).changes > 0;
    });
  }

  #requireActiveMap(connection: DatabaseSync, goalInputId: string, now: string): void {
    connection.prepare(`
      INSERT OR IGNORE INTO joi_harness_maps
        (goal_input_id, workbench_id, status, created_at, updated_at)
      SELECT ?, i.workbench_id, 'ACTIVE', ?, ?
        FROM joi_inbox_messages i
       WHERE i.input_id = ? AND i.workbench_id IS NOT NULL`)
      .run(goalInputId, now, now, goalInputId);
    const row = connection.prepare(`
      SELECT status FROM joi_harness_maps WHERE goal_input_id = ?`).get(goalInputId) as Row | undefined;
    if (row?.status !== "ACTIVE") {
      throw new DomainError("harness_map_unavailable", "Goal map is missing or not active.");
    }
  }

  #bumpRevision(connection: DatabaseSync, goalInputId: string, now: string): void {
    connection.prepare(`
      UPDATE joi_harness_maps SET revision = revision + 1, updated_at = ? WHERE goal_input_id = ?`)
      .run(now, goalInputId);
  }

  #validatedWorkId(connection: DatabaseSync, goalInputId: string, workId: string | undefined): string | null {
    if (workId === undefined) return null;
    const row = connection.prepare(`
      SELECT 1 FROM work_items WHERE work_id = ? AND input_id = ?`).get(workId, goalInputId);
    if (row === undefined) throw new DomainError("harness_path_invalid", "Work does not belong to this goal.");
    return workId;
  }
}
