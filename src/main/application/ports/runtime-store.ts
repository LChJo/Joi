import type { AgentConnection, AgentConnectionStatus, PublicAgentConnection } from "../../domain/agents/agent-connection.js";
import type { CreateLifeInput, Life, UpdateLifeInput } from "../../domain/lives/life.js";
import type { A2aResultStore, AgentIntegrationStore, ConnectionBreakerStore, InvocationStore, PrimaryAgentContextStore } from "./a2a-ports.js";
import type { RuntimeCoreStore } from "./runtime-core-ports.js";
import type { ContinuityStore } from "./continuity-ports.js";
import type { UserAttachmentStore } from "./attachment-ports.js";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface SseEvent {
  createdAt: string;
  entityId: string;
  payload: Record<string, unknown>;
  sequence: number;
  type: string;
}

export interface SseSequenceWindow {
  earliestRetainedSequence?: number;
  latestIssuedSequence: number;
}

export interface SsePublisher {
  publish(event: SseEvent): void | Promise<void>;
}

export interface SseBroker {
  publish(event: SseEvent): void;
  subscribe(listener: (event: SseEvent) => void): () => void;
}

export interface LifeCreateRecord extends CreateLifeInput {
  createdAt: string;
  lifeId: string;
  personaVersionId: string;
  principles: string[];
}

export interface LifeMutationResult {
  event: SseEvent;
  life: Life;
}

export interface LifeDeletionImpact {
  affairs: number;
  alarms: number;
  artifacts: number;
  attachments: number;
  delegations: number;
  events: number;
  managedBytes: number;
  memories: number;
  schedules: number;
  todos: number;
  wakes: number;
}

export interface LifeHandoffContext {
  affairs: { status: string; summary?: string; title: string }[];
  cards: string[];
  residue?: string;
  todos: { status: string; title: string }[];
}

export interface PrimaryAgentHandoff {
  createdAt: string;
  fromAgentConnectionId: string;
  handoffId: string;
  lifeId: string;
  summary: string;
  toAgentConnectionId: string;
}

export interface LifeOverviewFacts {
  autonomousBudgetDailyLimit: number;
  autonomousBudgetUsed: number;
  nextAlarmAt?: string;
  pendingEventCount: number;
  schedules: { localTime: string; timezone: string }[];
  totalBudgetDailyLimit: number;
  totalBudgetUsed: number;
}

export interface LifeOverview extends Life {
  autonomousBudgetDailyLimit: number;
  autonomousBudgetUsed: number;
  nextWakeAt?: string;
  pendingEventCount: number;
  totalBudgetDailyLimit: number;
  totalBudgetUsed: number;
}

export interface LifeListPage {
  items: Life[];
  next?: { createdAt: string; lifeId: string };
}

export interface LifeStore {
  archiveLife(lifeId: string, now: string): Promise<LifeMutationResult | null>;
  changePrimaryAgent(input: {
    fromAgentConnectionId: string;
    handoffId: string;
    lifeId: string;
    now: string;
    summary: string;
    toAgentConnectionId: string;
  }): Promise<{ event: SseEvent; handoff: PrimaryAgentHandoff; life: Life }>;
  createLife(record: LifeCreateRecord, idempotencyKey?: string): Promise<LifeMutationResult>;
  deleteLife(lifeId: string, now: string): Promise<SseEvent | null>;
  getLifeDeletionImpact(lifeId: string): Promise<LifeDeletionImpact | null>;
  getLifeHandoffContext(lifeId: string): Promise<LifeHandoffContext | null>;
  getLifeOverviewFacts(input: { lifeId: string; localDate: string; now: string }): Promise<LifeOverviewFacts>;
  getLife(lifeId: string): Promise<Life | null>;
  listPrimaryAgentHandoffs(lifeId: string): Promise<PrimaryAgentHandoff[]>;
  listLives(input: { after?: { createdAt: string; lifeId: string }; limit: number }): Promise<LifeListPage>;
  updateLife(input: { lifeId: string; now: string; patch: UpdateLifeInput; personaVersionId: string }): Promise<LifeMutationResult | null>;
  updateLifeRhythm(input: {
    autonomousWakesDefault: number;
    idleExplorationsDefault: number;
    invocationsDefault: number;
    lifeId: string;
    now: string;
    quietEnd: string;
    quietStart: string;
  }): Promise<LifeMutationResult | null>;
}

export interface AgentStore {
  createAgentConnection(connection: AgentConnection): Promise<void>;
  getAgentConnection(agentConnectionId: string): Promise<AgentConnection | null>;
  listPublicAgentConnections(): Promise<PublicAgentConnection[]>;
  getPublicAgentConnection(agentConnectionId: string): Promise<PublicAgentConnection | null>;
  updateAgentConnectionStatus(agentConnectionId: string, status: AgentConnectionStatus, now: string): Promise<AgentConnection | null>;
}

export interface AdminCredentialRecord {
  algorithm: "scrypt";
  derivedKey: string;
  parameters: { cost: number; keyLength: number; parallelization: number; blockSize: number };
  salt: string;
  updatedAt: string;
}

export interface WebSessionRecord {
  absoluteExpiresAt: string;
  createdAt: string;
  csrfHash: string;
  idleExpiresAt: string;
  ipHash: string;
  kind: "desktop" | "lan";
  lastActivityAt: string;
  revokedAt?: string;
  sessionHash: string;
}

export interface AuthStore {
  deleteExpiredSessions(now: string): Promise<void>;
  getAdminCredential(): Promise<AdminCredentialRecord | null>;
  getSession(sessionHash: string): Promise<WebSessionRecord | null>;
  listSessions(): Promise<WebSessionRecord[]>;
  revokeAllSessions(now: string): Promise<void>;
  revokeAllLanSessions(now: string): Promise<void>;
  revokeSession(sessionHash: string, now: string): Promise<void>;
  saveAdminCredential(record: AdminCredentialRecord): Promise<void>;
  saveSession(record: WebSessionRecord): Promise<void>;
  touchSession(sessionHash: string, lastActivityAt: string, idleExpiresAt: string): Promise<void>;
}

export interface BootstrapNonceStore {
  consume(nonce: string, now: Date): boolean;
  issue(nonce: string, expiresAt: Date): void;
}

export interface PasswordDerivation {
  derivedKey: string;
  parameters: AdminCredentialRecord["parameters"];
  salt: string;
}

export interface SecurityPrimitives {
  derivePassword(password: string): Promise<PasswordDerivation>;
  hashToken(token: string): string;
  randomToken(bytes?: number): string;
  verifyPassword(password: string, credential: AdminCredentialRecord): Promise<boolean>;
  verifyToken(token: string, expectedHash: string): boolean;
}

export interface LoginRateLimit {
  assertAllowed(remoteAddress: string): void;
  recordFailure(remoteAddress: string): void;
  reset(remoteAddress: string): void;
}

export interface OutboxInput {
  availableAt: string;
  kind: string;
  outboxId: string;
  payload: Record<string, unknown>;
}

export interface OutboxRecord extends OutboxInput {
  attemptCount: number;
  claimOwner?: string;
  claimUntil?: string;
  createdAt: string;
  status: "CLAIMED" | "DONE" | "PENDING";
}

export interface RuntimeLease {
  expiresAt: string;
  generation: number;
  owner: string;
  resourceId: string;
  resourceType: string;
}

export interface RuntimeStats {
  activeInvocations: number;
  activeWakes: number;
  agentConnections: number;
  backupHistory: number;
  enabledSchedules: number;
  integrity: string;
  journalMode: string;
  lives: number;
  openBreakers: number;
  pendingOutbox: number;
  runtimeLeases: number;
  scheduledAlarms: number;
  schemaVersion: number;
  sessions: number;
  sseEvents: number;
  staleWakeTurns: number;
}

export interface RuntimeStore extends LifeStore, AgentStore, AuthStore, AgentIntegrationStore, ConnectionBreakerStore, InvocationStore, PrimaryAgentContextStore, A2aResultStore, RuntimeCoreStore, ContinuityStore, UserAttachmentStore {
  acquireLease(input: Omit<RuntimeLease, "generation"> & { now: string }): Promise<RuntimeLease | null>;
  appendSseEvent(input: Omit<SseEvent, "createdAt" | "sequence">): Promise<SseEvent>;
  claimOutbox(input: { claimUntil: string; limit: number; now: string; owner: string }): Promise<OutboxRecord[]>;
  claimOutboxById(input: { claimUntil: string; now: string; outboxId: string; owner: string }): Promise<OutboxRecord | null>;
  completeOutbox(outboxId: string, owner: string): Promise<void>;
  countOutbox(): Promise<number>;
  createManifestHash(payload: Record<string, unknown>): string;
  enqueueOutbox(input: OutboxInput): Promise<void>;
  releaseOutbox(input: { availableAt: string; outboxId: string; owner: string }): Promise<void>;
  getRuntimeStats(): Promise<RuntimeStats>;
  getSseSequenceWindow(): Promise<SseSequenceWindow>;
  listSseEvents(afterSequence: number, limit: number): Promise<SseEvent[]>;
  pruneSseEventsBefore(cutoff: string): Promise<number>;
}
