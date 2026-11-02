export interface GoalResultSummaryDto {
  resultId: string;
  completedAt: string;
  status: "COMPLETED" | "COMPLETED_WITH_GAPS";
}

export interface GoalResultDto extends GoalResultSummaryDto {
  goalId: string;
  body: string;
}

export interface GoalResultPageDto {
  items: GoalResultSummaryDto[];
  nextCursor?: string;
}

export interface GoalResultPage {
  cursor?: string;
  limit?: number;
}
