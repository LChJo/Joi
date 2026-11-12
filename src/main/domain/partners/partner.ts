import { DomainError } from "../errors.js";
import type { WorkAccessMode } from "../work/work.js";
import { PI_AGENT_BROWSER_TOOLS } from "./pi-extension-tools.js";

export type PartnerKind = "local-pi" | "a2a";
export type PartnerStatus = "ACTIVE" | "DISABLED" | "DELETED";
export type PartnerEngine = "claude-code" | "codex" | "pi-core";
export type PartnerCreator = "joi" | "user";
export type ToolPolicyMode = "ALL" | "CUSTOM";
export interface CodexPermissions {
  approvalPolicy: "never";
  networkAccessEnabled: boolean;
  sandboxMode: "read-only" | "workspace-write";
  webSearchMode: "disabled" | "cached" | "live";
}

export const DEFAULT_CODEX_PERMISSIONS: CodexPermissions = {
  approvalPolicy: "never",
  networkAccessEnabled: true,
  sandboxMode: "workspace-write",
  webSearchMode: "live",
};

export interface PartnerRevision {
  capabilities: string[];
  createdAt: string;
  createdBy: PartnerCreator;
  codexPermissions?: CodexPermissions;
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
  toolPolicyMode?: ToolPolicyMode;
  tools: string[];
}

export interface CreatePartnerRevisionInput {
  capabilities: string[];
  createdAt: string;
  createdBy?: PartnerCreator;
  codexPermissions?: CodexPermissions;
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
  toolPolicyMode?: ToolPolicyMode;
  tools: string[];
}

export function legacyToolPolicyMode(tools: readonly string[]): ToolPolicyMode {
  return tools.length === 0 ? "ALL" : "CUSTOM";
}

/** Local execution always has a working directory, including text-only tasks. */
export function minimumLocalWorkAccess(revision: PartnerRevision): WorkAccessMode {
  if (revision.kind !== "local-pi") return "NONE";
  if (revision.engine === "codex") return revision.codexPermissions?.sandboxMode === "read-only" ? "READ" : "WRITE";
  if ((revision.toolPolicyMode ?? legacyToolPolicyMode(revision.tools)) === "ALL") return "WRITE";
  return revision.tools.some((name) => ["bash", "edit", "write", "multiedit", "notebookedit",...PI_AGENT_BROWSER_TOOLS].includes(name.toLowerCase())) ? "WRITE" : "READ";
}

export function normalizeToolPolicyMode(value: unknown, tools: readonly string[]): ToolPolicyMode {
  if (value === undefined) return legacyToolPolicyMode(tools);
  if (value !== "ALL" && value !== "CUSTOM") throw new DomainError("partner_tool_policy_mode_invalid", "Partner tool policy mode is invalid.");
  return value;
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

function strings(values: string[], code: string): string[] {
  if (values.length > 64) throw new DomainError(code, "Partner list is too large.");
  const normalized = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (normalized.some((value) => value.length > 240) || normalized.reduce((total, value) => total + value.length, 0) > 4_096) {
    throw new DomainError(code, "Partner list value is too large.");
  }
  return [...new Set(normalized)];
}

export function normalizeCodexPermissions(value: CodexPermissions | undefined): CodexPermissions {
  const permissions = value ?? DEFAULT_CODEX_PERMISSIONS;
  const candidate = permissions as unknown as Record<string, unknown>;
  if (candidate.approvalPolicy !== "never"
    || (candidate.sandboxMode !== "read-only" && candidate.sandboxMode !== "workspace-write")
    || (candidate.webSearchMode !== "disabled" && candidate.webSearchMode !== "cached" && candidate.webSearchMode !== "live")
    || typeof candidate.networkAccessEnabled !== "boolean") {
    throw new DomainError("partner_codex_permissions_invalid", "Codex permissions are invalid.");
  }
  return {
    approvalPolicy: "never",
    networkAccessEnabled: candidate.networkAccessEnabled,
    sandboxMode: candidate.sandboxMode,
    webSearchMode: candidate.webSearchMode,
  };
}

export function legacyCodexPermissions(tools: readonly string[]): CodexPermissions {
  if (tools.length === 0) {
    return { approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "workspace-write", webSearchMode: "live" };
  }
  const writable = tools.some((tool) => tool === "shell" || tool === "apply_patch");
  const web = tools.includes("web_search");
  return {
    approvalPolicy: "never",
    networkAccessEnabled: web,
    sandboxMode: writable ? "workspace-write" : "read-only",
    webSearchMode: web ? "live" : "disabled",
  };
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
  const toolPolicyMode = input.kind === "local-pi" ? normalizeToolPolicyMode(input.toolPolicyMode, input.tools) : undefined;
  return {
    capabilities: strings(input.capabilities, "partner_capabilities_invalid"),
    createdAt: input.createdAt,
    createdBy: input.createdBy ?? "user",
    ...(engine === "codex" ? { codexPermissions: normalizeCodexPermissions(input.codexPermissions) } : {}),
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
    skills: strings(input.skills, "partner_skills_invalid"),
    status: "ACTIVE",
    ...(toolPolicyMode === undefined ? {} : { toolPolicyMode }),
    tools: strings(input.tools, "partner_tools_invalid"),
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
    capabilities: strings(input.card.capabilities, "partner_capabilities_invalid"),
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
    skills: strings(input.card.skills, "partner_skills_invalid"),
  };
}

export function toPublicPartner(revision: PartnerRevision) {
  return {
    capabilities: [...revision.capabilities],
    createdBy: revision.createdBy,
    ...(revision.codexPermissions === undefined ? {} : { codexPermissions: { ...revision.codexPermissions } }),
    ...(revision.description === undefined ? {} : { description: revision.description }),
    displayName: revision.displayName,
    engine: revision.engine,
    ...(revision.engineModelId === undefined ? {} : { engineModelId: revision.engineModelId }),
    kind: revision.kind,
    ...(revision.modelIdOverride === undefined ? {} : { modelIdOverride: revision.modelIdOverride }),
    ...(revision.modelSourceId === undefined ? {} : { modelSourceId: revision.modelSourceId }),
    partnerId: revision.partnerId,
    partnerRevisionId: revision.partnerRevisionId,
    promptConfigured: revision.promptRef !== undefined,
    registryRevision: revision.registryRevision,
    skills: [...revision.skills],
    status: revision.status,
    ...(revision.toolPolicyMode === undefined ? {} : { toolPolicyMode: revision.toolPolicyMode }),
    tools: [...revision.tools],
  };
}
