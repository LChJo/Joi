import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { AgentConversationDraft } from "../partners/agent-conversation-presentation.js";

export type PartnerRunStatus = "COMPLETED" | "FAILED" | "WAITING_INPUT" | "WAITING_AUTH" | "UNKNOWN";

export interface PartnerRunRequest {
  actionId: string;
  workbenchId: string;
  contextSnapshotId: string;
  taskProjection: string;
  workId: string;
}

export interface PartnerRunOutput {
  artifacts: { artifactRef?: string; mimeType?: string; name: string; size: number }[];
  body: string;
}

export interface PartnerRunResult {
  actionId: string;
  artifacts: PartnerRunOutput["artifacts"];
  body: string;
  conversation?: AgentConversationDraft[];
  externalRunId: string;
  instanceId?: string;
  status: PartnerRunStatus;
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
