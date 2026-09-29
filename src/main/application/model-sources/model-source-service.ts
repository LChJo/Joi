import type { ModelSourceDto, ThinkingEffort } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import {
  createModelSource,
  reviseModelSource,
  type ModelSourceAccessMode,
  type ModelSourceKind,
  type ModelSourceProtocol,
} from "../../domain/model-sources/model-source.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type {
  EffectiveModelLimits,
  ModelLimitReader,
  ModelSourceCatalog,
  ModelSourceEndpointPolicy,
  ModelSourceHealthRevision,
  ModelSourceRecord,
  ModelSourceRepository,
  ModelSourceSecretStore,
  ModelSourceValidator,
} from "../ports/model-source-ports.js";

export interface CreateModelSourceRequest {
  accessMode?: ModelSourceAccessMode;
  apiKey: string;
  baseUrl?: string;
  compactionThresholdPercent?: number;
  contextWindow?: number;
  displayName?: string;
  kind: ModelSourceKind;
  maxOutputTokens?: number;
  modelId?: string;
  protocol?: ModelSourceProtocol;
  thinkingEffort?: ThinkingEffort;
}

export interface UpdateModelSourceRequest {
  apiKey?: string;
  baseUrl?: string;
  /** `null` clears the limit back to the provider preset; `undefined` leaves it unchanged. */
  compactionThresholdPercent?: number | null;
  contextWindow?: number | null;
  displayName?: string;
  maxOutputTokens?: number | null;
  modelId?: string;
  /** Same three-state shape as the limits: `null` clears back to the endpoint allowlist. */
  thinkingEffort?: ThinkingEffort | null;
}

/** `undefined` keeps the current value, `null` clears it, a value sets it. */
function resolveLimit<T>(patch: T | null | undefined, current: T | undefined): T | undefined {
  if (patch === undefined) return current;
  // `null ?? undefined` is undefined, which is exactly "cleared".
  return patch ?? undefined;
}

export class ModelSourceService {
  constructor(private readonly dependencies: {
    catalog: ModelSourceCatalog;
    clock: Clock;
    endpointPolicy: ModelSourceEndpointPolicy;
    ids: IdGenerator;
    /** Absent only in tests that do not exercise the effective-value projection. */
    limits?: ModelLimitReader;
    repository: ModelSourceRepository;
    secrets: ModelSourceSecretStore;
    validator: ModelSourceValidator;
  }) {}

  async create(input: CreateModelSourceRequest): Promise<ModelSourceDto> {
    const catalog = this.dependencies.catalog.resolve(input.kind, input.modelId, input.accessMode, input.protocol);
    let baseUrl: string | undefined;
    let local = false;
    let displayName = catalog.displayName;
    if (input.kind === "generic-openai") {
      if (input.baseUrl === undefined || input.displayName === undefined || input.modelId === undefined) {
        throw new DomainError("model_source_fields_required", "Generic model source fields are required.");
      }
      const endpoint = await this.dependencies.endpointPolicy.validate(input.baseUrl);
      baseUrl = endpoint.url;
      local = endpoint.local;
      displayName = input.displayName.trim();
      if (displayName.length === 0) throw new DomainError("model_source_name_invalid", "Model source name is required.");
    }
    const normalizedKey = input.apiKey.trim();
    if (normalizedKey.length === 0 && !local) throw new DomainError("model_source_key_required", "API key is required.");

    const sourceId = this.dependencies.ids.next("source");
    const providerId = `joi-source:${sourceId}`;
    const credentialVersion = await this.dependencies.secrets.saveApiKey(
      providerId,
      normalizedKey.length === 0 ? undefined : normalizedKey,
    );
    const now = this.dependencies.clock.now().toISOString();
    const existing = await this.dependencies.repository.list();
    const source = createModelSource({
      accessMode: catalog.accessMode,
      ...(input.compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent: input.compactionThresholdPercent }),
      ...(input.contextWindow === undefined ? {} : { contextWindow: input.contextWindow }),
      createdAt: now,
      credentialRef: providerId,
      credentialVersion,
      displayName,
      kind: input.kind,
      ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
      modelCapability: catalog.capability,
      modelId: catalog.modelId,
      modelRevisionId: this.dependencies.ids.next("model_revision"),
      protocol: catalog.protocol,
      sourceId,
      sourceRevisionId: this.dependencies.ids.next("source_revision"),
      ...(input.thinkingEffort === undefined ? {} : { thinkingEffort: input.thinkingEffort }),
    });
    const record: ModelSourceRecord = {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      local,
      order: existing.length,
      ...(catalog.presetVersion === undefined ? {} : { presetVersion: catalog.presetVersion }),
      primary: existing.length === 0,
      source,
    };
    try {
      await this.dependencies.repository.create(record);
    } catch (error) {
      await this.dependencies.secrets.delete(providerId).catch(() => undefined);
      throw error;
    }
    return this.#toDto(record);
  }

  /**
   * The size requests on this route will really use. Shown next to the configured value so a
   * window the provider has since overruled reads as a fact rather than as a setting that did
   * not take.
   */
  #effectiveLimits(record: ModelSourceRecord): EffectiveModelLimits | undefined {
    const revision = record.source.activeModelRevision;
    return this.dependencies.limits?.effective({
      accessMode: record.source.activeSourceRevision.accessMode,
      ...(revision.contextWindow === undefined ? {} : { contextWindow: revision.contextWindow }),
      kind: record.source.activeSourceRevision.kind,
      ...(revision.maxOutputTokens === undefined ? {} : { maxOutputTokens: revision.maxOutputTokens }),
      modelId: revision.modelId,
      protocol: record.source.activeSourceRevision.protocol,
      sourceId: record.source.sourceId,
    });
  }

  #toDto(record: ModelSourceRecord): ModelSourceDto {
    return toDto(record, this.#effectiveLimits(record));
  }

  async list(): Promise<ModelSourceDto[]> {
    return (await this.dependencies.repository.list()).map((record) => this.#toDto(record));
  }

  async update(sourceId: string, input: UpdateModelSourceRequest): Promise<ModelSourceDto> {
    const current = await this.#get(sourceId);
    const kind = current.source.activeSourceRevision.kind;
    const catalog = this.dependencies.catalog.resolve(
      kind,
      input.modelId ?? current.source.activeModelRevision.modelId,
      current.source.activeSourceRevision.accessMode,
      current.source.activeSourceRevision.protocol,
    );
    let baseUrl = current.baseUrl;
    let local = current.local;
    let displayName = input.displayName ?? current.source.activeSourceRevision.displayName;
    if (kind === "generic-openai") {
      if (input.baseUrl !== undefined) {
        const endpoint = await this.dependencies.endpointPolicy.validate(input.baseUrl);
        baseUrl = endpoint.url;
        local = endpoint.local;
      }
      displayName = displayName.trim();
      if (displayName.length === 0) throw new DomainError("model_source_name_invalid", "Model source name is required.");
    }
    let credentialVersion = current.source.activeSourceRevision.credentialVersion;
    if (input.apiKey !== undefined) {
      const normalizedKey = input.apiKey.trim();
      if (normalizedKey.length === 0 && !local) throw new DomainError("model_source_key_required", "API key is required.");
      credentialVersion = await this.dependencies.secrets.saveApiKey(
        current.source.activeSourceRevision.credentialRef,
        normalizedKey.length === 0 ? undefined : normalizedKey,
      );
    }
    // The limits describe a model's geometry, so they do not survive a change of Model ID: the
    // window a user measured for glm-5.2 is simply wrong for glm-4.7. They must still be carried
    // across every *other* edit explicitly — the revision table is append-only and nothing merges
    // the previous row back in, so omitting them here would silently reset them on any edit.
    const modelChanged = catalog.modelId !== current.source.activeModelRevision.modelId;
    const carried = <T,>(value: T | undefined): T | undefined => (modelChanged ? undefined : value);
    const previous = current.source.activeModelRevision;
    const compactionThresholdPercent = resolveLimit(input.compactionThresholdPercent, carried(previous.compactionThresholdPercent));
    const contextWindow = resolveLimit(input.contextWindow, carried(previous.contextWindow));
    const maxOutputTokens = resolveLimit(input.maxOutputTokens, carried(previous.maxOutputTokens));
    const thinkingEffort = resolveLimit(input.thinkingEffort, carried(previous.thinkingEffort));
    const updatedAt = this.dependencies.clock.now().toISOString();
    const source = reviseModelSource(current.source, {
      ...(compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      credentialVersion,
      displayName,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      modelCapability: catalog.capability,
      modelId: catalog.modelId,
      modelRevisionId: this.dependencies.ids.next("model_revision"),
      sourceRevisionId: this.dependencies.ids.next("source_revision"),
      ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
      updatedAt,
    });
    const revised: ModelSourceRecord = {
      ...(baseUrl === undefined ? {} : { baseUrl }),
      local,
      order: current.order,
      ...(catalog.presetVersion === undefined ? {} : { presetVersion: catalog.presetVersion }),
      primary: current.primary,
      source: { ...source, status: "DRAFT" },
    };
    await this.dependencies.repository.revise(revised);
    return this.#toDto(revised);
  }

  async disable(sourceId: string): Promise<ModelSourceDto> {
    const current = await this.#get(sourceId);
    const updatedAt = this.dependencies.clock.now().toISOString();
    const disabled: ModelSourceRecord = {
      ...withoutHealthReason(current),
      source: { ...current.source, status: "DISABLED", updatedAt },
    };
    if (!await this.#saveHealth(disabled, current)) return this.#toDto(await this.#get(sourceId));
    return this.#toDto(disabled);
  }

  async delete(sourceId: string): Promise<void> {
    const current = await this.#get(sourceId);
    await this.dependencies.repository.delete(sourceId);
    await this.dependencies.secrets.delete(current.source.activeSourceRevision.credentialRef);
    const remaining = await this.dependencies.repository.list();
    if (remaining.length > 0) await this.dependencies.repository.setOrder(remaining.map((record) => record.source.sourceId));
  }

  async validate(sourceId: string): Promise<ModelSourceDto> {
    const record = await this.#get(sourceId);
    const validating: ModelSourceRecord = {
      ...record,
      source: { ...record.source, status: "VALIDATING", updatedAt: this.dependencies.clock.now().toISOString() },
    };
    if (!await this.#saveHealth(validating, record)) return this.#toDto(await this.#get(sourceId));
    const result = await this.dependencies.validator.validate(validating);
    const updated: ModelSourceRecord = {
      ...withoutHealthReason(validating),
      lastValidatedAt: result.validatedAt,
      ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
      ...(result.error === undefined ? {} : { lastError: truncateError(result.error) }),
      source: { ...validating.source, status: result.status, updatedAt: result.validatedAt },
    };
    if (!await this.#saveHealth(updated, validating)) return this.#toDto(await this.#get(sourceId));
    return this.#toDto(updated);
  }

  async setOrder(sourceIds: string[]): Promise<ModelSourceDto[]> {
    const records = await this.dependencies.repository.list();
    const known = new Set(records.map((record) => record.source.sourceId));
    if (sourceIds.length !== records.length || new Set(sourceIds).size !== sourceIds.length || sourceIds.some((id) => !known.has(id))) {
      throw new DomainError("model_source_order_invalid", "Model source order must contain every source exactly once.");
    }
    await this.dependencies.repository.setOrder(sourceIds);
    return this.list();
  }

  async hasReadySource(): Promise<boolean> {
    return (await this.dependencies.repository.list()).some((record) => record.source.status === "READY");
  }

  async #get(sourceId: string): Promise<ModelSourceRecord> {
    const record = await this.dependencies.repository.get(sourceId);
    if (record === null) throw new DomainError("model_source_not_found", "Model source was not found.");
    return record;
  }

  async #saveHealth(record: ModelSourceRecord, expected: ModelSourceRecord): Promise<boolean> {
    const revision: ModelSourceHealthRevision = {
      credentialVersion: expected.source.activeSourceRevision.credentialVersion,
      modelRevisionId: expected.source.activeModelRevision.modelRevisionId,
      sourceRevisionId: expected.source.activeSourceRevision.sourceRevisionId,
      sourceUpdatedAt: expected.source.updatedAt,
    };
    if (this.dependencies.repository.saveHealthIfCurrent !== undefined) return this.dependencies.repository.saveHealthIfCurrent(record, revision);
    const current = await this.dependencies.repository.get(record.source.sourceId);
    if (!sameHealthRevision(current, expected)) return false;
    await this.dependencies.repository.save(record);
    return true;
  }
}

const MAX_LAST_ERROR = 1000;

function truncateError(message: string): string {
  return message.length > MAX_LAST_ERROR ? `${message.slice(0, MAX_LAST_ERROR)}…` : message;
}

function withoutHealthReason(record: ModelSourceRecord): Omit<ModelSourceRecord, "lastError" | "reasonCode"> {
  return {
    ...(record.baseUrl === undefined ? {} : { baseUrl: record.baseUrl }),
    ...(record.lastValidatedAt === undefined ? {} : { lastValidatedAt: record.lastValidatedAt }),
    local: record.local,
    order: record.order,
    ...(record.presetVersion === undefined ? {} : { presetVersion: record.presetVersion }),
    primary: record.primary,
    source: record.source,
  };
}

function sameHealthRevision(left: ModelSourceRecord | null, right: ModelSourceRecord): boolean {
  return left !== null
    && left.source.sourceId === right.source.sourceId
    && left.source.activeSourceRevision.sourceRevisionId === right.source.activeSourceRevision.sourceRevisionId
    && left.source.activeModelRevision.modelRevisionId === right.source.activeModelRevision.modelRevisionId
    && left.source.activeSourceRevision.credentialVersion === right.source.activeSourceRevision.credentialVersion
    && left.source.updatedAt === right.source.updatedAt;
}

function toDto(record: ModelSourceRecord, limits: EffectiveModelLimits | undefined): ModelSourceDto {
  return {
    accessMode: record.source.activeSourceRevision.accessMode,
    activeModel: {
      capability: record.source.activeModelRevision.capability,
      ...(record.source.activeModelRevision.compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent: record.source.activeModelRevision.compactionThresholdPercent }),
      ...(record.source.activeModelRevision.contextWindow === undefined ? {} : { contextWindow: record.source.activeModelRevision.contextWindow }),
      ...(limits === undefined ? {} : { effective: limits }),
      id: record.source.activeModelRevision.modelId,
      ...(record.source.activeModelRevision.maxOutputTokens === undefined ? {} : { maxOutputTokens: record.source.activeModelRevision.maxOutputTokens }),
      revisionId: record.source.activeModelRevision.modelRevisionId,
      ...(record.source.activeModelRevision.thinkingEffort === undefined ? {} : { thinkingEffort: record.source.activeModelRevision.thinkingEffort }),
    },
    activeSourceRevisionId: record.source.activeSourceRevision.sourceRevisionId,
    ...(record.source.activeSourceRevision.kind === "generic-openai" && record.baseUrl !== undefined ? { baseUrl: record.baseUrl } : {}),
    credential: { configured: true, version: record.source.activeSourceRevision.credentialVersion },
    displayName: record.source.activeSourceRevision.displayName,
    kind: record.source.activeSourceRevision.kind,
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
    ...(record.lastValidatedAt === undefined ? {} : { lastValidatedAt: record.lastValidatedAt }),
    order: record.order,
    primary: record.primary,
    protocol: record.source.activeSourceRevision.protocol,
    ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
    sourceId: record.source.sourceId,
    status: record.source.status,
  };
}
