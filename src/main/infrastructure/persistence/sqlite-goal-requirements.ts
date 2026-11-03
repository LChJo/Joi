import type { DatabaseSync } from "node:sqlite";
import { assertCurrentRequirements, type GoalRequirement, type GoalRequirements } from "../../domain/work/goal-requirements.js";
import { DomainError } from "../../domain/errors.js";

export function appendGoalRequirementSource(db: DatabaseSync, goalInputId: string, text: string, kind: "USER" | "LEGACY" | "ROUTINE" = "USER", sourceKey?: string): void {
  db.prepare(`INSERT OR IGNORE INTO joi_goal_requirement_sources (goal_input_id, source_revision, kind, body, body_chars, source_key)
    SELECT ?, COALESCE(MAX(source_revision), 0) + 1, ?, ?, ?, ? FROM joi_goal_requirement_sources WHERE goal_input_id = ?`)
    .run(goalInputId, kind, text, text.length, sourceKey ?? null, goalInputId);
}

export function loadGoalRequirements(db: DatabaseSync, goalInputId: string, workbenchId?: string, executionKey?: string): GoalRequirements | null {
  const row = db.prepare(`SELECT g.*, COALESCE((SELECT MAX(source_revision) FROM joi_goal_requirement_sources s WHERE s.goal_input_id = g.goal_input_id), 0) AS source_revision,
    snap.requirements_json FROM joi_goal_requirements g JOIN joi_goal_requirement_snapshots snap
    ON snap.goal_input_id = g.goal_input_id AND snap.revision = g.revision WHERE g.goal_input_id = ?`).get(goalInputId) as {
    workbench_id: string; revision: number; processed_source_revision: number; source_revision: number; requirements_json: string;
  } | undefined;
  if (row === undefined) return null;
  if (workbenchId !== undefined && row.workbench_id !== workbenchId) throw new DomainError("goal_requirements_scope_invalid", "The requirements belong to another workbench.");
  // A scheduled Routine freezes the prompt it actually ran under, keyed by execution. Returning the
  // newest one instead would run an earlier execution under instructions it was never scheduled
  // with, so only the execution asking for it gets a prompt back.
  const routine = executionKey === undefined ? undefined
    : db.prepare("SELECT body FROM joi_goal_requirement_sources WHERE goal_input_id = ? AND kind = 'ROUTINE' AND source_key = ? ORDER BY source_revision DESC LIMIT 1").get(goalInputId, executionKey);
  const next = db.prepare("SELECT source_revision, read_offset, body_chars FROM joi_goal_requirement_sources WHERE goal_input_id = ? AND source_revision > ? AND read_offset < body_chars ORDER BY source_revision LIMIT 1")
    .get(goalInputId, row.processed_source_revision);
  return { goalInputId, workbenchId: row.workbench_id, revision: row.revision, sourceRevision: row.source_revision,
    ...(next === undefined ? {} : { nextUnreadSource: { sourceRevision: Number(next.source_revision), offset: Number(next.read_offset), totalChars: Number(next.body_chars) } }),
    ...(typeof routine?.body === "string" ? { executionPrompt: routine.body } : {}),
    processedSourceRevision: row.processed_source_revision, status: row.source_revision === row.processed_source_revision ? "READY" : "DIRTY",
    requirements: JSON.parse(row.requirements_json) as GoalRequirement[] };
}

export function assertGoalRequirementsReady(db: DatabaseSync, goalInputId: string, expectedRevision?: number): GoalRequirements | null {
  const contract = loadGoalRequirements(db, goalInputId);
  if (contract === null) return null;
  assertCurrentRequirements(contract, expectedRevision);
  return contract;
}

export function goalRequirementsCurrentSql(goalExpression: string, revisionExpression: string): string {
  return `NOT EXISTS (SELECT 1 FROM joi_goal_requirements gr WHERE gr.goal_input_id = ${goalExpression}
    AND (COALESCE(${revisionExpression}, -1) <> gr.revision OR gr.processed_source_revision <
      (SELECT COALESCE(MAX(gs.source_revision), 0) FROM joi_goal_requirement_sources gs WHERE gs.goal_input_id = gr.goal_input_id)))`;
}

