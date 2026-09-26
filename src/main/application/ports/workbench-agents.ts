import type { AgentConversationPageDto, WorkbenchAgentCardDto, WorkbenchToolTraceDto } from "../../../shared/joi.js";
import type { NormalizedAgentConversationEntry } from "../partners/agent-conversation-presentation.js";
import type { ToolTraceDraft } from "../partners/tool-trace-presentation.js";
import type { ResolvedWorkbenchArtifact, WorkbenchArtifactResolutionInput } from "./workbench-artifacts.js";

export interface WorkbenchToolTraceInput {
  agentId: string;
  createdAt: string;
  runId: string;
  trace: ToolTraceDraft;
}

export interface WorkbenchToolTraceRevealInput {
  agentId: string;
  toolCallId: string;
  workbenchId: string;
}

export interface WorkbenchAgentRepository {
  append(agentId: string, entries: NormalizedAgentConversationEntry[]): Promise<void>;
  /**
   * Appends one completed tool call's private body. Deliberately append-only and separate
   * from `replaceRun`: the live display snapshot rewrites the whole run every 500 ms, and a
   * multi-kilobyte body must never ride along with that amplification.
   */
  appendToolTrace(input: WorkbenchToolTraceInput): Promise<void>;
  conversation(input: { agentId: string; workbenchId: string; goalId?: string; cursor?: string; latest?: boolean; limit: number }): Promise<AgentConversationPageDto>;
  dismiss(input: { agentId: string; workbenchId: string; dismissedAt: string }): Promise<void>;
  listAgents(input: { workbenchId: string; cursor?: string; goalId?: string; limit: number }): Promise<{ items: WorkbenchAgentCardDto[]; nextCursor?: string }>;
  resolveArtifact(input: WorkbenchArtifactResolutionInput): Promise<ResolvedWorkbenchArtifact>;
  /** Reads one tool call's private body on demand; the caller is responsible for the desktop gate. */
  revealToolTrace(input: WorkbenchToolTraceRevealInput): Promise<WorkbenchToolTraceDto>;
  /** Replaces the non-authoritative display snapshot for one run without touching audit/result facts. */
  replaceRun(agentId: string, runId: string, entries: NormalizedAgentConversationEntry[]): Promise<void>;
}
