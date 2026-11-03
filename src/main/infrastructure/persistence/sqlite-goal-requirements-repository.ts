/* SQLite is synchronous; the application port remains asynchronous. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import { GOAL_REQUIREMENTS_MAX_CHARS, type GoalRequirementsRepository } from "../../application/ports/goal-requirements.js";
import { mergeGoalRequirements, type GoalRequirements, type RequirementsUpdate } from "../../domain/work/goal-requirements.js";
import { DomainError } from "../../domain/errors.js";

import { appendGoalRequirementSource, loadGoalRequirements, assertGoalRequirementsReady } from "./sqlite-goal-requirements.js";
import { enqueueGoalResultSynthesis } from "./sqlite-goal-result-synthesis.js";
import { enqueueGoalRequirementsReview } from "./sqlite-goal-requirements-review.js";
import { renderGoalRequirements } from "../../domain/work/goal-requirements.js";
export { appendGoalRequirementSource, loadGoalRequirements, assertGoalRequirementsReady, goalRequirementsCurrentSql } from "./sqlite-goal-requirements.js";

interface TransactionalDatabase { transaction<T>(operation: (database: DatabaseSync) => T): T }

export class SqliteGoalRequirementsRepository implements GoalRequirementsRepository {
  constructor(private readonly database: TransactionalDatabase) {}

  async ensure(input: { goalInputId: string; workbenchId: string; executionPrompt?: string; executionKey?: string }): Promise<GoalRequirements> {
    return this.database.transaction(db => {
      const goal = db.prepare("SELECT body, workbench_id, automation_routine_id FROM joi_inbox_messages WHERE input_id = ?").get(input.goalInputId) as { body: string; workbench_id: string | null; automation_routine_id: string | null } | undefined;
      if (goal === undefined || (goal.workbench_id !== null && goal.workbench_id !== input.workbenchId)) throw new DomainError("goal_requirements_scope_invalid", "The goal is unavailable in this workbench.");
      // A goal can legitimately move between workbenches — archiving one asks the user to pick
      // another — so the contract follows the goal instead of pinning a workbench it has left,
      // which would fail every later turn before the model ever ran.
      db.prepare("UPDATE joi_goal_requirements SET workbench_id = ? WHERE goal_input_id = ? AND workbench_id <> ?")
        .run(input.workbenchId, input.goalInputId, input.workbenchId);
      const existing = loadGoalRequirements(db, input.goalInputId, input.workbenchId, input.executionKey);
      const source = db.prepare("SELECT 1 FROM joi_goal_requirement_sources WHERE goal_input_id = ? LIMIT 1").get(input.goalInputId);
      if (source === undefined) {
        if (goal.automation_routine_id !== null && input.executionPrompt === undefined) throw new DomainError("goal_requirements_routine_unavailable", "Load the actual Routine prompt first.");
        const routine = goal.automation_routine_id === null ? undefined : db.prepare("SELECT target_kind FROM joi_automations WHERE routine_id = ?").get(goal.automation_routine_id);
        if (routine?.target_kind === "GOAL_CONTINUATION") appendGoalRequirementSource(db, input.goalInputId, goal.body, "LEGACY");
        appendGoalRequirementSource(db, input.goalInputId, input.executionPrompt ?? goal.body, input.executionPrompt === undefined ? "LEGACY" : "ROUTINE", input.executionKey);
      }
      if (input.executionKey !== undefined && input.executionPrompt !== undefined) appendGoalRequirementSource(db, input.goalInputId, input.executionPrompt, "ROUTINE", input.executionKey);
      if (existing !== null) {
        const refreshed = loadGoalRequirements(db, input.goalInputId, input.workbenchId, input.executionKey);
        if (refreshed === null) throw new DomainError("goal_requirements_snapshot_missing", "The goal's requirements snapshot is missing.");
        return refreshed;
      }
      db.prepare("INSERT INTO joi_goal_requirements (goal_input_id, workbench_id) VALUES (?, ?)").run(input.goalInputId, input.workbenchId);
      db.prepare("INSERT INTO joi_goal_requirement_snapshots (goal_input_id, revision, requirements_json) VALUES (?, 0, '[]')").run(input.goalInputId);
      const saved = loadGoalRequirements(db, input.goalInputId, input.workbenchId, input.executionKey);
      if (saved === null) throw new DomainError("goal_requirements_snapshot_missing", "The goal's requirements snapshot is missing.");
      return saved;
    });
  }

  async load(goalInputId: string, workbenchId?: string): Promise<GoalRequirements | null> {
    return this.database.transaction(db => loadGoalRequirements(db, goalInputId, workbenchId));
  }

  async assertReady(goalInputId: string, expectedRevision?: number): Promise<GoalRequirements | null> {
    return this.database.transaction(db => assertGoalRequirementsReady(db, goalInputId, expectedRevision));
  }

  async checkpointTurn(goalInputId: string, turnId: string, expectedRevision: number): Promise<void> {
    this.database.transaction(db => {
      assertGoalRequirementsReady(db, goalInputId, expectedRevision);
      const updated = db.prepare(`UPDATE joi_turns SET requirements_revision = ? WHERE turn_id = ? AND status = 'RUNNING'
        AND EXISTS (SELECT 1 FROM joi_inbox_messages i WHERE i.input_id = joi_turns.input_id AND COALESCE(i.goal_input_id, i.input_id) = ?)`)
        .run(expectedRevision, turnId, goalInputId);
      if (updated.changes !== 1) throw new DomainError("goal_requirements_scope_invalid", "The running turn does not belong to this goal.");
    });
  }

  async readSource(input: { goalInputId: string; workbenchId: string; sourceRevision: number; offset: number }) {
    return this.database.transaction(db => {
      const contract = loadGoalRequirements(db, input.goalInputId, input.workbenchId);
      if (contract === null) throw new DomainError("goal_requirements_unavailable", "Initialize this goal before reading sources.");
      const row = db.prepare("SELECT body, read_offset FROM joi_goal_requirement_sources WHERE goal_input_id = ? AND source_revision = ?").get(input.goalInputId, input.sourceRevision) as { body: string; read_offset: number } | undefined;
      if (row === undefined || !Number.isInteger(input.offset) || input.offset < 0 || input.offset > row.body.length || input.offset > row.read_offset) {
        throw new DomainError("goal_requirements_source_invalid", "Read the source sequentially from offset zero.");
      }
      let next = Math.min(row.body.length, input.offset + 4000);
      // Never end a page between the halves of a surrogate pair: a lone surrogate reaches the model
      // as half a character it can neither read nor quote back, so the citation it returns for that
      // page fails to resolve against the source it was just shown.
      const lastCodeUnit = row.body.charCodeAt(next - 1);
      if (next < row.body.length && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) next -= 1;
      db.prepare("UPDATE joi_goal_requirement_sources SET read_offset = MAX(read_offset, ?) WHERE goal_input_id = ? AND source_revision = ?")
        .run(next, input.goalInputId, input.sourceRevision);
      return { text: row.body.slice(input.offset, next), sourceRevision: input.sourceRevision, totalChars: row.body.length,
        ...(next < row.body.length ? { nextOffset: next } : {}) };
    });
  }

  async update(input: RequirementsUpdate): Promise<GoalRequirements> {
    return this.database.transaction(db => {
      const current = loadGoalRequirements(db, input.goalInputId, input.workbenchId);
      if (current === null) throw new DomainError("goal_requirements_unavailable", "Initialize this goal first.");
      const requirements = mergeGoalRequirements(current, input);
      const unread = db.prepare("SELECT 1 FROM joi_goal_requirement_sources WHERE goal_input_id = ? AND source_revision > ? AND source_revision <= ? AND read_offset < body_chars LIMIT 1")
        .get(input.goalInputId, current.processedSourceRevision, input.processedSourceRevision);
      if (unread !== undefined) throw new DomainError("goal_requirements_sources_unread", "Read every page of all new user sources first.");
      for (const change of [...input.upserts, ...input.retirements]) {
        const { sourceRevision, start, end } = change.source;
        const source = db.prepare("SELECT body, read_offset FROM joi_goal_requirement_sources WHERE goal_input_id = ? AND source_revision = ?")
          .get(input.goalInputId, sourceRevision) as { body: string; read_offset: number } | undefined;
        if (source === undefined || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.body.length
          || end > source.read_offset || sourceRevision > current.sourceRevision) throw new DomainError("goal_requirements_source_invalid", "Cite a valid, read span in this goal's trusted user input.");
      }
      if (requirements.length === 0 && current.revision === 0) throw new DomainError("goal_requirements_invalid", "Record the user's objective or delivery requirements before acknowledging the input.");
      const encoded = JSON.stringify(requirements);
      if (renderGoalRequirements({ ...current, requirements }).length > GOAL_REQUIREMENTS_MAX_CHARS) throw new DomainError("goal_requirements_capacity_exceeded", "The current effective requirements exceed the protected context ceiling.");
      const changed = encoded !== JSON.stringify(current.requirements);
      const revision = current.revision + (changed ? 1 : 0);
      if (changed) db.prepare("INSERT INTO joi_goal_requirement_snapshots (goal_input_id, revision, requirements_json) VALUES (?, ?, ?)").run(input.goalInputId, revision, encoded);
      db.prepare("UPDATE joi_goal_requirements SET revision = ?, processed_source_revision = ? WHERE goal_input_id = ?").run(revision, input.processedSourceRevision, input.goalInputId);
      if (changed) {
        db.prepare("UPDATE joi_harness_maps SET reviewed_revision = 0, reviewed_requirements_revision = NULL, status = CASE WHEN status = 'CLEARED' THEN 'ACTIVE' ELSE status END, cleared_at = NULL, feedback_recorded_at = NULL, revision = revision + 1 WHERE goal_input_id = ?").run(input.goalInputId);
      }
      const saved = loadGoalRequirements(db, input.goalInputId, input.workbenchId);
      if (saved === null) throw new DomainError("goal_requirements_snapshot_missing", "The goal's requirements snapshot is missing.");
      if (saved.status === "READY") {
        const goal = db.prepare("SELECT updated_at FROM joi_inbox_messages WHERE input_id = ?").get(input.goalInputId);
        if (typeof goal?.updated_at !== "string") throw new DomainError("goal_requirements_goal_missing", "The goal's inbox row is missing.");
        enqueueGoalResultSynthesis(db, input.goalInputId, input.workbenchId, goal.updated_at);
        enqueueGoalRequirementsReview(db, saved, goal.updated_at);
      }
      return saved;
    });
  }

  async resolveSource(input: { goalInputId: string; workbenchId: string; sourceRevision: number; quote: string; start?: number }) {
    return this.database.transaction(db => {
      if (loadGoalRequirements(db, input.goalInputId, input.workbenchId) === null) throw new DomainError("goal_requirements_unavailable", "Initialize this goal first.");
      const row = db.prepare("SELECT body, read_offset FROM joi_goal_requirement_sources WHERE goal_input_id = ? AND source_revision = ?")
        .get(input.goalInputId, input.sourceRevision) as { body: string; read_offset: number } | undefined;
      if (row === undefined || input.quote.trim() === "" || input.quote.length > 1000) throw new DomainError("goal_requirements_source_invalid", "Cite a bounded exact quote from a trusted user source.");
      const start = input.start ?? row.body.indexOf(input.quote);
      const end = start + input.quote.length;
      if (start < 0 || !Number.isInteger(start) || end > row.read_offset || row.body.slice(start, end) !== input.quote
        || (input.start === undefined && row.body.includes(input.quote, start + 1))) {
        throw new DomainError("goal_requirements_source_invalid", "The quote must identify one read span; provide its start offset when it appears more than once.");
      }
      return { sourceRevision: input.sourceRevision, start, end };
    });
  }
}
