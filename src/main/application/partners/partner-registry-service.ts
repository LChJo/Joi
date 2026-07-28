import type { PartnerDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import {
  createPartnerRevision,
  mergeA2aCardRevision,
  toPublicPartner,
  type PartnerKind,
  type PartnerRevision,
} from "../../domain/partners/partner.js";
import type { Clock, DurableUiEventEmitter, IdGenerator } from "../ports/runtime-store.js";
import type { PartnerPromptStore } from "../ports/partner-execution.js";
import type { AppendPartnerRevisionInput, PartnerRegistryRepository } from "../ports/partner-registry.js";

interface PartnerFields {
  capabilities: string[];
  displayName: string;
  prompt?: string;
  promptRef?: string;
  skills: string[];
  tools: string[];
  workspaceRef?: string;
}

export class PartnerRegistryService {
  constructor(private readonly dependencies: { clock: Clock; events?: DurableUiEventEmitter; ids: IdGenerator; prompts?: PartnerPromptStore; repository: PartnerRegistryRepository }) {}

  async add(input: PartnerFields & { kind: PartnerKind }): Promise<PartnerDto> {
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
    const validated = createPartnerRevision({
      capabilities: input.capabilities,
      createdAt,
      displayName: input.displayName,
      kind: current.kind,
      partnerId,
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      ...(promptRef === undefined ? {} : { promptRef }),
      registryRevision: current.registryRevision + 1,
      skills: input.skills,
      tools: input.tools,
      ...((input.workspaceRef ?? current.workspaceRef) === undefined ? {} : { workspaceRef: input.workspaceRef ?? current.workspaceRef }),
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

function withoutRegistryRevision(revision: PartnerRevision): AppendPartnerRevisionInput {
  return {
    capabilities: [...revision.capabilities],
    createdAt: revision.createdAt,
    displayName: revision.displayName,
    kind: revision.kind,
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
