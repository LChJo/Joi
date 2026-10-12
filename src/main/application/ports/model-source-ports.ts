import type {
  ModelCapability,
  ModelSourceAccessMode,
  ModelSource,
  ModelSourceKind,
  ModelSourceProtocol,
  ModelSourceStatus,
} from "../../domain/model-sources/model-source.js";

export type PiCredentialType = "api_key" | "oauth";

export interface EncryptedPiCredentialRecord {
  encryptedBlob: Uint8Array;
  providerId: string;
  type: PiCredentialType;
  version: number;
}

export interface PiCredentialRecordStore {
  delete(providerId: string): Promise<void>;
  list(): Promise<{ providerId: string; type: PiCredentialType; version: number }[]>;
  read(providerId: string): Promise<EncryptedPiCredentialRecord | null>;
  write(record: EncryptedPiCredentialRecord): Promise<void>;
}

export interface ModelSourceRecord {
  /** A transport fact proven for the current endpoint and credential, absent for API Key auth. */
  anthropicAuthMode?: "bearer";
  baseUrl?: string;
  lastError?: string;
  lastValidatedAt?: string;
  local: boolean;
  order: number;
  presetVersion?: string;
  primary: boolean;
  reasonCode?: string;
  source: ModelSource;
}

export interface ModelSourceHealthRevision {
  sourceStatus?: ModelSourceStatus;
  credentialVersion: number;
  modelRevisionId: string;
  sourceRevisionId: string;
  sourceUpdatedAt: string;
}

export interface ModelSourceRepository {
  create(record: ModelSourceRecord): Promise<void>;
  delete(sourceId: string): Promise<void>;
  get(sourceId: string): Promise<ModelSourceRecord | null>;
  list(): Promise<ModelSourceRecord[]>;
  /** Remembers that the revision pair demonstrated structured tool calling; idempotent per pair. */
  recordToolProof?(input: { modelRevisionId: string; provenAt: string; sourceRevisionId: string }): Promise<void>;
  revise(record: ModelSourceRecord): Promise<void>;
  save(record: ModelSourceRecord): Promise<void>;
  /** Atomically writes health only when the active source/model/credential revision still matches. */
  saveHealthIfCurrent?(record: ModelSourceRecord, expected: ModelSourceHealthRevision): Promise<boolean>;
  setOrder(sourceIds: string[]): Promise<void>;
}

export interface ModelSourceSecretStore {
  delete(providerId: string): Promise<void>;
  saveApiKey(providerId: string, apiKey: string | undefined): Promise<number>;
}

export interface ModelSourceCatalog {
  resolve(kind: ModelSourceKind, requestedModelId?: string, requestedAccessMode?: ModelSourceAccessMode, requestedProtocol?: ModelSourceProtocol): {
    accessMode: ModelSourceAccessMode;
    capability: ModelCapability;
    displayName: string;
    modelId: string;
    protocol: ModelSourceProtocol;
    presetVersion?: string;
  };
}

export interface ModelSourceEndpointPolicy {
  validate(url: string): Promise<{ local: boolean; url: string }>;
}

/** The size a route will actually be driven at, after every source of truth is folded in. */
export interface EffectiveModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
}

/**
 * Read-only view of the limits a route resolves to. A provider that refuses an oversized request
 * states its real limit in the rejection, and joi holds the route to that figure for the life of
 * the process — overriding whatever the user configured. Without this the settings page would show
 * a value that is silently not in effect, and the user has no way to tell that from a broken
 * setting.
 */
export interface ModelLimitReader {
  effective(input: {
    accessMode: ModelSourceAccessMode;
    contextWindow?: number;
    kind: ModelSourceKind;
    maxOutputTokens?: number;
    modelId: string;
    protocol: ModelSourceProtocol;
    sourceId: string;
  }): EffectiveModelLimits;
}

export interface ModelSourceValidator {
  validate(record: ModelSourceRecord): Promise<{
    anthropicAuthMode?: "bearer";
    error?: string;
    reasonCode?: string;
    status: Extract<ModelSourceStatus, "READY" | "DEGRADED" | "NEEDS_AUTH">;
    validatedAt: string;
  }>;
}
