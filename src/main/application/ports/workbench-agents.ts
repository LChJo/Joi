import type { AgentConversationPageDto, WorkbenchAgentCardDto } from "../../../shared/joi.js";
import type { NormalizedAgentConversationEntry } from "../partners/agent-conversation-presentation.js";

export interface WorkbenchAgentRepository {
  append(agentId: string, entries: NormalizedAgentConversationEntry[]): Promise<void>;
  conversation(input: { agentId: string; workbenchId: string; cursor?: string; limit: number }): Promise<AgentConversationPageDto>;
  dismiss(input: { agentId: string; workbenchId: string; dismissedAt: string }): Promise<void>;
  listAgents(input: { workbenchId: string; cursor?: string; goalId?: string; limit: number }): Promise<{ items: WorkbenchAgentCardDto[]; nextCursor?: string }>;
}
