import type { JoiGoalDetailDto, JoiGoalDetailPage, JoiHomeFeedDto } from "../../../shared/joi.js";

export interface JoiHomeFeedRepository {
  load(now: Date): Promise<JoiHomeFeedDto>;
  loadGoalDetail(goalId: string, page: JoiGoalDetailPage): Promise<JoiGoalDetailDto | null>;
}
