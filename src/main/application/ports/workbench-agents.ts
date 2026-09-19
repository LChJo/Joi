import type { AgentConversationPageDto, WorkbenchAgentCardDto } from "../../../shared/joi.js";
import type { NormalizedAgentConversationEntry } from "../partners/agent-conversation-presentation.js";
import type { ResolvedWorkbenchArtifact, WorkbenchArtifactResolutionInput } from "./workbench-artifacts.js";

export interface WorkbenchAgentRepository {
  append(agentId: string, entries: NormalizedAgentConversationEntry[]): Promise<void>;
  conversation(input: { agentId: string; workbenchId: string; goalId?: string; cursor?: string; latest?: boolean; limit: number }): Promise<AgentConversationPageDto>;
  dismiss(input: { agentId: string; workbenchId: string; dismissedAt: string }): Promise<void>;
  listAgents(input: { workbenchId: string; cursor?: string; goalId?: string; limit: number }): Promise<{ items: WorkbenchAgentCardDto[]; nextCursor?: string }>;
  resolveArtifact(input: WorkbenchArtifactResolutionInput): Promise<ResolvedWorkbenchArtifact>;
  /** Replaces the non-authoritative display snapshot for one run without touching audit/result facts. */
  replaceRun(agentId: string, runId: string, entries: NormalizedAgentConversationEntry[]): Promise<void>;
}
