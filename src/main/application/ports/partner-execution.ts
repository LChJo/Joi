import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { AgentConversationDraft } from "../partners/agent-conversation-presentation.js";
import type { WorkHandoff, WorkHandoffStatus } from "../../domain/work/work-handoff.js";
import type { ConversationPiExtension,ConversationTurnDto } from "../../../shared/conversations.js";

export type PartnerRunStatus = "COMPLETED" | "FAILED" | "WAITING_INPUT" | "WAITING_AUTH" | "UNKNOWN";

export interface PartnerRunRequest {
  conversationAttachmentContext?: string;
  subagentChild?: boolean;
  subagentsEnabled?: boolean;
  piExtensions?: ConversationPiExtension[];
  conversationId?: string;
  /** Legacy private import; incomplete tool bodies are identified explicitly by adapters. */
  conversationHistory?: Pick<ConversationTurnDto, "turnId" | "text" | "entries" | "status" | "config">[];
  workspaceExecution?: { accessCeiling: "READ" | "WRITE"; generation: number; phase: "READ_RUNNING" | "WRITE_RUNNING" };
  actionId: string;
  workbenchId: string;
  contextSnapshotId: string;
  taskProjection: string;
  /** Immutable mandatory goal requirements, kept outside trimmable evidence. */
  requiredContext?: string;
  workId: string;
}

export interface PartnerRunOutput {
  handoff?: WorkHandoff;
  handoffStatus?: WorkHandoffStatus;
  artifacts: { artifactRef?: string; mimeType?: string; name: string; size: number }[];
  body: string;
  /** Blocking question the partner asked the user; present together with status WAITING_INPUT. */
  pendingQuestion?: string;
}

export interface PartnerRunResult {
  handoff?: WorkHandoff;
  handoffStatus?: WorkHandoffStatus;
  checkpointRef?: string;
  actionId: string;
  artifacts: PartnerRunOutput["artifacts"];
  body: string;
  conversation?: AgentConversationDraft[];
  externalRunId: string;
  instanceId?: string;
  pendingQuestion?: string;
  status: PartnerRunStatus | "SUSPENDED";
  workId: string;
}

export interface PartnerExecutor {
  run(request: PartnerRunRequest, revision: PartnerRevision): Promise<PartnerRunResult>;
}

export interface PartnerAdapterRunner {
  run(request: PartnerRunRequest, revision: PartnerRevision): Promise<{ externalRunId: string; output: PartnerRunOutput; status: PartnerRunStatus }>;
}

export interface PartnerPromptStore {
  read(promptRef: string): Promise<string | null>;
  save(input: { body: string; createdAt: string; promptRef: string }): Promise<void>;
}
