import type { PartnerEngine, PartnerRevision } from "../../domain/partners/partner.js";
import type { ModelSourceTurnPin } from "../../domain/model-sources/model-source.js";
import type { PartnerRunOutput, PartnerRunRequest, PartnerRunStatus } from "./partner-execution.js";
import type { AgentConversationDraft } from "../partners/agent-conversation-presentation.js";
import type { ToolTraceDraft } from "../partners/tool-trace-presentation.js";
import type { NativeAgentEvent } from "./native-agent-events.js";
import type { ConversationContextDto,ConversationThinkingDto } from "../../../shared/conversations.js";
import type { SummaryRetryState } from "./summary-state.js";

export type SessionPolicy = "EPHEMERAL" | "RESIDENT";
export type PartnerInstanceStatus = "BUSY" | "DISPOSED" | "IDLE" | "SUSPENDED";

/**
 * One completed tool call's private body, on its way to the local store. This is a
 * deliberate, explicit side channel: it never travels as a `NativeAgentEvent`, so the
 * event surface keeps its "parameters and results are dropped before the port" contract
 * (AC-62). Only engines that can supply it opt in.
 */
export interface PartnerToolTraceProgress {
  instanceId: string;
  trace: ToolTraceDraft;
}

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
  markSuspended?(instanceId: string, at: string, externalSessionRef?: string): Promise<void>;
  recoverCrashed(at: string): Promise<{ ephemeralDisposed: number; residentRecovered: number }>;
  setStatusBusy(instanceId: string, at: string, resume?: boolean): Promise<boolean>;
}

export interface PartnerInstanceMessageStore {
  clear(instanceId: string): Promise<void>;
  load(instanceId: string, strict?: boolean): Promise<unknown[] | null>;
  save(instanceId: string, messages: unknown[]): Promise<void>;
}

export interface ResidentTurnInput extends PartnerExecutionContext {
  sessionState?: PartnerSessionState;
  saveSession?: (state: PartnerSessionState) => Promise<void>;
  /** The real session/conversation id recorded after the previous turn (engine-specific). */
  externalSessionRef?: string;
  instanceId: string;
  knowledgeSection: string;
  onEvent?: (event: NativeAgentEvent) => Promise<void>;
  /** Payload-free execution activity; independent of conversation projection. */
  onProgress?: () => void;
  /** Private per-call tool body for local debugging; never a `NativeAgentEvent`. */
  onToolTrace?: (trace: ToolTraceDraft) => Promise<void>;
  request: PartnerRunRequest;
  restoredMessages: unknown[] | null;
  revision: PartnerRevision;
  /** Abort requested by the dispatch actor (watchdog, lease loss, cancellation). */
  signal?: AbortSignal;
  skillEnvironmentKeys: readonly string[];
  skillSection: string;
  /** Source selected by the manager's side-effect-free preflight, when available. */
  sourcePin?: ModelSourceTurnPin;
}

/** Private execution history, separate from the safe UI projection and disposable instances. */
export interface PartnerSessionState {
  summaryRetry?: SummaryRetryState;
  engine: PartnerEngine;
  messages: unknown[];
  externalSessionRef?: string;
  checkpoint?: unknown;
  route?: string;
}

export interface PartnerExecutionContext {
  onThinking?: (thinking: ConversationThinkingDto) => Promise<void>;
  onContext?: (context: ConversationContextDto) => Promise<void>;
  sessionState?: PartnerSessionState;
  saveSession?: (state: PartnerSessionState) => Promise<void>;
  knowledgeSection: string;
  onEvent?: (event: NativeAgentEvent) => Promise<void>;
  /** Payload-free execution activity; independent of conversation projection. */
  onProgress?: () => void;
  /** Private per-call tool body for local debugging; never a `NativeAgentEvent`. */
  onToolTrace?: (trace: ToolTraceDraft) => Promise<void>;
  skillEnvironmentKeys: readonly string[];
  skillSection: string;
}

export interface PartnerConversationProgress {
  /** Built on demand: a consumer that throttles live snapshots must be able to skip the copy. */
  conversation: () => AgentConversationDraft[];
  instanceId: string;
}

export interface ResidentTurnResult {
  conversation?: AgentConversationDraft[];
  externalRunId: string;
  externalSessionRef?: string;
  messages?: unknown[];
  output: PartnerRunOutput;
  status: PartnerRunStatus | "SUSPENDED";
}

/** Implemented per engine under infrastructure/; joi reasoning never touches it. */
export interface PartnerEngineRuntime {
  engineOf(): PartnerEngine;
  evictFromMemory(instanceId: string): void;
  health(): Promise<{ available: boolean; reason?: string }>;
  checkpointAvailable?(reference: string): Promise<boolean>;
  /** Side-effect-free readiness gate executed before an Agent instance or tools are created. */
  preflight?(input: { revision: PartnerRevision; turnId: string }): Promise<ModelSourceTurnPin | undefined>;
  /** User-triggered end-to-end availability check. Implementations must return only stable safe reason codes. */
  probe?(input?: { modelId?: string }): Promise<{ available: boolean; reasonCode?: string }>;
  runEphemeral(request: PartnerRunRequest, revision: PartnerRevision, context: PartnerExecutionContext, options?: { signal?: AbortSignal }): Promise<{ conversation?: AgentConversationDraft[]; externalRunId: string; output: PartnerRunOutput; status: PartnerRunStatus | "SUSPENDED" }>;
  runResidentTurn(input: ResidentTurnInput): Promise<ResidentTurnResult>;
  /** Selectable native tool names for this engine's whitelist picker. */
  toolOptions(): readonly string[];
}
