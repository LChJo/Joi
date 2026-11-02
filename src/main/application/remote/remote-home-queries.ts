import type { RemoteHomeQueries } from "./remote-command-service.js";
import type { JoiHomeFeedService } from "../joi/joi-home-feed-service.js";
import type { WorkbenchAgentService } from "../partners/workbench-agent-service.js";
import type { WorkbenchCatalog } from "../ports/workbench-context.js";
import type { PartnerRegistryService } from "../partners/partner-registry-service.js";
import { DomainError } from "../../domain/errors.js";

export class RemoteHomeQueryService implements RemoteHomeQueries {
  constructor(private readonly dependencies: {
    homeFeed: Pick<JoiHomeFeedService, "load"> & Partial<Pick<JoiHomeFeedService, "listGoalResults" | "getGoalResult">>;
    inputs: { readDisplayText(inputId: string): Promise<string | null> };
    agents: Pick<WorkbenchAgentService, "list" | "conversation">;
    workbenches: Pick<WorkbenchCatalog, "listSummaries">;
    partners: Pick<PartnerRegistryService, "list">;
  }) {}

  async catalog() {
    const [workbenches, partners] = await Promise.all([this.dependencies.workbenches.listSummaries(), this.dependencies.partners.list()]);
    return { workbenches, partners: partners.filter((p) => p.status === "ACTIVE" && p.configuration === undefined)
      .map((p) => ({ partnerId: p.partnerId, displayName: p.displayName })) };
  }

  async goal(goalId: string) {
    const feed = await this.dependencies.homeFeed.load();
    const goal = feed.goals.find((g) => g.goalId === goalId);
    const action = feed.unassignedActions.find((a) => a.inputId === goalId);
    if (goal === undefined && action === undefined) throw new DomainError("remote_goal_unavailable", "Goal is unavailable.");
    const text = await this.dependencies.inputs.readDisplayText(goalId);
    if (text === null) throw new DomainError("remote_goal_unavailable", "Goal is unavailable.");
    return { ...(goal === undefined ? {} : { goal }), ...(action === undefined ? {} : { action }), text };
  }

  async agents(goalId: string, cursor?: string) {
    const { goal } = await this.goal(goalId);
    if (goal === undefined || goal.workbench.workbenchId === "") return { items: [] };
    return this.dependencies.agents.list({ goalId, workbenchId: goal.workbench.workbenchId, limit: 25, ...(cursor === undefined ? {} : { cursor }) });
  }

  async results(goalId: string, cursor?: string) {
    const page = await this.dependencies.homeFeed.listGoalResults?.(goalId, cursor === undefined ? {} : { cursor });
    if (page == null) throw new DomainError("remote_goal_unavailable", "Goal is unavailable.");
    return page;
  }

  async result(goalId: string, resultId: string) {
    const result = await this.dependencies.homeFeed.getGoalResult?.(goalId, resultId);
    if (result == null) throw new DomainError("remote_goal_unavailable", "Goal is unavailable.");
    return result;
  }

  async conversation(goalId: string, agentId: string, cursor?: string) {
    const { goal } = await this.goal(goalId);
    if (goal === undefined || goal.workbench.workbenchId === "") throw new DomainError("remote_goal_unavailable", "Goal is unavailable.");
    return this.dependencies.agents.conversation({ agentId, goalId, workbenchId: goal.workbench.workbenchId, limit: 20, ...(cursor === undefined ? {} : { cursor }) });
  }
}
