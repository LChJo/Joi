import { DomainError } from "../errors.js";

export type PartnerKind = "local-pi" | "a2a";
export type PartnerStatus = "ACTIVE" | "DISABLED" | "DELETED";
export type PartnerEngine = "claude-code" | "codex" | "pi-core";
export type PartnerCreator = "joi" | "user";

export interface PartnerRevision {
  capabilities: string[];
  createdAt: string;
  createdBy: PartnerCreator;
  description?: string;
  displayName: string;
  engine: PartnerEngine;
  engineModelId?: string;
  kind: PartnerKind;
  modelIdOverride?: string;
  modelSourceId?: string;
  partnerId: string;
  partnerRevisionId: string;
  promptRef?: string;
  provenance: {
    capabilities: "local" | "card";
    description: "local" | "card";
    displayName: "local" | "card";
    skills: "local" | "card";
    tools: "local";
  };
  registryRevision: number;
  skills: string[];
  status: PartnerStatus;
  tools: string[];
}

export interface CreatePartnerRevisionInput {
  capabilities: string[];
  createdAt: string;
  createdBy?: PartnerCreator;
  description?: string;
  displayName: string;
  engine?: PartnerEngine;
  engineModelId?: string;
  kind: PartnerKind;
  modelIdOverride?: string;
  modelSourceId?: string;
  partnerId: string;
  partnerRevisionId: string;
  promptRef?: string;
  registryRevision: number;
  skills: string[];
  tools: string[];
}

function text(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 240) throw new DomainError(code, "Partner value is invalid.");
  return normalized;
}

function optionalText(value: string | undefined, maxLength: number, code: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  if (normalized.length > maxLength) throw new DomainError(code, "Partner value is too large.");
  return normalized;
}

function strings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export function createPartnerRevision(input: CreatePartnerRevisionInput): PartnerRevision {
  if (!Number.isSafeInteger(input.registryRevision) || input.registryRevision < 1) {
    throw new DomainError("partner_registry_revision_invalid", "Partner registry revision is invalid.");
  }
  const engine = input.engine ?? "pi-core";
  if (input.kind === "a2a" && engine !== "pi-core") {
    throw new DomainError("partner_engine_kind_invalid", "Only local partners run on a local engine.");
  }
  // Local CLI engines (claude-code / codex) run on the user's own login, so the
  // model id is only an optional override; pi-core takes its model from sources.
  const engineModelId = optionalText(input.engineModelId, 240, "partner_engine_model_invalid");
  const promptRef = input.promptRef?.trim();
  const description = optionalText(input.description, 600, "partner_description_invalid");
  const modelIdOverride = optionalText(input.modelIdOverride, 240, "partner_model_override_invalid");
  const modelSourceId = optionalText(input.modelSourceId, 240, "partner_model_source_invalid");
  return {
    capabilities: strings(input.capabilities),
    createdAt: input.createdAt,
    createdBy: input.createdBy ?? "user",
    ...(description === undefined ? {} : { description }),
    displayName: text(input.displayName, "partner_name_invalid"),
    engine,
    ...(engineModelId === undefined ? {} : { engineModelId }),
    kind: input.kind,
    ...(modelIdOverride === undefined ? {} : { modelIdOverride }),
    ...(modelSourceId === undefined ? {} : { modelSourceId }),
    partnerId: text(input.partnerId, "partner_id_invalid"),
    partnerRevisionId: text(input.partnerRevisionId, "partner_revision_id_invalid"),
    ...(promptRef === undefined || promptRef === "" ? {} : { promptRef }),
    provenance: {
      capabilities: "local",
      description: "local",
      displayName: "local",
      skills: "local",
      tools: "local",
    },
    registryRevision: input.registryRevision,
    skills: strings(input.skills),
    status: "ACTIVE",
    tools: strings(input.tools),
  };
}

export function mergeA2aCardRevision(
  current: PartnerRevision,
  input: {
    card: { capabilities: string[]; displayName: string; skills: string[]; tools?: string[] };
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
    registryRevision: revision.registryRevision,
    skills: [...revision.skills],
    status: revision.status,
    tools: [...revision.tools],
  };
}
