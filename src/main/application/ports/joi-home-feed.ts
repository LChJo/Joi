import type { JoiGoalDetailDto, JoiGoalDetailPage, JoiHomeFeedDto } from "../../../shared/joi.js";
import type { GoalResultDto, GoalResultPage, GoalResultPageDto } from "../../../shared/goal-results.js";

export interface JoiHomeFeedRepository {
  load(now: Date): Promise<JoiHomeFeedDto>;
  loadGoalDetail(goalId: string, page: JoiGoalDetailPage): Promise<JoiGoalDetailDto | null>;
  listGoalResults?(goalId: string, page: GoalResultPage): Promise<GoalResultPageDto | null>;
  getGoalResult?(goalId: string, resultId: string): Promise<GoalResultDto | null>;
}
