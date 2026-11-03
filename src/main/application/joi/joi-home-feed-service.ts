import type { JoiGoalDetailDto, JoiGoalDetailPage, JoiHomeFeedDto } from "../../../shared/joi.js";
import type { GoalResultDto, GoalResultPage, GoalResultPageDto } from "../../../shared/goal-results.js";
import type { GoalArtifactPage, GoalArtifactPageDto } from "../../../shared/goal-artifacts.js";
import type { JoiHomeFeedRepository } from "../ports/joi-home-feed.js";
import type { Clock } from "../ports/runtime-store.js";
import { goalDetailPage } from "./goal-detail-page.js";

export class JoiHomeFeedService {
  constructor(private readonly dependencies: { clock: Clock; repository: JoiHomeFeedRepository }) {}

  load(): Promise<JoiHomeFeedDto> {
    return this.dependencies.repository.load(this.dependencies.clock.now());
  }

  loadGoalDetail(goalId: string, page: JoiGoalDetailPage = {}): Promise<JoiGoalDetailDto | null> {
    return this.dependencies.repository.loadGoalDetail(goalId, goalDetailPage(page));
  }

  listGoalResults(goalId: string, page: GoalResultPage = {}): Promise<GoalResultPageDto | null> {
    return this.dependencies.repository.listGoalResults?.(goalId, page) ?? Promise.resolve(null);
  }

  getGoalResult(goalId: string, resultId: string): Promise<GoalResultDto | null> {
    return this.dependencies.repository.getGoalResult?.(goalId, resultId) ?? Promise.resolve(null);
  }

  listGoalArtifacts(goalId: string, page: GoalArtifactPage = {}): Promise<GoalArtifactPageDto | null> {
    return this.dependencies.repository.listGoalArtifacts?.(goalId, page) ?? Promise.resolve(null);
  }
}
