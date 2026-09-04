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

export interface ModelSourceValidator {
  validate(record: ModelSourceRecord): Promise<{
    error?: string;
    reasonCode?: string;
    status: Extract<ModelSourceStatus, "READY" | "DEGRADED" | "NEEDS_AUTH">;
    validatedAt: string;
  }>;
}
