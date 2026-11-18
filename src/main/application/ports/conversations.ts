import type { ConversationConfigDto, ConversationDto, ConversationSummaryDto, ConversationTurnDto, ConversationState,ConversationHistoryPageDto,ConversationEventsDto,ConversationContextDto } from "../../../shared/conversations.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerSessionState } from "./partner-instances.js";
import type { PartnerRunRequest } from "./partner-execution.js";

export interface ConversationSegment {
  segmentId: string; partnerId: string; engine: PartnerRevision["engine"]; capabilityKey: string;
  predecessorId?: string; state?: PartnerSessionState;
}
export interface ConversationHandoffPort {
  build(input: { conversationId: string; workbenchId: string; source: ConversationSegment; history: NonNullable<PartnerRunRequest["conversationHistory"]>;
    fork?: { turnId: string; messageCount?: number; inherited?: PartnerSessionState } }): Promise<PartnerSessionState>;
  read(input: { conversationId: string; workbenchId: string; segments: ConversationSegment[] }): Promise<unknown[]>;
}

export interface ConversationForkIdentity { sourceId: string; turnId: string; targetId: string; }
export interface ConversationForkSource {
  workbenchId: string; title: string; segment: ConversationSegment;
  history: NonNullable<PartnerRunRequest["conversationHistory"]>; messageCount?: number; inherited?: PartnerSessionState;
}

export interface ConversationSubmission {
  conversationId: string; workbenchId: string; turnId: string; requestId: string;
  text: string; at: string; config: ConversationConfigDto; revision?: PartnerRevision;
}
export interface ConversationStore {
  existingFork(input: ConversationForkIdentity): Promise<ConversationDto | null>;
  forkSource(sourceId: string,turnId: string): Promise<ConversationForkSource>;
  createFork(input: ConversationForkIdentity & { title: string; at: string; state: PartnerSessionState }): Promise<ConversationDto>;
  forkSeed(id: string): Promise<PartnerSessionState | undefined>;
  segment(id: string,turnId?: string): Promise<ConversationSegment | undefined>;
  segments(id: string): Promise<ConversationSegment[]>;
  activateSegment(id: string,turnId: string,segment: ConversationSegment,expectedPredecessor?: string): Promise<ConversationSegment>;
  history(id: string, beforeTurnId: string): Promise<NonNullable<PartnerRunRequest["conversationHistory"]>>;
  page(id: string,cursor?: string,limit?: number): Promise<ConversationHistoryPageDto>;
  events(id: string,cursor?: string): Promise<ConversationEventsDto>;
  context(id: string,turnId: string,context: ConversationContextDto): Promise<void>;
  session(id: string): Promise<PartnerSessionState | undefined>;
  saveSession(id: string, turnId: string, state: PartnerSessionState, at: string): Promise<void>;
  submit(input: ConversationSubmission): Promise<ConversationDto>;
  list(archived?: boolean): Promise<{ items: ConversationSummaryDto[] }>;
  rename(id: string,title: string,at: string): Promise<ConversationSummaryDto>;
  setState(id: string, state: ConversationState, at: string): Promise<void>;
  get(id: string): Promise<ConversationDto | null>;
  request(id: string): Promise<{ conversation: ConversationDto; turn: ConversationTurnDto; text: string } | null>;
  turn(id: string): Promise<{ conversation: ConversationDto; turn: ConversationTurnDto; text: string; revision: PartnerRevision | null } | null>;
  begin(turnId: string): Promise<boolean>;
  runningPiTurns(): Promise<string[]>;
  update(turnId: string, patch: Pick<ConversationTurnDto, "entries" | "artifacts" | "status"> & Pick<ConversationTurnDto,"errorCode" | "failure">): Promise<void>;
  stop(conversationId: string): Promise<void>;
  stopAll(): Promise<void>;
  recoverInterrupted(at: string): Promise<void>;
}
