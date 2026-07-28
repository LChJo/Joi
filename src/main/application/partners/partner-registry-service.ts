import type { PartnerDto } from "../../../shared/joi.js";
import { DomainError } from "../../domain/errors.js";
import {
  createPartnerRevision,
  mergeA2aCardRevision,
  toPublicPartner,
  type PartnerKind,
  type PartnerRevision,
} from "../../domain/partners/partner.js";
import type { Clock, IdGenerator } from "../ports/runtime-store.js";
import type { AppendPartnerRevisionInput, PartnerRegistryRepository } from "../ports/partner-registry.js";

interface PartnerFields {
  capabilities: string[];
  displayName: string;
  promptRef?: string;
  skills: string[];
  tools: string[];
  workspaceRef?: string;
}

export class PartnerRegistryService {
  constructor(private readonly dependencies: { clock: Clock; ids: IdGenerator; repository: PartnerRegistryRepository }) {}

  async add(input: PartnerFields & { kind: PartnerKind }): Promise<PartnerDto> {
    const partnerId = this.dependencies.ids.next("partner");
    const validated = createPartnerRevision({
      ...input,
      createdAt: this.dependencies.clock.now().toISOString(),
      partnerId,
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      registryRevision: 1,
    });
    return toPublicPartner(await this.dependencies.repository.append(withoutRegistryRevision(validated)));
  }

  async update(partnerId: string, input: PartnerFields): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    const validated = createPartnerRevision({
      capabilities: input.capabilities,
      createdAt: this.dependencies.clock.now().toISOString(),
      displayName: input.displayName,
      kind: current.kind,
      partnerId,
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      ...((input.promptRef ?? current.promptRef) === undefined ? {} : { promptRef: input.promptRef ?? current.promptRef }),
      registryRevision: current.registryRevision + 1,
      skills: input.skills,
      tools: input.tools,
      ...((input.workspaceRef ?? current.workspaceRef) === undefined ? {} : { workspaceRef: input.workspaceRef ?? current.workspaceRef }),
    });
    return toPublicPartner(await this.dependencies.repository.append(withoutRegistryRevision(validated)));
  }

  async refreshA2aCard(partnerId: string, card: { capabilities: string[]; displayName: string; skills: string[]; tools?: string[]; workspaceRef?: string }): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    const revision = mergeA2aCardRevision(current, {
      card,
      createdAt: this.dependencies.clock.now().toISOString(),
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      registryRevision: current.registryRevision + 1,
    });
    return toPublicPartner(await this.dependencies.repository.append(withoutRegistryRevision(revision)));
  }

  async disable(partnerId: string): Promise<PartnerDto> {
    const current = await this.#active(partnerId);
    return toPublicPartner(await this.dependencies.repository.append({
      ...withoutRegistryRevision(current),
      createdAt: this.dependencies.clock.now().toISOString(),
      partnerRevisionId: this.dependencies.ids.next("partner_revision"),
      status: "DISABLED",
    }));
  }

  async list(): Promise<PartnerDto[]> {
    return (await this.dependencies.repository.listActive()).map(toPublicPartner);
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
