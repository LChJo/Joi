import type { PartnerDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import {
  createPartnerRevision,
  mergeA2aCardRevision,
  toPublicPartner,
  type PartnerCreator,
  type PartnerEngine,
  type PartnerKind,
  type PartnerRevision,
} from "../../domain/partners/partner.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";
import type { PartnerPromptStore } from "../ports/partner-execution.js";
import type { AppendPartnerRevisionInput, PartnerRegistryRepository } from "../ports/partner-registry.js";
import type { PartnerKnowledgeService } from "./partner-knowledge-service.js";

interface PartnerFields {
  capabilities: string[];
  description?: string;
  displayName: string;
  engine?: PartnerEngine;
  engineModelId?: string;
  modelIdOverride?: string;
  modelSourceId?: string;
  prompt?: string;
  promptRef?: string;
  skills: string[];
  tools: string[];
  workspaceRef?: string;
}

export class PartnerRegistryService {
  constructor(private readonly dependencies: {
    clock: Clock;
    events?: DurableUiEventEmitter;
    ids: IdGenerator;
    knowledge?: Pick<PartnerKnowledgeService, "count" | "duplicateTo">;
    prompts?: PartnerPromptStore;
    repository: PartnerRegistryRepository;
  }) {}

  async add(input: PartnerFields & { createdBy?: PartnerCreator; kind: PartnerKind }): Promise<PartnerDto> {
    const partnerId = this.dependencies.ids.next("partner");
    const createdAt = this.dependencies.clock.now().toISOString();
    const promptRef = await this.#promptRef(input, createdAt);
    const validated = createPartnerRevision({
      ...input,
      createdAt,
      partnerId,
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      ...(promptRef === undefined ? {} : { promptRef }),
      registryRevision: 1,
    });
    const revision = await this.dependencies.repository.append(withoutRegistryRevision(validated));
    await this.#changed(revision);
    return this.#public(revision);
  }

  async update(partnerId: string, input: PartnerFields): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    const createdAt = this.dependencies.clock.now().toISOString();
    const promptRef = await this.#promptRef(input, createdAt) ?? current.promptRef;
    const description = input.description ?? current.description;
    const engineModelId = input.engineModelId ?? current.engineModelId;
    const modelIdOverride = input.modelIdOverride ?? current.modelIdOverride;
    const modelSourceId = input.modelSourceId ?? current.modelSourceId;
    const workspaceRef = input.workspaceRef ?? current.workspaceRef;
    const validated = createPartnerRevision({
      capabilities: input.capabilities,
      createdAt,
      createdBy: current.createdBy,
      ...(description === undefined ? {} : { description }),
      displayName: input.displayName,
      engine: input.engine ?? current.engine,
      ...(engineModelId === undefined ? {} : { engineModelId }),
      kind: current.kind,
      ...(modelIdOverride === undefined ? {} : { modelIdOverride }),
      ...(modelSourceId === undefined ? {} : { modelSourceId }),
      partnerId,
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      ...(promptRef === undefined ? {} : { promptRef }),
      registryRevision: current.registryRevision + 1,
      skills: input.skills,
      tools: input.tools,
      ...(workspaceRef === undefined ? {} : { workspaceRef }),
    });
    const revision = await this.dependencies.repository.append(withoutRegistryRevision(validated));
    await this.#changed(revision);
    return this.#public(revision);
  }

  async refreshA2aCard(partnerId: string, card: { capabilities: string[]; displayName: string; skills: string[]; tools?: string[]; workspaceRef?: string }): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    const revision = mergeA2aCardRevision(current, {
      card,
      createdAt: this.dependencies.clock.now().toISOString(),
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      registryRevision: current.registryRevision + 1,
    });
    const saved = await this.dependencies.repository.append(withoutRegistryRevision(revision));
    await this.#changed(saved);
    return this.#public(saved);
  }

  async enable(partnerId: string): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    if (current.status === "DELETED") throw new DomainError("partner_not_found", "Partner was not found.");
    if (current.status === "ACTIVE") return this.#public(current);
    const revision = await this.dependencies.repository.append({
      ...withoutRegistryRevision(current),
      createdAt: this.dependencies.clock.now().toISOString(),
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      status: "ACTIVE",
    });
    await this.#changed(revision);
    return this.#public(revision);
  }

  async disable(partnerId: string): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    if (current.status === "DELETED") throw new DomainError("partner_not_found", "Partner was not found.");
    if (current.status === "DISABLED") return this.#public(current);
    const revision = await this.dependencies.repository.append({
      ...withoutRegistryRevision(current),
      createdAt: this.dependencies.clock.now().toISOString(),
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      status: "DISABLED",
    });
    await this.#changed(revision);
    return this.#public(revision);
  }

  async delete(partnerId: string): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    if (current.status === "DELETED") return this.#public(current);
    if (current.status !== "DISABLED") throw new DomainError("partner_disable_before_delete", "Partner must be disabled before deletion.");
    const inFlightCount = await this.dependencies.repository.countInFlight(partnerId);
    if (inFlightCount > 0) throw new DomainError("partner_delete_in_flight", "Partner still has in-flight dispatch attempts.");
    const revision = await this.dependencies.repository.append({
      ...withoutRegistryRevision(current),
      createdAt: this.dependencies.clock.now().toISOString(),
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      status: "DELETED",
    });
    await this.#changed(revision);
    return this.#public(revision);
  }

  async duplicate(partnerId: string): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    if (current.status === "DELETED") throw new DomainError("partner_not_found", "Partner was not found.");
    const newPartnerId = this.dependencies.ids.next("partner");
    const createdAt = this.dependencies.clock.now().toISOString();
    let promptRef = current.promptRef;
    if (promptRef !== undefined && this.dependencies.prompts !== undefined) {
      const body = await this.dependencies.prompts.read(promptRef);
      if (body !== null) {
        const copiedRef = this.dependencies.ids.next("partner_prompt");
        await this.dependencies.prompts.save({ body, createdAt, promptRef: copiedRef });
        promptRef = copiedRef;
      }
    }
    const validated = createPartnerRevision({
      capabilities: [...current.capabilities],
      createdAt,
      createdBy: "user",
      ...(current.description === undefined ? {} : { description: current.description }),
      displayName: copyName(current.displayName),
      engine: current.engine,
      ...(current.engineModelId === undefined ? {} : { engineModelId: current.engineModelId }),
      kind: current.kind,
      ...(current.modelIdOverride === undefined ? {} : { modelIdOverride: current.modelIdOverride }),
      ...(current.modelSourceId === undefined ? {} : { modelSourceId: current.modelSourceId }),
      partnerId: newPartnerId,
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      ...(promptRef === undefined ? {} : { promptRef }),
      registryRevision: 1,
      skills: [...current.skills],
      tools: [...current.tools],
      ...(current.workspaceRef === undefined ? {} : { workspaceRef: current.workspaceRef }),
    });
    const revision = await this.dependencies.repository.append(withoutRegistryRevision(validated));
    if (this.dependencies.knowledge !== undefined) await this.dependencies.knowledge.duplicateTo(partnerId, newPartnerId);
    await this.#changed(revision);
    return this.#public(revision);
  }

  async inspect(partnerId: string): Promise<PartnerDto> {
    return this.#public(await this.#active(partnerId));
  }

  async list(): Promise<PartnerDto[]> {
    return Promise.all((await this.dependencies.repository.listActive())
      .filter((revision) => revision.status !== "DELETED")
      .map((revision) => this.#public(revision)));
  }

  async pinForDispatch(partnerId: string): Promise<{ partnerId: string; partnerRevisionId: string; registryRevision: number }> {
    const revision = await this.#active(partnerId);
    if (revision.status !== "ACTIVE") throw new DomainError("partner_not_available", "Partner is not available.");
    return { partnerId, partnerRevisionId: revision.partnerRevisionId, registryRevision: revision.registryRevision };
  }

  async #active(partnerId: string): Promise<PartnerRevision> {
    const current = await this.dependencies.repository.getActive(partnerId);
    if (current === null) throw new DomainError("partner_not_found", "Partner was not found.");
    return current;
  }

  async #public(revision: PartnerRevision): Promise<PartnerDto> {
    return {
      ...toPublicPartner(revision),
      inFlightCount: await this.dependencies.repository.countInFlight(revision.partnerId),
      knowledgeDocCount: this.dependencies.knowledge === undefined ? 0 : await this.dependencies.knowledge.count(revision.partnerId),
      lifecyclePolicy: "DRAIN",
    };
  }

  async #promptRef(input: Pick<PartnerFields, "prompt" | "promptRef">, createdAt: string): Promise<string | undefined> {
    if (input.prompt === undefined) return input.promptRef;
    const body = input.prompt.trim();
    if (body.length === 0) throw new DomainError("partner_prompt_empty", "Partner prompt must not be empty.");
    if (body.length > 32_000) throw new DomainError("partner_prompt_too_large", "Partner prompt is too large.");
    if (this.dependencies.prompts === undefined) throw new DomainError("partner_prompt_store_unavailable", "Partner prompt storage is unavailable.");
    const promptRef = this.dependencies.ids.next("partner_prompt");
    await this.dependencies.prompts.save({ body, createdAt, promptRef });
    return promptRef;
  }

  async #changed(revision: PartnerRevision): Promise<void> {
    await this.dependencies.events?.emit("partner.registry.changed", revision.partnerId, {
      partnerId: revision.partnerId,
      partnerRevisionId: revision.partnerRevisionId,
      registryRevision: revision.registryRevision,
      status: revision.status,
    });
  }
}

function copyName(displayName: string): string {
  const marker = "（副本）";
  return `${displayName.slice(0, 240 - marker.length)}${marker}`;
}

function withoutRegistryRevision(revision: PartnerRevision): AppendPartnerRevisionInput {
  return {
    capabilities: [...revision.capabilities],
    createdAt: revision.createdAt,
    createdBy: revision.createdBy,
    ...(revision.description === undefined ? {} : { description: revision.description }),
    displayName: revision.displayName,
    engine: revision.engine,
    ...(revision.engineModelId === undefined ? {} : { engineModelId: revision.engineModelId }),
    kind: revision.kind,
    ...(revision.modelIdOverride === undefined ? {} : { modelIdOverride: revision.modelIdOverride }),
    ...(revision.modelSourceId === undefined ? {} : { modelSourceId: revision.modelSourceId }),
    partnerId: revision.partnerId,
    partnerRevisionId: revision.partnerRevisionId,
    ...(revision.promptRef === undefined ? {} : { promptRef: revision.promptRef }),
    provenance: { ...revision.provenance },
    skills: [...revision.skills],
    status: revision.status,
    tools: [...revision.tools],
    ...(revision.workspaceRef === undefined ? {} : { workspaceRef: revision.workspaceRef }),
  };
}
