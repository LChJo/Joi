import type { AgentConnectionStatus, PublicAgentConnection } from "../../domain/agents/agent-connection.js";

export interface AgentCardCandidate {
  authentication: "bearer";
  capabilities: { streaming: boolean };
  cardHash: string;
  cardUrl: string;
  cardUrlHash: string;
  description: string;
  name: string;
  origin: string;
  protocolVersion: string;
  rpcUrl: string;
  skills: string[];
  transport: "JSONRPC" | "REST";
}

export interface AgentDiscoveryResult {
  card: AgentCardCandidate;
  readiness: { supported: boolean; supportedActions: string[] };
}

export interface AgentDiscovery {
  validate(input: { cardUrl: string; confirmedCard?: AgentCardCandidate; expectedActionId: string; token: string }): Promise<AgentDiscoveryResult>;
}

export interface CredentialVault {
  decrypt(ciphertext: Uint8Array): Promise<string>;
  encrypt(token: string): Promise<Uint8Array>;
  isAvailable(): boolean;
}

export interface AgentIntegrationRecord {
  agentConnectionId: string;
  card: AgentCardCandidate;
  credentialId: string;
  credentialVersion: number;
  encryptedCredential: Uint8Array;
  readiness: boolean;
  status: AgentConnectionStatus;
}

export interface SaveOnboardedAgentInput {
  agentConnectionId: string;
  card: AgentCardCandidate;
  cardSnapshotId: string;
  credentialId: string;
  credentialVersion: number;
  encryptedCredential: Uint8Array;
  now: string;
  readiness: boolean;
  status: "ACTIVE" | "COLLABORATOR_ONLY";
}

export interface AgentIntegrationStore {
  deleteAgentIntegration(agentConnectionId: string, now: string): Promise<boolean>;
  findAgentConnectionByCardUrlHash(cardUrlHash: string): Promise<AgentIntegrationRecord | null>;
  getAgentDeletionImpact(agentConnectionId: string): Promise<{ activeInvocations: number; bindings: { lifeId: string; name: string; role: "COLLABORATOR" | "PRIMARY" }[] } | null>;
  getAgentIntegrationRecord(agentConnectionId: string): Promise<AgentIntegrationRecord | null>;
  getPublicAgentConnection(agentConnectionId: string): Promise<PublicAgentConnection | null>;
  markAgentCardDrift(input: { agentConnectionId: string; candidate: AgentCardCandidate; cardSnapshotId: string; now: string }): Promise<PublicAgentConnection>;
  saveOnboardedAgent(input: SaveOnboardedAgentInput): Promise<PublicAgentConnection>;
  setAgentIntegrationStatus(agentConnectionId: string, status: "DISABLED", now: string): Promise<PublicAgentConnection | null>;
}

export interface ConnectionBreakerRecord {
  breakerKey: string;
  lastStatus: 429 | 503;
  openUntil: string;
  updatedAt: string;
}

export interface ConnectionBreakerStore {
  /** Removes breaker rows whose cooldown has lapsed so the table does not grow unbounded. */
  deleteExpiredConnectionBreakers(before: string): Promise<number>;
  getConnectionBreaker(breakerKey: string): Promise<ConnectionBreakerRecord | null>;
  saveConnectionBreaker(record: ConnectionBreakerRecord): Promise<void>;
}

export type A2aRequestPart =
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: "file"; bytes: string; mimeType?: string; name?: string }
  | { kind: "text"; text: string };

export interface A2aInvocationRequest {
  contextId?: string;
  extensions?: string[];
  invocationId: string;
  messageId: string;
  parts: A2aRequestPart[];
}

export type A2aRemoteState = "auth-required" | "canceled" | "completed" | "failed" | "input-required" | "rejected" | "submitted" | "unknown" | "working";

export interface A2aInvocationOutput {
  artifacts: { name: string; text: string }[];
  parts: { data: unknown; extensionUri?: string; kind: string }[];
}

export type A2aRemoteEvent =
  | { contextId: string; kind: "artifact"; artifactId: string; filename?: string; mimeType?: string; output?: A2aInvocationOutput; size?: number; taskId: string; url?: string }
  | { contextId: string; kind: "message"; output?: A2aInvocationOutput }
  | { contextId: string; kind: "status"; final: boolean; output?: A2aInvocationOutput; prompt?: string; state: A2aRemoteState; taskId: string }
  | { contextId: string; kind: "task"; output?: A2aInvocationOutput; state: A2aRemoteState; taskId: string };

export interface A2aTransportConfig {
  agentConnectionId: string;
  credentialVersion: number;
  origin: string;
  rpcUrl: string;
  token: string;
  transport: "JSONRPC" | "REST";
}

export interface A2aInvocationTransport {
  cancelTask(input: { config: A2aTransportConfig; taskId: string }): Promise<A2aRemoteEvent>;
  getTask(input: { config: A2aTransportConfig; taskId: string }): Promise<A2aRemoteEvent>;
  resubscribe(input: { config: A2aTransportConfig; taskId: string }): AsyncIterable<A2aRemoteEvent>;
  sendStream(input: { config: A2aTransportConfig; request: A2aInvocationRequest; signal?: AbortSignal; token: string }): AsyncIterable<A2aRemoteEvent>;
}

export type InvocationStatus =
  | "ACCEPTED" | "AUTH_REQUIRED" | "CANCELED" | "COMPLETED" | "CREATED" | "FAILED" | "INPUT_REQUIRED"
  | "SENDING" | "SENT_NO_ACCEPT" | "UNKNOWN_REQUIRES_REVIEW" | "WAITING_RETRY" | "WORKING";

export interface InvocationRecord {
  acceptedAt?: string;
  agentConnectionId: string;
  contextId?: string;
  createdAt: string;
  invocationId: string;
  lastActivityAt: string;
  messageId: string;
  request: { contextId?: string; extensions?: string[]; parts: A2aRequestPart[] };
  sendAttempts: number;
  status: InvocationStatus;
  taskId?: string;
  updatedAt: string;
}

export interface InvocationStore {
  createInvocation(input: {
    agentConnectionId: string;
    createdAt: string;
    invocationId: string;
    messageId: string;
    outboxId: string;
    request: { contextId?: string; extensions?: string[]; parts: A2aRequestPart[] };
  }): Promise<InvocationRecord>;
  getInvocation(invocationId: string): Promise<InvocationRecord | null>;
  updateInvocation(invocationId: string, patch: {
    acceptedAt?: string;
    contextId?: string;
    sendAttempts?: number;
    status?: InvocationStatus;
    taskId?: string;
    updatedAt: string;
  }): Promise<InvocationRecord>;
}

export interface PrimaryAgentContextRecord {
  affairKey: string;
  agentConnectionId: string;
  contextId: string;
  createdAt: string;
  lifeId: string;
  updatedAt: string;
}

export interface PrimaryAgentContextStore {
  clearPrimaryAgentContext(input: { affairKey: string; agentConnectionId: string; lifeId: string }): Promise<void>;
  getPrimaryAgentContext(input: { affairKey: string; agentConnectionId: string; lifeId: string }): Promise<PrimaryAgentContextRecord | null>;
  savePrimaryAgentContext(record: PrimaryAgentContextRecord): Promise<void>;
}

export interface InteractionRecord {
  createdAt: string;
  interactionId: string;
  invocationId: string;
  kind: "auth-required" | "input-required";
  prompt: string;
  status: "PENDING" | "RESOLVED" | "STALE";
}

export interface ArtifactRecord {
  affairId?: string;
  artifactId: string;
  createdAt: string;
  filename: string;
  invocationId: string;
  lifeId?: string;
  mimeType: string;
  remoteArtifactId: string;
  relativePath?: string;
  sha256?: string;
  size: number;
}

export interface ArtifactDownloader {
  download(input: {
    artifactId: string;
    declaredOrigin: string;
    filename: string;
    invocationId: string;
    mimeType: string;
    size: number;
    token: string;
    url: string;
  }): Promise<{ relativePath: string; sha256: string; size: number }>;
}

export interface A2aResultStore {
  assertArtifactQuota(input: { affairId?: string; additionalBytes: number; lifeId: string }): Promise<void>;
  createArtifact(record: ArtifactRecord): Promise<ArtifactRecord>;
  createInteraction(record: InteractionRecord): Promise<InteractionRecord>;
  getArtifact(artifactId: string): Promise<ArtifactRecord | null>;
  getInteraction(interactionId: string): Promise<InteractionRecord | null>;
  getInteractionScope(interactionId: string): Promise<{ affairId?: string; lifeId: string } | null>;
  listInvocationArtifacts(invocationId: string): Promise<ArtifactRecord[]>;
  listLifeArtifacts(lifeId: string): Promise<ArtifactRecord[]>;
  listInvocationInteractions(invocationId: string): Promise<InteractionRecord[]>;
  listPendingInteractions(): Promise<InteractionRecord[]>;
  resolveInteraction(interactionId: string): Promise<InteractionRecord>;
}
