import type { AgentConversationPageDto, AvatarAgentCardDto } from "../../../shared/joi.js";
import type { NormalizedAgentConversationEntry } from "../partners/agent-conversation-presentation.js";

export interface AvatarAgentRepository {
  append(agentId: string, entries: NormalizedAgentConversationEntry[]): Promise<void>;
  conversation(input: { agentId: string; avatarId: string; cursor?: string; limit: number }): Promise<AgentConversationPageDto>;
  dismiss(input: { agentId: string; avatarId: string; dismissedAt: string }): Promise<void>;
  listAgents(input: { avatarId: string; cursor?: string; goalId?: string; limit: number }): Promise<{ items: AvatarAgentCardDto[]; nextCursor?: string }>;
}
