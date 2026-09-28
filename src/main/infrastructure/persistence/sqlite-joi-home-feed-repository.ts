/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiGoalCardBaseDto, JoiGoalCardDto, JoiGoalHarnessDto, JoiGoalStatusDto, JoiHomeFeedDto, JoiThinkingItemDto, WorkbenchArtifactDto } from "../../../shared/joi.js";
import type { JoiHomeFeedRepository } from "../../application/ports/joi-home-feed.js";
import type { HarnessGoalProjection } from "../../application/ports/joi-harness.js";
import { normalizeJoiFailureReasonCode, suggestedActionForJoiInputFailure } from "../../application/joi/joi-input-failure.js";
import { maskSecretText, stripPathRedactions } from "../../application/partners/agent-conversation-presentation.js";
import { workResultArtifactId, workspaceArtifactDirectory, workspaceArtifactRelativePath } from "../../domain/work/workspace-artifact-reference.js";
import { queryHarnessGoalProjections } from "./sqlite-joi-harness-repository.js";

interface TransactionalDatabase { transaction<T>(operation: (database: DatabaseSync) => T): T }
type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("joi_home_feed_record_invalid");
  return value;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error("joi_home_feed_record_invalid");
  return value;
}

function toHarnessDto(projection: {
  currentLayer: number;
  decisionCount: number;
  destination: string | null;
  fogCount: number;
  mapStatus: JoiGoalHarnessDto["mapStatus"];
  openPathCount: number;
  reviewedRevision: number;
  revision: number;
  topFogNote: string | null;
  topPaths: JoiGoalHarnessDto["topPaths"];
}): JoiGoalHarnessDto {
  return {
    currentLayer: projection.currentLayer,
    decisionCount: projection.decisionCount,
    ...(projection.destination === null ? {} : { destination: projection.destination }),
    fogCount: projection.fogCount,
    mapStatus: projection.mapStatus,
    openPathCount: projection.openPathCount,
    reviewedRevision: projection.reviewedRevision,
    revision: projection.revision,
    ...(projection.topFogNote === null ? {} : { topFogNote: projection.topFogNote }),
    topPaths: projection.topPaths,
  };
}

/** Turn statuses that mean the orchestrator still owns the goal right now. */
const LIVE_TURN_STATUSES: ReadonlySet<string> = new Set(["PENDING", "RUNNING", "WAITING"]);

/**
 * Evidence that the goal attained something.
 *
 * A consumed inbox row is not evidence — it only records that a Turn took the input, which is
 * equally true of a Turn that ended without dispatching anything. Work, a synthesized result, and
 * a committed turn completion are. A direct answer is the one completion that legitimately has no
 * Work behind it, and that path always writes the completion row this reads.
 */
function producedGoalEvidence(row: Row): boolean {
  return number(row, "work_total") > 0
    || number(row, "result_revision") > 0
    || typeof row.turn_completed_at === "string";
}

function goalStatus(row: Row, harness: HarnessGoalProjection | undefined): JoiGoalStatusDto {
  if (row.failed_at !== null && row.failed_at !== undefined) return "FAILED";
  if (row.canceled_at !== null && row.canceled_at !== undefined) return "CANCELED";
  if (row.gate_status === "WAITING_INPUT") return "NEEDS_ATTENTION";
  if (row.gate_status === "REVIEWING") return "REVIEWING";
  const blockedOutcome = number(row, "outcome_current") === 1 && row.outcome_disposition === "BLOCKED";
  const recoveryAvailable = number(row, "recovery_pending_count") > 0 || number(row, "recoverable_failed_count") > 0;
  const internalRecoveryClarification = row.clarification_reason_code === "work_dispatch_failed";
  if (blockedOutcome && recoveryAvailable
    && (row.clarification_reason_code === null || row.clarification_reason_code === undefined || internalRecoveryClarification)) {
    return "EXTENDING";
  }
  if (row.clarification_reason_code !== null && row.clarification_reason_code !== undefined) return "NEEDS_ATTENTION";
  // A transient invariant-repair window is active backend work, not a user request.
  // The Workbench actor will either restore an OPEN action or advance the Work.
  if (number(row, "waiting_count") > 0) return "RUNNING";
  // A retry is persisted before its new Turn exists. Keep the card in the arranging
  // state even when the goal still owns planned work from an earlier attempt.
  if (text(row, "inbox_status") === "PENDING") return "ARRANGING";
  const activeMap = harness?.mapStatus === "ACTIVE";
  if (blockedOutcome) return "FAILED";
  if (activeMap && harness.reviewedRevision > 0 && number(row, "work_active") > 0) return "EXTENDING";
  if (number(row, "running_count") > 0) return "RUNNING";
  if (number(row, "arranged_count") > 0) return "ARRANGED";
  if (number(row, "work_total") > 0 && number(row, "work_active") === 0 && number(row, "outcome_current") === 0) return "FINALIZING";
  // The goal's latest Turn failed and left nothing running, no Work and no outcome: it
  // stopped without producing anything. Without this the card falls through to the
  // "consumed inbox means COMPLETED" fallback and reports attainment for a Turn that
  // never dispatched (an earlier Turn had already consumed the row).
  if (row.latest_turn_status === "FAILED" && number(row, "work_total") === 0 && number(row, "outcome_current") === 0) return "FAILED";
  // A synthesized result is one completed Wayfinder layer. It becomes the goal's
  // terminal outcome only after the active map is explicitly cleared by review.
  if (number(row, "outcome_current") === 1 && activeMap) return "REVIEWING";
  // An up-to-date synthesized outcome means the goal lifecycle is done even when the
  // orchestration turn is still open (long wait turn) or leaked (orphan not yet recovered).
  if (number(row, "outcome_current") === 1) {
    if (row.outcome_disposition === "BLOCKED") return "FAILED";
    if (row.outcome_disposition === "ACCEPTED_WITH_GAPS") return "COMPLETED_WITH_GAPS";
    // A CONTINUE outcome is one evidence layer, never a terminal attainment, and the live-map arm
    // above has already claimed it for review. Reaching this branch means no map is ACTIVE, so
    // nothing will ever arrange that layer: the close-out outran its own evidence. Report the
    // closed lifecycle the goal actually reached instead of a badge that can never resolve.
    if (row.outcome_disposition === "CONTINUE") return "COMPLETED";
    return "COMPLETED";
  }
  // A retry may reuse the same goal and evidence revision. Its older completion remains an
  // audit fact, but cannot settle the newly opened request if the new Turn made no progress.
  if (number(row, "outcome_stale") === 1 && text(row, "inbox_status") === "CONSUMED") return "FAILED";
  // A Turn still on the wire is active backend work, so the goal cannot be terminal yet. This sits
  // below every evidence arm on purpose: a goal that already attained something kept its own
  // branch, and a synthesized outcome stays COMPLETED even while a long wait Turn is still open.
  // Nothing above this point speaks for a goal carrying no Work at all, and that is the shape a
  // gate-paused goal resumes into — before its first dispatch it owns no Work to make it active.
  const latestTurn = row.latest_turn_status;
  if (typeof latestTurn === "string" && LIVE_TURN_STATUSES.has(latestTurn)) return "ARRANGING";
  if (text(row, "inbox_status") === "CONSUMED") {
    if (producedGoalEvidence(row)) return "COMPLETED";
    // Consumed, but empty: the Turn ended without producing Work, a result, or a committed
    // completion. Report the closed lifecycle the goal actually reached, the same way a failed
    // Turn that left nothing behind is reported above, instead of claiming an attainment.
    return "FAILED";
  }
  return "ARRANGING";
}

function thinkingStage(goal: JoiGoalCardDto | undefined, phase: JoiThinkingItemDto["phase"], inputId: string): JoiThinkingItemDto["stage"] {
  if (inputId.startsWith("joi_harness_review:goal:")) return goal?.status === "EXTENDING" ? "EXTENDING" : "REVIEWING";
  if (phase === "queued") return "ROUTING";
  if (goal === undefined) return "PLANNING";
  if (goal.status === "ARRANGED") return "DISPATCHING";
  if (goal.status === "RUNNING") return "RUNNING";
  if (goal.status === "REVIEWING") return "REVIEWING";
  if (goal.status === "EXTENDING") return "EXTENDING";
  if (goal.status === "NEEDS_ATTENTION") return "WAITING";
  if (goal.status === "FINALIZING") return "FINALIZING";
  return "PLANNING";
}

function thinkingPhasePriority(phase: JoiThinkingItemDto["phase"]): number {
  if (phase === "progressing") return 2;
  if (phase === "queued") return 1;
  return 0;
}

/** One goal owns one visible progress row, even when recovery leaves multiple Turns active. */
function collapseThinkingByGoal(items: JoiThinkingItemDto[]): JoiThinkingItemDto[] {
  const byGoal = new Map<string, JoiThinkingItemDto>();
  for (const item of items) {
    const current = byGoal.get(item.goalId);
    if (current === undefined) {
      byGoal.set(item.goalId, item);
      continue;
    }
    const priority = thinkingPhasePriority(item.phase);
    const currentPriority = thinkingPhasePriority(current.phase);
    if (priority > currentPriority || (priority === currentPriority && priority > 0 && item.startedAt < current.startedAt)) {
      byGoal.set(item.goalId, item);
    }
  }
  return [...byGoal.values()];
}

function goalArtifacts(connection: DatabaseSync, goalId: string, workbenchId: string): WorkbenchArtifactDto[] {
  const rows = connection.prepare(`SELECT r.result_id, r.artifacts_json FROM work_results r
    JOIN work_items w ON w.work_id = r.work_id
    WHERE r.workbench_id = ? AND w.input_id = ? AND r.is_authoritative = 1 AND r.status = 'COMPLETED'
    ORDER BY r.created_at, r.result_id`).all(workbenchId, goalId) as Row[];
  const result: WorkbenchArtifactDto[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.result_id !== "string" || typeof row.artifacts_json !== "string") continue;
    let artifacts: unknown;
    try { artifacts = JSON.parse(row.artifacts_json); } catch { continue; }
    if (!Array.isArray(artifacts)) continue;
    artifacts.forEach((candidate, index) => {
      if (candidate === null || typeof candidate !== "object") return;
      const artifact = candidate as Record<string, unknown>;
      const relativePath = workspaceArtifactRelativePath(typeof artifact.artifactRef === "string" ? artifact.artifactRef : undefined);
      if (relativePath === undefined || seen.has(relativePath) || typeof artifact.name !== "string" || typeof artifact.size !== "number") return;
      seen.add(relativePath);
      const mimeType = typeof artifact.mimeType === "string" ? artifact.mimeType : "application/octet-stream";
      const isDirectory = mimeType === "inode/directory";
      const directory = isDirectory ? relativePath : workspaceArtifactDirectory(relativePath);
      result.push({
        artifactId: workResultArtifactId(row.result_id as string, index),
        ...(directory === undefined ? {} : { directory }),
        kind: isDirectory ? "DIRECTORY" : "FILE",
        mimeType,
        name: artifact.name,
        size: artifact.size,
      });
    });
  }
  return result;
}

/**
 * Failed Works a recovery chain has already superseded, per goal.
 *
 * The chain is followed to its end rather than one step, because a replacement may itself fail and
 * be replaced again; only a chain that finishes on a completed Work means the failure was actually
 * answered. A bare failure count cannot say that, and the card would otherwise report a failure that
 * is still open and one that was fixed as the same thing.
 */
function resolvedFailureCounts(connection: DatabaseSync): Map<string, number> {
  const rows = connection.prepare(`
    WITH RECURSIVE chain(origin, node, depth) AS (
      SELECT r.source_work_id, r.replacement_work_id, 1 FROM work_recovery_attempts r
       WHERE r.replacement_work_id IS NOT NULL
      UNION ALL
      SELECT c.origin, r.replacement_work_id, c.depth + 1 FROM chain c
        JOIN work_recovery_attempts r ON r.source_work_id = c.node AND r.replacement_work_id IS NOT NULL
       WHERE c.depth < 8
    )
    SELECT w.input_id AS goal_input_id, COUNT(DISTINCT w.work_id) AS resolved
      FROM work_items w
      JOIN chain c ON c.origin = w.work_id
      JOIN work_items replacement ON replacement.work_id = c.node AND replacement.status = 'COMPLETED'
     WHERE w.status = 'FAILED'
     GROUP BY w.input_id`).all() as Row[];
  return new Map(rows.map((row) => [text(row, "goal_input_id"), number(row, "resolved")]));
}

export class SqliteJoiHomeFeedRepository implements JoiHomeFeedRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async load(now: Date): Promise<JoiHomeFeedDto> {
    return this.database.transaction((connection) => {
      const rows = connection.prepare(`SELECT i.input_id, i.body, i.status AS inbox_status, i.clarification_reason_code, i.clarification_prompt,
        gate.status AS gate_status, gate.question_id, gate.question_version,
        i.canceled_at, i.failed_at, i.failure_reason_code, i.failure_count,
        -- Latest orchestration Turn of this goal, resolve rows included: a goal-resume row
        -- carries the goal id in goal_input_id, so its failed recovery Turn must count too.
        (SELECT t.status FROM joi_turns t
          JOIN joi_inbox_messages source ON source.input_id = t.input_id
          WHERE COALESCE(source.goal_input_id, source.input_id) = i.input_id
          ORDER BY t.created_at DESC, t.turn_id DESC LIMIT 1) AS latest_turn_status,
        COALESCE(o.completed_at, tc.completed_at, i.updated_at) AS projection_updated_at, a.workbench_id, a.name AS workbench_name,
        COUNT(w.work_id) AS work_total,
        COALESCE(SUM(CASE WHEN w.status IN ('PLANNED','READY','RUNNING','WAITING') THEN 1 ELSE 0 END), 0) AS work_active,
        COALESCE(SUM(CASE WHEN w.status = 'COMPLETED' THEN 1 ELSE 0 END), 0) AS completed_count,
        COALESCE(SUM(CASE WHEN w.status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed_count,
        COALESCE(SUM(CASE WHEN w.status = 'RUNNING' OR (w.status IN ('PLANNED','READY') AND EXISTS (
          SELECT 1 FROM partner_runs running
          JOIN dispatch_attempts current_attempt ON current_attempt.dispatch_attempt_id = running.dispatch_attempt_id
          WHERE running.work_id = w.work_id AND running.status = 'RUNNING'
            AND current_attempt.status IN ('PENDING','DISPATCHED','ACCEPTED','RUNNING')
            AND current_attempt.dispatch_attempt_id = (SELECT latest.dispatch_attempt_id FROM dispatch_attempts latest
              WHERE latest.work_id = w.work_id ORDER BY latest.created_at DESC, latest.dispatch_attempt_id DESC LIMIT 1)
        )) THEN 1 ELSE 0 END), 0) AS running_count,
        COALESCE(SUM(CASE WHEN w.status = 'WAITING' THEN 1 ELSE 0 END), 0) AS waiting_count,
        COALESCE(SUM(CASE WHEN w.status IN ('PLANNED','READY') THEN 1 ELSE 0 END), 0) AS arranged_count,
        (SELECT COUNT(DISTINCT s.agent_id) FROM workbench_agent_sessions s
          LEFT JOIN dispatch_attempts da ON s.backing_kind = 'LOCAL_INSTANCE' AND da.instance_id = s.backing_id
          LEFT JOIN partner_runs pr ON s.backing_kind = 'A2A_RUN' AND pr.run_id = s.backing_id
          LEFT JOIN work_items aw ON aw.work_id = COALESCE(da.work_id, pr.work_id)
          WHERE s.dismissed_at IS NULL AND aw.input_id = i.input_id) AS agent_count,
        COALESCE(rs.revision, 0) AS result_revision,
        CASE WHEN o.result_revision = rs.revision AND rs.revision > 0
          AND o.completed_at >= COALESCE(i.reopened_at, i.created_at) THEN 1 ELSE 0 END AS outcome_current,
        CASE WHEN o.completed_at < i.reopened_at THEN 1 ELSE 0 END AS outcome_stale,
        o.disposition AS outcome_disposition, o.completion_summary, o.completed_at, tc.completion_summary AS turn_completion_summary,
        tc.completed_at AS turn_completed_at,
        (SELECT COUNT(*) FROM partner_runs ar JOIN work_items rrw ON rrw.work_id = ar.work_id
          WHERE rrw.input_id = i.input_id AND ar.status IN ('RUNNING','WAITING_INPUT','WAITING_AUTH')) AS active_runs,
        (SELECT COUNT(*) FROM joi_inbox_messages recovery
          WHERE recovery.goal_input_id = i.input_id AND recovery.input_id LIKE 'joi_recovery:goal:%'
            AND recovery.status IN ('PENDING','ROUTED')) AS recovery_pending_count,
        (SELECT COUNT(*) FROM work_items failed
          WHERE failed.input_id = i.input_id AND failed.status = 'FAILED'
            AND EXISTS (SELECT 1 FROM joi_harness_maps recovery_map
              WHERE recovery_map.goal_input_id = i.input_id AND recovery_map.status = 'ACTIVE')
            AND (SELECT COUNT(*) FROM work_recovery_attempts attempt WHERE attempt.source_work_id = failed.work_id) < 2
            AND (SELECT COUNT(*) FROM joi_inbox_messages recovery
              WHERE recovery.goal_input_id = i.input_id
                AND substr(recovery.idempotency_key, 1, length('work_recovery:' || failed.work_id || ':'))
                  = 'work_recovery:' || failed.work_id || ':') < 2) AS recoverable_failed_count
        FROM joi_inbox_messages i LEFT JOIN workbenches a ON a.workbench_id = i.workbench_id
        LEFT JOIN work_items w ON w.input_id = i.input_id
        LEFT JOIN joi_goal_result_sets rs ON rs.original_input_id = i.input_id
        LEFT JOIN joi_goal_outcomes o ON o.input_id = i.input_id
        LEFT JOIN joi_turn_completions tc ON tc.input_id = i.input_id
        LEFT JOIN joi_goal_execution_gates gate ON gate.goal_input_id = i.input_id
        WHERE i.dismissed_at IS NULL AND i.input_id NOT LIKE 'joi_result_input:%'
          AND i.input_id NOT LIKE 'joi_harness_review:%'
          AND i.goal_input_id IS NULL
          AND NOT (i.workbench_id IS NULL AND i.status = 'CLARIFICATION_REQUIRED')
        GROUP BY i.input_id ORDER BY COALESCE(i.last_opened_at, i.created_at) DESC, i.input_id DESC`).all() as Row[];
      const harnessByGoal = new Map(queryHarnessGoalProjections(connection).map((projection) => [projection.goalInputId, projection]));
      const resolvedFailures = resolvedFailureCounts(connection);
      const goals: JoiGoalCardDto[] = rows.map((row) => {
        const goalId = text(row, "input_id");
        const harnessProjection = harnessByGoal.get(goalId);
        const status = goalStatus(row, harnessProjection);
        const total = number(row, "work_total");
        const active = number(row, "work_active");
        const activeRuns = number(row, "active_runs");
        const rawTitle = maskSecretText(text(row, "body")).replace(/\s+/gu, " ").trim();
        const title = rawTitle.length > 120 ? `${rawTitle.slice(0, 120)}…` : rawTitle;
        const blockedRecoveryExhausted = status === "FAILED" && row.outcome_disposition === "BLOCKED";
        const continuationDecision = status === "NEEDS_ATTENTION"
          && row.clarification_reason_code === "goal_continuation_required";
        const finalOutcome = number(row, "outcome_current") === 1
          && (harnessProjection?.mapStatus !== "ACTIVE" || blockedRecoveryExhausted || continuationDecision);
        const terminalStatus = ["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELED"].includes(status);
        const failureReasonCode = normalizeJoiFailureReasonCode(row.failure_reason_code);
        const artifacts = typeof row.workbench_id === "string" && (finalOutcome || (number(row, "result_revision") === 0 && text(row, "inbox_status") === "CONSUMED"))
          ? goalArtifacts(connection, goalId, row.workbench_id)
          : [];
        const base: JoiGoalCardBaseDto = {
          agentCount: number(row, "agent_count"),
          ...(artifacts.length === 0 ? {} : { artifacts }),
          workbench: {
            workbenchId: typeof row.workbench_id === "string" ? row.workbench_id : "",
            name: typeof row.workbench_name === "string" ? row.workbench_name : "等待归属",
          },
          canDelete: terminalStatus && (row.canceled_at !== null && row.canceled_at !== undefined
            || text(row, "inbox_status") === "CONSUMED" || finalOutcome)
            && active === 0 && activeRuns === 0
            && ((row.canceled_at !== null && row.canceled_at !== undefined) || total === 0 || finalOutcome),
          goalId,
          ...(status === "FAILED" && typeof row.failure_reason_code === "string" && typeof row.failure_count === "number" ? {
            failure: {
              attempts: row.failure_count,
              executionStarted: total > 0 || number(row, "agent_count") > 0,
              reasonCode: failureReasonCode,
              suggestedAction: suggestedActionForJoiInputFailure(failureReasonCode),
            },
          } : {}),
          ...(harnessProjection === undefined ? {} : { harness: toHarnessDto(harnessProjection) }),
          ...(finalOutcome && typeof row.completion_summary === "string"
            ? { completionSummary: stripPathRedactions(row.completion_summary) }
            : number(row, "result_revision") === 0 && text(row, "inbox_status") === "CONSUMED" && typeof row.turn_completion_summary === "string"
              ? { completionSummary: stripPathRedactions(row.turn_completion_summary) }
              : {}),
          ...(finalOutcome && typeof row.completed_at === "string"
            ? { completedAt: row.completed_at }
            : number(row, "result_revision") === 0 && text(row, "inbox_status") === "CONSUMED" && typeof row.turn_completed_at === "string"
              ? { completedAt: row.turn_completed_at }
              : {}),
          title: title === "" ? "未命名目标" : title,
          updatedAt: text(row, "projection_updated_at"),
          work: {
            active,
            completed: number(row, "completed_count"),
            failed: number(row, "failed_count"),
            failedResolved: resolvedFailures.get(goalId) ?? 0,
            total,
          },
        };
        if (status === "NEEDS_ATTENTION") {
          if (typeof row.clarification_reason_code !== "string") throw new Error("joi_home_feed_attention_invalid");
          return {
            ...base,
            clarification: {
              ...(typeof row.clarification_prompt === "string" ? { prompt: row.clarification_prompt } : {}),
              questionId: typeof row.question_id === "string" ? row.question_id : `legacy_question:${goalId}`,
              questionVersion: typeof row.question_version === "number" ? row.question_version : 1,
              reasonCode: row.clarification_reason_code,
            },
            status,
          };
        }
        return { ...base, status };
      });
      const goalsById = new Map(goals.map((goal) => [goal.goalId, goal]));
      const cutoff = new Date(now.getTime() - 15_000).toISOString();
       const turns = connection.prepare(`SELECT t.turn_id, t.input_id AS activity_input_id, COALESCE(i.goal_input_id, t.input_id) AS goal_id,
          t.status, t.created_at, t.updated_at
        FROM joi_turns t JOIN joi_inbox_messages i ON i.input_id = t.input_id
        WHERE (i.goal_input_id IS NOT NULL OR t.input_id NOT LIKE 'joi_result_input:%')
          AND (t.status IN ('PENDING','RUNNING','WAITING') OR t.updated_at >= ?)
        UNION ALL
         SELECT 'pending:' || i.input_id, i.input_id, COALESCE(i.goal_input_id, i.input_id), 'PENDING', i.updated_at, i.updated_at
          FROM joi_inbox_messages i
         WHERE i.status = 'PENDING'
           AND (i.goal_input_id IS NOT NULL OR (
             i.input_id NOT LIKE 'joi_result_input:%'
             AND i.input_id NOT LIKE 'joi_harness_review:%'
             AND i.input_id NOT LIKE 'joi_signal_input:%'
           ))
           AND NOT EXISTS (SELECT 1 FROM joi_turns t WHERE t.input_id = i.input_id
             AND t.status IN ('PENDING','RUNNING','WAITING'))
        ORDER BY 4 DESC, 1 DESC`).all(cutoff) as Row[];
      const thinking = collapseThinkingByGoal(turns.filter((row) => {
        if (text(row, "status") === "PENDING") return true;
        const goal = goalsById.get(text(row, "goal_id"));
        return goal === undefined || !["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELED"].includes(goal.status);
      }).map((row) => {
        const status = text(row, "status");
        const activityInputId = text(row, "activity_input_id");
        const review = activityInputId.startsWith("joi_harness_review:goal:");
        const queued = status === "PENDING" && !review;
        const active = review || queued || ["RUNNING", "WAITING"].includes(status);
        const updatedAt = text(row, "updated_at");
        const goalId = text(row, "goal_id");
        const goal = goalsById.get(goalId);
        const phase = queued ? "queued" as const : active ? "progressing" as const : "settled" as const;
        return {
          ...(active ? {} : { expiresAt: new Date(Date.parse(updatedAt) + 15_000).toISOString() }),
          agentCount: goal?.agentCount ?? 0,
          goalId,
          phase,
          stage: thinkingStage(goal, phase, activityInputId),
          startedAt: text(row, "created_at"),
          turnId: text(row, "turn_id"),
          work: goal?.work ?? { active: 0, completed: 0, failed: 0, failedResolved: 0, total: 0 },
        };
      }).filter((item) => item.phase === "queued" || item.phase === "progressing" || Date.parse(item.expiresAt ?? "") > now.getTime()));
      const unassignedActions = (connection.prepare(`SELECT i.input_id, i.workbench_id, i.status, i.clarification_reason_code,
        i.clarification_prompt, i.body, i.created_at, i.canceled_at, gate.question_id, gate.question_version
        FROM joi_inbox_messages i LEFT JOIN joi_goal_execution_gates gate ON gate.goal_input_id = i.input_id
        WHERE i.dismissed_at IS NULL AND i.workbench_id IS NULL AND i.status = 'CLARIFICATION_REQUIRED'
        ORDER BY i.created_at DESC, i.input_id DESC`).all() as Row[]).map((row) => ({
        acceptedAt: text(row, "created_at"),
        ...(typeof row.clarification_prompt === "string" ? { clarificationPrompt: row.clarification_prompt } : {}),
        ...(typeof row.clarification_reason_code === "string" ? { clarificationReasonCode: row.clarification_reason_code } : {}),
        inputId: text(row, "input_id"),
        questionId: typeof row.question_id === "string" ? row.question_id : `legacy_question:${text(row, "input_id")}`,
        questionVersion: typeof row.question_version === "number" ? row.question_version : 1,
        status: "CLARIFICATION_REQUIRED" as const,
        textPreview: maskSecretText(text(row, "body")).replace(/\s+/gu, " ").trim().slice(0, 81),
      }));
      return { goals, thinking, unassignedActions };
    });
  }
}
