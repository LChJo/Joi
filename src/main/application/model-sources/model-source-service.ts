import type { ModelSourceDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import {
  createModelSource,
  reviseModelSource,
  type ModelSourceKind,
} from "../../domain/model-sources/model-source.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type {
  ModelSourceCatalog,
  ModelSourceEndpointPolicy,
  ModelSourceRecord,
  ModelSourceRepository,
  ModelSourceSecretStore,
  ModelSourceValidator,
} from "../ports/model-source-ports.js";

export interface CreateModelSourceRequest {
  apiKey: string;
  baseUrl?: string;
  displayName?: string;
  kind: ModelSourceKind;
  modelId?: string;
}

export interface UpdateModelSourceRequest {
  apiKey?: string;
  baseUrl?: string;
  displayName?: string;
  modelId?: string;
}

export class ModelSourceService {
  constructor(private readonly dependencies: {
    catalog: ModelSourceCatalog;
    clock: Clock;
    endpointPolicy: ModelSourceEndpointPolicy;
    ids: IdGenerator;
    repository: ModelSourceRepository;
    secrets: ModelSourceSecretStore;
    validator: ModelSourceValidator;
  }) {}

  async create(input: CreateModelSourceRequest): Promise<ModelSourceDto> {
    const catalog = this.dependencies.catalog.resolve(input.kind, input.modelId);
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
      createdAt: now,
      credentialRef: providerId,
      credentialVersion,
      displayName,
      kind: input.kind,
      modelCapability: catalog.capability,
      modelId: catalog.modelId,
      modelRevisionId: this.dependencies.ids.next("model_revision"),
      sourceId,
      sourceRevisionId: this.dependencies.ids.next("source_revision"),
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
    return toDto(record);
  }

  async list(): Promise<ModelSourceDto[]> {
    return (await this.dependencies.repository.list()).map(toDto);
  }

  async update(sourceId: string, input: UpdateModelSourceRequest): Promise<ModelSourceDto> {
    const current = await this.#get(sourceId);
    const kind = current.source.activeSourceRevision.kind;
    const catalog = this.dependencies.catalog.resolve(kind, input.modelId ?? current.source.activeModelRevision.modelId);
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
    const updatedAt = this.dependencies.clock.now().toISOString();
    const source = reviseModelSource(current.source, {
      credentialVersion,
      displayName,
      modelCapability: catalog.capability,
      modelId: catalog.modelId,
      modelRevisionId: this.dependencies.ids.next("model_revision"),
      sourceRevisionId: this.dependencies.ids.next("source_revision"),
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
    return toDto(revised);
  }

  async disable(sourceId: string): Promise<ModelSourceDto> {
    const current = await this.#get(sourceId);
    const updatedAt = this.dependencies.clock.now().toISOString();
    const disabled: ModelSourceRecord = {
      ...withoutHealthReason(current),
      source: { ...current.source, status: "DISABLED", updatedAt },
    };
    await this.dependencies.repository.save(disabled);
    return toDto(disabled);
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
    await this.dependencies.repository.save(validating);
    const result = await this.dependencies.validator.validate(validating);
    const updated: ModelSourceRecord = {
      ...withoutHealthReason(validating),
      lastValidatedAt: result.validatedAt,
      ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
      source: { ...validating.source, status: result.status, updatedAt: result.validatedAt },
    };
    await this.dependencies.repository.save(updated);
    return toDto(updated);
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
}

function withoutHealthReason(record: ModelSourceRecord): Omit<ModelSourceRecord, "reasonCode"> {
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

function toDto(record: ModelSourceRecord): ModelSourceDto {
  return {
    activeModel: {
      capability: record.source.activeModelRevision.capability,
      id: record.source.activeModelRevision.modelId,
      revisionId: record.source.activeModelRevision.modelRevisionId,
    },
    activeSourceRevisionId: record.source.activeSourceRevision.sourceRevisionId,
    ...(record.source.activeSourceRevision.kind === "generic-openai" && record.baseUrl !== undefined ? { baseUrl: record.baseUrl } : {}),
    credential: { configured: true, version: record.source.activeSourceRevision.credentialVersion },
    displayName: record.source.activeSourceRevision.displayName,
    kind: record.source.activeSourceRevision.kind,
    ...(record.lastValidatedAt === undefined ? {} : { lastValidatedAt: record.lastValidatedAt }),
    order: record.order,
    primary: record.primary,
    ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
    sourceId: record.source.sourceId,
    status: record.source.status,
  };
}
