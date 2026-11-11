import type { AgentConversationEntryDto } from "./joi.js";

export interface ConversationConfigDto {
  subagentsEnabled?: boolean;
  partnerId: string;
  partnerName: string;
  networkId: string;
  networkName: string;
  modelName: string;
  sourceRevisionId?: string;
  modelRevisionId?: string;
  skills: string[];
  attachmentIds: string[];
}
export type ConversationTurnStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "STOPPED" | "INTERRUPTED";
export interface ConversationThinkingDto {
  phaseId: string;
  state: "STARTED" | "COMPLETED" | "INTERRUPTED";
  startedAt?: string;
  durationMs?: number;
  /** Only a provider's explicitly public summary; never raw reasoning or signatures. */
  summary?: string;
  summaryTruncated?: boolean;
}
export type ConversationActivityDto = { type: "CONTEXT";context: ConversationContextDto } | { type: "THINKING";thinking: ConversationThinkingDto };
export interface ConversationActivityEntryDto extends Omit<AgentConversationEntryDto,"kind"> {
  kind: "ACTIVITY";
  role: "SYSTEM";
  activity: ConversationActivityDto;
}
export type ConversationEntryDto = AgentConversationEntryDto | ConversationActivityEntryDto;
export interface ConversationTurnDto {
  turnId: string;
  text: string;
  createdAt: string;
  status: ConversationTurnStatus;
  config: ConversationConfigDto;
  entries: ConversationEntryDto[];
  artifacts: { name: string; size: number; mimeType?: string }[];
  errorCode?: string;
}
export interface ConversationSummaryDto {
  conversationId: string;
  workbenchId: string;
  title: string;
  updatedAt: string;
  archivedAt?: string;
  canArchive?: boolean;
}
export type ConversationState = "ACTIVE" | "ARCHIVED" | "DELETED";
export interface ConversationContextDto {
  kind: "CHARACTERS" | "NATIVE";
  state: "READY" | "COMPACTING" | "COMPRESSED" | "BACKOFF" | "TRIMMED" | "CAPACITY";
  requestChars?: number;
  budgetChars?: number;
  compactions?: number;
  savedChars?: number;
  missingHistory?: boolean;
  activityAt?: string;
}
export interface ConversationDto extends ConversationSummaryDto {
  turns: ConversationTurnDto[];historyCursor?: string;eventCursor?: string;context?: ConversationContextDto;
  children?: { childId: string;status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "INTERRUPTED" }[];
}
export interface ConversationHistoryPageDto { items: ConversationTurnDto[];nextCursor: string | null; }
export interface ConversationEventsDto { items: { sequence: number;turnId: string | null }[];cursor: string;hasMore: boolean; }
export interface SendConversationInput {
  subagentsEnabled?: boolean;
  conversationId: string;
  workbenchId: string;
  text: string;
  partnerId: string;
  networkId: string;
  skills: string[];
  attachmentIds: string[];
  requestId: string;
}
export interface GitFileDto { path: string; index: string; workingTree: string; }
export interface GitWorkspaceDto {
  available: boolean;
  reasonCode?: string;
  branch: string;
  branches: string[];
  ahead: number;
  behind: number;
  files: GitFileDto[];
  history: { hash: string; message: string; date: string }[];
}
export type GitAction = "STAGE" | "UNSTAGE" | "COMMIT" | "SWITCH" | "BRANCH" | "FETCH" | "PULL" | "PUSH";
export interface GitCommandInput { action: GitAction; paths?: string[]; message?: string; branch?: string; requestId: string; }
export interface GitCommandDto { commandId: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED"; errorCode?: string; }
export interface ConversationInheritanceDto { memoryCount: number; evolutionRevisionId: string | null; }
