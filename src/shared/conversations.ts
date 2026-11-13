import type { AgentConversationEntryDto } from "./joi.js";

export const CONVERSATION_TITLE_MAX_LENGTH = 80;

export const CONVERSATION_PI_EXTENSIONS = ["agent-browser","cc-safety-net"] as const;
export type ConversationPiExtension = typeof CONVERSATION_PI_EXTENSIONS[number];
export function currentConversationPiExtensions(value: unknown): ConversationPiExtension[] {
  return CONVERSATION_PI_EXTENSIONS.filter(id => Array.isArray(value) && value.includes(id));
}
export function isConversationPiExtensions(value: unknown): value is ConversationPiExtension[] {
  return Array.isArray(value) && value.length <= CONVERSATION_PI_EXTENSIONS.length
    && value.every(id => CONVERSATION_PI_EXTENSIONS.includes(id as ConversationPiExtension)) && new Set(value).size === value.length;
}

export interface ConversationConfigDto {
  subagentsEnabled?: boolean;
  piExtensions?: ConversationPiExtension[];
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
export interface ConversationUpdateDto {
  conversationId: string;
  turn: ConversationTurnDto;
  context?: ConversationContextDto;
}
export interface ConversationHistoryPageDto { items: ConversationTurnDto[];nextCursor: string | null; }
export interface ConversationEventsDto { items: { sequence: number;turnId: string | null }[];cursor: string;hasMore: boolean; }
export interface SendConversationInput {
  subagentsEnabled?: boolean;
  piExtensions?: ConversationPiExtension[];
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
