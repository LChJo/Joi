import { DomainError } from "../errors.js";

export type PartnerKind = "local-pi" | "a2a";
export type PartnerStatus = "ACTIVE" | "DISABLED" | "DELETED";

export interface PartnerRevision {
  capabilities: string[];
  createdAt: string;
  displayName: string;
  kind: PartnerKind;
  partnerId: string;
  partnerRevisionId: string;
  promptRef?: string;
  provenance: {
    capabilities: "local" | "card";
    displayName: "local" | "card";
    skills: "local" | "card";
    tools: "local";
    workspace: "local";
  };
  registryRevision: number;
  skills: string[];
  status: PartnerStatus;
  tools: string[];
  workspaceRef?: string;
}

export interface CreatePartnerRevisionInput {
  capabilities: string[];
  createdAt: string;
  displayName: string;
  kind: PartnerKind;
  partnerId: string;
  partnerRevisionId: string;
  promptRef?: string;
  registryRevision: number;
  skills: string[];
  tools: string[];
  workspaceRef?: string;
}

function text(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) throw new DomainError(code, "Partner value is invalid.");
  return normalized;
}

function strings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function createPartnerRevision(input: CreatePartnerRevisionInput): PartnerRevision {
  if (!Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1) {
    throw new DomainError("partner_registry_revision_invalid", "Partner registry revision is invalid.");
  }
  const promptRef = input.promptRef?.trim();
  const workspaceRef = input.workspaceRef?.trim();
  return {
    capabilities: strings(input.capabilities),
    createdAt: input.createdAt,
    displayName: text(input.displayName, "partner_name_invalid"),
    kind: input.kind,
    partnerId: text(input.partnerId, "partner_id_invalid"),
    partnerRevisionId: text(input.partnerRevisionId, "partner_revision_id_invalid"),
    ...(promptRef === undefined || promptRef === "" ? {} : { promptRef }),
    provenance: {
      capabilities: "local",
      displayName: "local",
      skills: "local",
      tools: "local",
      workspace: "local",
    },
    registryRevision: input.registryRevision,
    skills: strings(input.skills),
    status: "ACTIVE",
    tools: strings(input.tools),
    ...(workspaceRef === undefined || workspaceRef === "" ? {} : { workspaceRef }),
  };
}

export function mergeA2aCardRevision(
  current: PartnerRevision,
  input: {
    card: { capabilities: string[]; displayName: string; skills: string[]; tools?: string[]; workspaceRef?: string };
    createdAt: string;
    partnerRevisionId: string;
    registryRevision: number;
  },
): PartnerRevision {
  if (current.kind !== "a2a") throw new DomainError("partner_card_kind_invalid", "Only A2A partners have Cards.");
  if (input.registryRevision <= current.registryRevision) throw new DomainError("partner_registry_revision_stale", "Partner registry revision must increase.");
  return {
    ...current,
    capabilities: strings(input.card.capabilities),
    createdAt: input.createdAt,
    displayName: text(input.card.displayName, "partner_name_invalid"),
    partnerRevisionId: text(input.partnerRevisionId, "partner_revision_id_invalid"),
    provenance: {
      ...current.provenance,
      capabilities: "card",
      displayName: "card",
      skills: "card",
    },
    registryRevision: input.registryRevision,
    skills: strings(input.card.skills),
  };
}

export function toPublicPartner(revision: PartnerRevision) {
  return {
    capabilities: [...revision.capabilities],
    displayName: revision.displayName,
    kind: revision.kind,
    partnerId: revision.partnerId,
    partnerRevisionId: revision.partnerRevisionId,
    registryRevision: revision.registryRevision,
    skills: [...revision.skills],
    status: revision.status,
    tools: [...revision.tools],
  };
}
