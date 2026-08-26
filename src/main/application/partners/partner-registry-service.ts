import type { ModelSourceDto, PartnerConfigurationDto, PartnerDto } from "../../../shared/joi.js";
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
import type { PartnerSkillCatalog } from "../ports/partner-skills.js";
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
  /** Rejected compatibility fields; Partner templates never own cwd. */
  cwd?: string;
  workspaceRef?: string;
}

interface PartnerUpdateFields extends Omit<PartnerFields, "engineModelId" | "modelIdOverride" | "modelSourceId"> {
  engineModelId?: string | null;
  modelIdOverride?: string | null;
  modelSourceId?: string | null;
}

export class PartnerRegistryService {
  constructor(private readonly dependencies: {
    clock: Clock;
    events?: DurableUiEventEmitter;
    ids: IdGenerator;
    knowledge?: Pick<PartnerKnowledgeService, "count" | "duplicateTo">;
    modelSources?: { list(): Promise<ModelSourceDto[]> };
    prompts?: PartnerPromptStore;
    repository: PartnerRegistryRepository;
    skills?: Pick<PartnerSkillCatalog, "listForEngine"> & Partial<Pick<PartnerSkillCatalog, "validateRefs">>;
  }) {}

  async add(input: PartnerFields & { createdBy?: PartnerCreator; kind: PartnerKind }): Promise<PartnerDto> {
    assertNoWorkspace(input);
    this.#assertLocalSkills(input.kind, input.engine ?? "pi-core", input.skills, input.tools);
    await this.#assertModelConfiguration(input.kind, input.engine ?? "pi-core", input.modelSourceId, input.modelIdOverride);
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

  async update(partnerId: string, input: PartnerUpdateFields): Promise<PartnerDto> {
    assertNoWorkspace(input);
    const current = await this.#active(partnerId);
    this.#assertLocalSkills(current.kind, input.engine ?? current.engine, input.skills, input.tools);
    const engine = input.engine ?? current.engine;
    const engineModelId = explicitValue(input.engineModelId, current.engineModelId);
    const modelIdOverride = explicitValue(input.modelIdOverride, current.modelIdOverride);
    const modelSourceId = explicitValue(input.modelSourceId, current.modelSourceId);
    await this.#assertModelConfiguration(current.kind, engine, modelSourceId, modelIdOverride);
    const createdAt = this.dependencies.clock.now().toISOString();
    const promptRef = await this.#promptRef(input, createdAt) ?? current.promptRef;
    const description = input.description ?? current.description;
    const validated = createPartnerRevision({
      capabilities: input.capabilities,
      createdAt,
      createdBy: current.createdBy,
      ...(description === undefined ? {} : { description }),
      displayName: input.displayName,
      engine,
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
    });
    const revision = await this.dependencies.repository.append(withoutRegistryRevision(validated));
    await this.#changed(revision);
    return this.#public(revision);
  }

  /** Replaces only the selected local skill references and creates a new immutable revision. */
  async setSkills(partnerId: string, skills: string[]): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    if (current.kind !== "local-pi") throw new DomainError("partner_skills_not_supported", "Only local partners can use local skills.");
    return this.update(partnerId, {
      capabilities: [...current.capabilities],
      ...(current.description === undefined ? {} : { description: current.description }),
      displayName: current.displayName,
      engine: current.engine,
      ...(current.engineModelId === undefined ? {} : { engineModelId: current.engineModelId }),
      ...(current.modelIdOverride === undefined ? {} : { modelIdOverride: current.modelIdOverride }),
      ...(current.modelSourceId === undefined ? {} : { modelSourceId: current.modelSourceId }),
      skills,
      tools: [...current.tools],
    });
  }

  /** Re-pins only the model source and appends a new immutable local-partner revision. */
  async setModel(partnerId: string, model: { modelIdOverride: string; modelSourceId: string }): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    if (current.kind !== "local-pi") throw new DomainError("partner_model_not_supported", "Only local partners can pin a model source.");
    return this.update(partnerId, {
      capabilities: [...current.capabilities],
      ...(current.description === undefined ? {} : { description: current.description }),
      displayName: current.displayName,
      engine: current.engine,
      ...(current.engineModelId === undefined ? {} : { engineModelId: current.engineModelId }),
      modelIdOverride: model.modelIdOverride,
      modelSourceId: model.modelSourceId,
      skills: [...current.skills],
      tools: [...current.tools],
    });
  }

  async refreshA2aCard(partnerId: string, card: { capabilities: string[]; displayName: string; skills: string[]; tools?: string[] }): Promise<PartnerDto> {
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
    this.#assertLocalSkills(current.kind, current.engine, current.skills, current.tools);
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
    const configuration = this.#configuration(revision);
    if (configuration !== undefined) {
      throw new DomainError(configuration.reasonCodes[0] ?? "partner_configuration_invalid", "Partner configuration requires correction before dispatch.");
    }
    return { partnerId, partnerRevisionId: revision.partnerRevisionId, registryRevision: revision.registryRevision };
  }

  async #active(partnerId: string): Promise<PartnerRevision> {
    const current = await this.dependencies.repository.getActive(partnerId);
    if (current === null) throw new DomainError("partner_not_found", "Partner was not found.");
    return current;
  }

  #assertLocalSkills(kind: PartnerKind, engine: PartnerEngine, skills: string[], tools: string[]): void {
    if (kind !== "local-pi" || this.dependencies.skills === undefined) return;
    this.#validateLocalSkills(engine, skills, tools);
  }

  async #assertModelConfiguration(kind: PartnerKind, engine: PartnerEngine, sourceId?: string, modelId?: string): Promise<void> {
    if (kind !== "local-pi" || engine !== "pi-core" || this.dependencies.modelSources === undefined) return;
    if (sourceId === undefined && modelId === undefined) return;
    const ready = (await this.dependencies.modelSources.list())
      .filter((source) => source.status === "READY")
      .sort((left, right) => left.order - right.order);
    const source = sourceId === undefined ? ready[0] : ready.find((candidate) => candidate.sourceId === sourceId);
    if (source === undefined) throw new DomainError("partner_model_source_not_ready", "The selected partner model source is not ready.");
    if (modelId !== undefined && modelId !== source.activeModel.id) {
      throw new DomainError("partner_model_override_not_ready", "The selected model is not active on the partner model source.");
    }
  }

  #validateLocalSkills(engine: PartnerEngine, skills: string[], tools: string[]): void {
    if (this.dependencies.skills === undefined) return;
    if (this.dependencies.skills.validateRefs !== undefined) this.dependencies.skills.validateRefs(engine, skills);
    else {
      const available = new Set(this.dependencies.skills.listForEngine(engine).map((item) => item.id));
      if (skills.some((skill) => !available.has(skill))) {
        throw new DomainError("partner_skill_not_available", "Selected partner skill is not available for this engine.");
      }
    }
    if (engine === "pi-core" && skills.length > 0 && tools.length > 0 && !tools.includes("read")) {
      throw new DomainError("partner_skill_requires_read", "Pi Skills require the read tool when the tool list is narrowed.");
    }
  }

  async #public(revision: PartnerRevision): Promise<PartnerDto> {
    const configuration = this.#configuration(revision);
    return {
      ...toPublicPartner(revision),
      ...(configuration === undefined ? {} : { configuration }),
      inFlightCount: await this.dependencies.repository.countInFlight(revision.partnerId),
      knowledgeDocCount: this.dependencies.knowledge === undefined ? 0 : await this.dependencies.knowledge.count(revision.partnerId),
      lifecyclePolicy: "DRAIN",
    };
  }

  #configuration(revision: PartnerRevision): PartnerConfigurationDto | undefined {
    if (revision.kind !== "local-pi" || this.dependencies.skills === undefined) return undefined;
    try {
      this.#validateLocalSkills(revision.engine, revision.skills, revision.tools);
      return undefined;
    } catch (error) {
      const code = error instanceof DomainError && /^partner_[a-z0-9_]+$/u.test(error.code)
        ? error.code
        : "partner_configuration_invalid";
      return { reasonCodes: [code], status: "ACTION_REQUIRED" };
    }
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
  };
}

function assertNoWorkspace(input: { cwd?: unknown; workspaceRef?: unknown }): void {
  if (input.cwd !== undefined || input.workspaceRef !== undefined) {
    throw new DomainError("partner_workspace_forbidden", "Partner templates cannot own a workspace.");
  }
}

function explicitValue(value: string | null | undefined, fallback: string | undefined): string | undefined {
  if (value === null) return undefined;
  return value ?? fallback;
}
