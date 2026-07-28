import { DomainError } from "../errors.js";

export const MODEL_SOURCE_STATUSES = ["DRAFT", "VALIDATING", "READY", "DEGRADED", "NEEDS_AUTH", "DISABLED"] as const;
export type ModelSourceStatus = (typeof MODEL_SOURCE_STATUSES)[number];
export type ModelSourceKind = "kimi" | "glm" | "qwen" | "doubao" | "minimax" | "deepseek" | "generic-openai";
export type ModelCapability = "release-tested" | "custom-unverified-tools";
export type SourceFailureKind =
  | "timeout" | "connect" | "rate_limited" | "server_error"
  | "auth" | "balance" | "configuration"
  | "safety_refusal" | "content_refusal";

export interface ModelSourceRevision {
  createdAt: string;
  credentialRef: string;
  credentialVersion: number;
  displayName: string;
  kind: ModelSourceKind;
  sourceRevisionId: string;
}

export interface ModelRevision {
  capability: ModelCapability;
  createdAt: string;
  modelId: string;
  modelRevisionId: string;
}

export interface ModelSource {
  activeModelRevision: ModelRevision;
  activeSourceRevision: ModelSourceRevision;
  createdAt: string;
  sourceId: string;
  status: ModelSourceStatus;
  updatedAt: string;
}

export interface CreateModelSourceInput {
  createdAt: string;
  credentialRef: string;
  credentialVersion: number;
  displayName: string;
  kind: ModelSourceKind;
  modelCapability: ModelCapability;
  modelId: string;
  modelRevisionId: string;
  sourceId: string;
  sourceRevisionId: string;
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) throw new DomainError(code, "Model source value is invalid.");
  return normalized;
}

export function createModelSource(input: CreateModelSourceInput): ModelSource {
  if (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion < 1) {
    throw new DomainError("model_source_credential_version_invalid", "Credential version is invalid.");
  }
  return {
    activeModelRevision: {
      capability: input.modelCapability,
      createdAt: input.createdAt,
      modelId: required(input.modelId, "model_id_invalid"),
      modelRevisionId: required(input.modelRevisionId, "model_revision_id_invalid"),
    },
    activeSourceRevision: {
      createdAt: input.createdAt,
      credentialRef: required(input.credentialRef, "model_source_credential_ref_invalid"),
      credentialVersion: input.credentialVersion,
      displayName: required(input.displayName, "model_source_name_invalid"),
      kind: input.kind,
      sourceRevisionId: required(input.sourceRevisionId, "model_source_revision_id_invalid"),
    },
    createdAt: input.createdAt,
    sourceId: required(input.sourceId, "model_source_id_invalid"),
    status: "DRAFT",
    updatedAt: input.createdAt,
  };
}

export function reviseModelSource(
  source: ModelSource,
  input: {
    credentialVersion: number;
    displayName?: string;
    modelCapability: ModelCapability;
    modelId: string;
    modelRevisionId: string;
    sourceRevisionId: string;
    updatedAt: string;
  },
): ModelSource {
  if (input.sourceRevisionId === source.activeSourceRevision.sourceRevisionId || input.modelRevisionId === source.activeModelRevision.modelRevisionId) {
    throw new DomainError("model_source_revision_reused", "Model source revisions must be immutable.");
  }
  return {
    ...source,
    activeModelRevision: {
      capability: input.modelCapability,
      createdAt: input.updatedAt,
      modelId: required(input.modelId, "model_id_invalid"),
      modelRevisionId: required(input.modelRevisionId, "model_revision_id_invalid"),
    },
    activeSourceRevision: {
      ...source.activeSourceRevision,
      createdAt: input.updatedAt,
      credentialVersion: input.credentialVersion,
      ...(input.displayName === undefined ? {} : { displayName: required(input.displayName, "model_source_name_invalid") }),
      sourceRevisionId: required(input.sourceRevisionId, "model_source_revision_id_invalid"),
    },
    updatedAt: input.updatedAt,
  };
}

export function pinModelSourceForTurn(source: ModelSource, turnId: string) {
  return {
    modelId: source.activeModelRevision.modelId,
    modelRevisionId: source.activeModelRevision.modelRevisionId,
    sourceId: source.sourceId,
    sourceRevisionId: source.activeSourceRevision.sourceRevisionId,
    turnId: required(turnId, "joi_turn_id_invalid"),
  };
}

export function classifySourceFailure(failure: SourceFailureKind): { fallbackAllowed: boolean; sourceNeedsAttention: boolean } {
  if (failure === "timeout" || failure === "connect" || failure === "rate_limited" || failure === "server_error") {
    return { fallbackAllowed: true, sourceNeedsAttention: false };
  }
  if (failure === "auth" || failure === "balance" || failure === "configuration") {
    return { fallbackAllowed: false, sourceNeedsAttention: true };
  }
  return { fallbackAllowed: false, sourceNeedsAttention: false };
}
