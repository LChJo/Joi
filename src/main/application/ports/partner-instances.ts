import type { PartnerEngine, PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerRunOutput, PartnerRunRequest, PartnerRunStatus } from "./partner-execution.js";
import type { AgentConversationDraft } from "../partners/agent-conversation-presentation.js";

export type SessionPolicy = "EPHEMERAL" | "RESIDENT";
export type PartnerInstanceStatus = "BUSY" | "DISPOSED" | "IDLE";

export interface PartnerInstanceRecord {
  workbenchId: string;
  createdAt: string;
  disposedAt?: string;
  disposalReason?: string;
  engine: PartnerEngine;
  externalSessionRef?: string;
  instanceId: string;
  lastUsedAt: string;
  partnerId: string;
  partnerRevisionId: string;
  sessionPolicy: SessionPolicy;
  status: PartnerInstanceStatus;
}

export interface PartnerInstanceRepository {
  countActive(workbenchId: string, partnerId: string): Promise<number>;
  countActiveGlobal(): Promise<number>;
  create(input: { workbenchId: string; createdAt: string; engine: PartnerEngine; instanceId: string; partnerId: string; partnerRevisionId: string; sessionPolicy: SessionPolicy }): Promise<PartnerInstanceRecord>;
  get(instanceId: string): Promise<PartnerInstanceRecord | null>;
  linkDispatch(dispatchAttemptId: string, instanceId: string): Promise<void>;
  listActive(filter?: { workbenchId?: string; partnerId?: string }): Promise<PartnerInstanceRecord[]>;
  markDisposed(instanceId: string, reason: string, at: string): Promise<void>;
  markTurnComplete(instanceId: string, at: string, externalSessionRef?: string): Promise<void>;
  recoverCrashed(at: string): Promise<{ ephemeralDisposed: number; residentRecovered: number }>;
  setStatusBusy(instanceId: string, at: string): Promise<void>;
}

export interface PartnerInstanceMessageStore {
  clear(instanceId: string): Promise<void>;
  load(instanceId: string): Promise<unknown[] | null>;
  save(instanceId: string, messages: unknown[]): Promise<void>;
}

export interface ResidentTurnInput {
  /** The real session/conversation id recorded after the previous turn (engine-specific). */
  externalSessionRef?: string;
  instanceId: string;
  knowledgeSection: string;
  request: PartnerRunRequest;
  restoredMessages: unknown[] | null;
  revision: PartnerRevision;
  skillEnvironmentKeys: readonly string[];
  skillSection: string;
}

export interface PartnerExecutionContext {
  knowledgeSection: string;
  skillEnvironmentKeys: readonly string[];
  skillSection: string;
}

export interface ResidentTurnResult {
  conversation?: AgentConversationDraft[];
  externalRunId: string;
  externalSessionRef?: string;
  messages: unknown[];
  output: PartnerRunOutput;
  status: PartnerRunStatus;
}

/** Implemented per engine under infrastructure/; joi reasoning never touches it. */
export interface PartnerEngineRuntime {
  engineOf(): PartnerEngine;
  evictFromMemory(instanceId: string): void;
  health(): Promise<{ available: boolean; reason?: string }>;
  runEphemeral(request: PartnerRunRequest, revision: PartnerRevision, context: PartnerExecutionContext): Promise<{ conversation?: AgentConversationDraft[]; externalRunId: string; output: PartnerRunOutput; status: PartnerRunStatus }>;
  runResidentTurn(input: ResidentTurnInput): Promise<ResidentTurnResult>;
  /** Selectable native tool names for this engine's whitelist picker. */
  toolOptions(): readonly string[];
}
