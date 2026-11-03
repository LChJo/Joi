import type { GoalRequirements, RequirementsUpdate, RequirementSource } from "../../domain/work/goal-requirements.js";

/**
 * The largest effective-requirements contract a supported route can carry in one request.
 *
 * A request pays for the fixed policy prompt, the requirements and the optional background out of
 * one window. A contract bigger than the slice the request can reserve would be accepted by the
 * write path and then fail on every turn, so both paths share this ceiling rather than each
 * holding its own — a contract that can be written is a contract that can run.
 */
export const GOAL_REQUIREMENTS_MAX_CHARS = 16_000;

export interface GoalRequirementsRepository {
  ensure(input: { goalInputId: string; workbenchId: string; executionPrompt?: string; executionKey?: string }): Promise<GoalRequirements>;
  load(goalInputId: string, workbenchId?: string): Promise<GoalRequirements | null>;
  readSource(input: { goalInputId: string; workbenchId: string; sourceRevision: number; offset: number }): Promise<{ text: string; sourceRevision: number; nextOffset?: number; totalChars: number }>;
  resolveSource(input: { goalInputId: string; workbenchId: string; sourceRevision: number; quote: string; start?: number }): Promise<RequirementSource>;
  update(input: RequirementsUpdate): Promise<GoalRequirements>;
  assertReady(goalInputId: string, expectedRevision?: number): Promise<GoalRequirements | null>;
  checkpointTurn(goalInputId: string, turnId: string, expectedRevision: number): Promise<void>;
}
