import type { ConversationConfigDto, ConversationDto, ConversationSummaryDto, ConversationTurnDto, ConversationState,ConversationHistoryPageDto,ConversationEventsDto,ConversationContextDto } from "../../../shared/conversations.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerSessionState } from "./partner-instances.js";
import type { PartnerRunRequest } from "./partner-execution.js";

export interface ConversationSubmission {
  conversationId: string; workbenchId: string; turnId: string; requestId: string;
  text: string; at: string; config: ConversationConfigDto; revision?: PartnerRevision;
}
export interface ConversationStore {
  history(id: string, beforeTurnId: string): Promise<NonNullable<PartnerRunRequest["conversationHistory"]>>;
  page(id: string,cursor?: string,limit?: number): Promise<ConversationHistoryPageDto>;
  events(id: string,cursor?: string): Promise<ConversationEventsDto>;
  context(id: string,turnId: string,context: ConversationContextDto): Promise<void>;
  session(id: string): Promise<PartnerSessionState | undefined>;
  saveSession(id: string, turnId: string, state: PartnerSessionState, at: string): Promise<void>;
  submit(input: ConversationSubmission): Promise<ConversationDto>;
  list(archived?: boolean): Promise<{ items: ConversationSummaryDto[] }>;
  setState(id: string, state: ConversationState, at: string): Promise<void>;
  get(id: string): Promise<ConversationDto | null>;
  request(id: string): Promise<{ conversation: ConversationDto; turn: ConversationTurnDto; text: string } | null>;
  turn(id: string): Promise<{ conversation: ConversationDto; turn: ConversationTurnDto; text: string; revision: PartnerRevision | null } | null>;
  begin(turnId: string): Promise<boolean>;
  update(turnId: string, patch: Pick<ConversationTurnDto, "entries" | "artifacts" | "status"> & { errorCode?: string }): Promise<void>;
  stop(conversationId: string): Promise<void>;
  stopAll(): Promise<void>;
  recoverInterrupted(at: string): Promise<void>;
}
