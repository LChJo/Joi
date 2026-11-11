import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { ModelSourceTurnPin } from "../../domain/model-sources/model-source.js";
import type { PartnerRunRequest } from "./partner-execution.js";
import type { PartnerSessionState } from "./partner-instances.js";

export interface ConversationChildInput {
  parentTurnId: string;callId: string;task: string;revision: PartnerRevision;request: PartnerRunRequest;sourcePin: ModelSourceTurnPin;
}
export interface ConversationChild extends ConversationChildInput {
  childId: string;status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELED" | "INTERRUPTED";body?: string;
}
export interface ConversationSubagentStore {
  checkpoint(id: string,state: PartnerSessionState): Promise<void>;
  enqueue(input: ConversationChildInput & { childId: string;at: string }): Promise<ConversationChild>;
  get(id: string): Promise<ConversationChild | null>;
  list(parentTurnId: string): Promise<ConversationChild[]>;
  claim(id: string): Promise<boolean>;
  finish(id: string,status: ConversationChild["status"],body?: string): Promise<void>;
  cancel(parentTurnId: string,id?: string): Promise<void>;
  recover(): Promise<void>;
}
export interface ConversationSubagentPort {
  start(input: ConversationChildInput): Promise<ConversationChild>;
  list(parentTurnId: string): Promise<ConversationChild[]>;
  cancel(parentTurnId: string,id?: string): Promise<void>;
  settle(parentTurnId: string): Promise<ConversationChild[]>;
}
