import { DomainError } from "../errors.js";

export const MODEL_SOURCE_STATUSES = ["DRAFT", "VALIDATING", "READY", "DEGRADED", "NEEDS_AUTH", "DISABLED"] as const;
export type ModelSourceStatus = (typeof MODEL_SOURCE_STATUSES)[number];
export type ModelSourceKind = "kimi" | "glm" | "qwen" | "doubao" | "minimax" | "deepseek" | "generic-openai";
export type ModelSourceAccessMode = "api" | "coding-plan" | "token-plan" | "custom";
export type ModelSourceProtocol = "openai" | "anthropic";
export type ModelCapability = "release-tested" | "custom-unverified-tools";
export type SourceFailureKind =
  | "timeout" | "connect" | "rate_limited" | "server_error"
  | "auth" | "balance" | "configuration"
  | "safety_refusal" | "content_refusal"
  | "protocol";

export interface ModelSourceRevision {
  accessMode: ModelSourceAccessMode;
  createdAt: string;
  credentialRef: string;
  credentialVersion: number;
  displayName: string;
  kind: ModelSourceKind;
  protocol: ModelSourceProtocol;
  sourceRevisionId: string;
}

export interface ModelRevision {
  capability: ModelCapability;
  /** Percent of the route's window at which the session is compacted. Absent means the runtime default. */
  compactionThresholdPercent?: number;
  /** Documented window for this exact model, overriding what joi would otherwise infer. */
  contextWindow?: number;
  createdAt: string;
  /** Documented completion cap, which is a separate limit from the window. */
  maxOutputTokens?: number;
  modelId: string;
  modelRevisionId: string;
}

export interface ModelSource {
  activeModelRevision: ModelRevision;
  activeSourceRevision: ModelSourceRevision;
  createdAt: string;
  sourceId: string;
  status: ModelSourceStatus;
  /** Set once the active revision pair demonstrated structured tool calling in a real Turn. */
  toolProofAt?: string;
  updatedAt: string;
}

export interface CreateModelSourceInput {
  accessMode?: ModelSourceAccessMode;
  compactionThresholdPercent?: number;
  contextWindow?: number;
  createdAt: string;
  credentialRef: string;
  credentialVersion: number;
  displayName: string;
  kind: ModelSourceKind;
  maxOutputTokens?: number;
  modelCapability: ModelCapability;
  modelId: string;
  modelRevisionId: string;
  protocol?: ModelSourceProtocol;
  sourceId: string;
  sourceRevisionId: string;
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) throw new DomainError(code, "Model source value is invalid.");
  return normalized;
}

/** Bounds mirror the CHECK constraints added by migration 063, so an out-of-range value is
 *  reported as a domain error rather than as a raw SQLite constraint failure. */
const CONTEXT_WINDOW_RANGE = { max: 10_000_000, min: 4_096 } as const;
const MAX_OUTPUT_TOKENS_RANGE = { max: 1_000_000, min: 256 } as const;
/** 100 is excluded on purpose: compacting only once the request fills the whole window is too
 *  late — the provider clamps max_tokens toward 1 and the Turn truncates first. */
const COMPACTION_PERCENT_RANGE = { max: 95, min: 50 } as const;

function optionalLimit(
  value: number | undefined,
  code: string,
  range: { max: number; min: number },
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
    throw new DomainError(code, "Model source limit is out of range.");
  }
  return value;
}

/** Applies the shared range check to the three per-model limits and returns them ready to spread. */
function modelLimits(input: {
  compactionThresholdPercent?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}): Pick<ModelRevision, "compactionThresholdPercent" | "contextWindow" | "maxOutputTokens"> {
  const contextWindow = optionalLimit(input.contextWindow, "model_source_context_window_invalid", CONTEXT_WINDOW_RANGE);
  const maxOutputTokens = optionalLimit(input.maxOutputTokens, "model_source_max_output_invalid", MAX_OUTPUT_TOKENS_RANGE);
  const compactionThresholdPercent = optionalLimit(
    input.compactionThresholdPercent, "model_source_compaction_threshold_invalid", COMPACTION_PERCENT_RANGE,
  );
  return {
    ...(compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

export function createModelSource(input: CreateModelSourceInput): ModelSource {
  if (!Number.isSafeInteger(input.credentialVersion) || input.credentialVersion < 1) {
    throw new DomainError("model_source_credential_version_invalid", "Credential version is invalid.");
  }
  return {
    activeModelRevision: {
      capability: input.modelCapability,
      ...modelLimits(input),
      createdAt: input.createdAt,
      modelId: required(input.modelId, "model_id_invalid"),
      modelRevisionId: required(input.modelRevisionId, "model_revision_id_invalid"),
    },
    activeSourceRevision: {
      accessMode: input.accessMode ?? (input.kind === "generic-openai" ? "custom" : "api"),
      createdAt: input.createdAt,
      credentialRef: required(input.credentialRef, "model_source_credential_ref_invalid"),
      credentialVersion: input.credentialVersion,
      displayName: required(input.displayName, "model_source_name_invalid"),
      kind: input.kind,
      protocol: input.protocol ?? "openai",
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
    compactionThresholdPercent?: number;
    contextWindow?: number;
    credentialVersion: number;
    displayName?: string;
    maxOutputTokens?: number;
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
  // The caller owns "unchanged": anything it omits here is dropped from the new revision, because
  // this table is append-only and nothing merges the previous row back in. Callers that mean
  // "keep the current value" must pass it explicitly (see ModelSourceService.update).
  return {
    ...source,
    activeModelRevision: {
      capability: input.modelCapability,
      ...modelLimits(input),
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

export interface ModelSourceTurnPin {
  modelCapability?: ModelCapability;
  modelId: string;
  modelRevisionId: string;
  sourceId: string;
  sourceRevisionId: string;
  /** True once this revision pair demonstrated structured tool calling; the first-Turn gate no longer applies. Absent means unproven. */
  toolCapabilityProven?: boolean;
  turnId: string;
}

export function pinModelSourceForTurn(source: ModelSource, turnId: string): ModelSourceTurnPin {
  return {
    modelCapability: source.activeModelRevision.capability,
    modelId: source.activeModelRevision.modelId,
    modelRevisionId: source.activeModelRevision.modelRevisionId,
    sourceId: source.sourceId,
    sourceRevisionId: source.activeSourceRevision.sourceRevisionId,
    toolCapabilityProven: source.toolProofAt !== undefined,
    turnId: required(turnId, "joi_turn_id_invalid"),
  };
}

export function classifySourceFailure(failure: SourceFailureKind): { fallbackAllowed: boolean; sourceNeedsAttention: boolean } {
  if (failure === "timeout" || failure === "connect" || failure === "rate_limited" || failure === "server_error" || failure === "protocol") {
    return { fallbackAllowed: true, sourceNeedsAttention: false };
  }
  if (failure === "auth" || failure === "balance" || failure === "configuration") {
    return { fallbackAllowed: false, sourceNeedsAttention: true };
  }
  return { fallbackAllowed: false, sourceNeedsAttention: false };
}
