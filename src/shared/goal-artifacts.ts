import type { WorkbenchArtifactDto } from "./joi.js";

export const GOAL_ARTIFACT_PREVIEW_LIMIT = 20;

export interface GoalArtifactPage {
  cursor?: string;
  limit?: number;
}

export interface GoalArtifactPageDto {
  items: WorkbenchArtifactDto[];
  nextCursor?: string;
}
