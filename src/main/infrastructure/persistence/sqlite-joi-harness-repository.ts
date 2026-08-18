/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  HarnessDecisionKind,
  HarnessFeedbackTarget,
  HarnessGoalProjection,
  HarnessGoalSeed,
  HarnessMapStatus,
  HarnessPathStatus,
  HarnessReviewDigest,
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

/**
 * Bounded per-goal harness projection. Exported so the home-feed repository can run
 * it inside its own transaction instead of nesting transactions.
 */
export function queryHarnessGoalProjections(connection: DatabaseSync): HarnessGoalProjection[] {
  const maps = connection.prepare(`
    SELECT m.goal_input_id, m.destination, m.status, m.revision,
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
               o.completion_summary
          FROM joi_harness_maps m
          JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
          JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
          JOIN joi_inbox_messages g ON g.input_id = m.goal_input_id
         WHERE m.status = 'ACTIVE'
           AND rs.revision > m.reviewed_revision
           AND rs.synthesized_revision = rs.revision
           AND g.canceled_at IS NULL AND g.dismissed_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM work_items w
                            WHERE w.input_id = m.goal_input_id
                              AND w.status NOT IN ('COMPLETED', 'FAILED', 'CANCELED'))
         ORDER BY m.updated_at, m.goal_input_id LIMIT 10`).all() as Row[];
      return candidates.map((row): HarnessReviewDigest => {
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
      });
    });
  }

  async listFeedbackTargets(): Promise<HarnessFeedbackTarget[]> {
    return (this.database.transaction((connection) => connection.prepare(`
      SELECT m.goal_input_id, m.workbench_id, m.destination,
             COALESCE((SELECT o.completion_summary FROM joi_goal_outcomes o
                        WHERE o.input_id = m.goal_input_id
                        ORDER BY o.result_revision DESC LIMIT 1), '') AS completion_summary
        FROM joi_harness_maps m
       WHERE m.status = 'CLEARED' AND m.feedback_recorded_at IS NULL
       ORDER BY m.cleared_at, m.goal_input_id LIMIT 10`).all()) as Row[])
      .map((row) => ({
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

  async enqueueReview(input: { digest: HarnessReviewDigest; now: string }): Promise<string | null> {
    return this.database.transaction((connection) => {
      const { digest, now } = input;
      const gate = connection.prepare(`
        SELECT rs.revision AS result_revision
          FROM joi_harness_maps m
          JOIN joi_goal_result_sets rs ON rs.original_input_id = m.goal_input_id
          JOIN joi_goal_outcomes o ON o.input_id = m.goal_input_id AND o.result_revision = rs.revision
         WHERE m.goal_input_id = ? AND m.status = 'ACTIVE'
           AND rs.revision > m.reviewed_revision
           AND rs.synthesized_revision = rs.revision`).get(digest.goalInputId) as Row | undefined;
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
        UPDATE joi_harness_maps
           SET status = 'CLEARED', cleared_at = ?, revision = revision + 1, updated_at = ?
         WHERE goal_input_id = ? AND status = 'ACTIVE'`)
        .run(now, now, input.goalInputId).changes > 0;
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
