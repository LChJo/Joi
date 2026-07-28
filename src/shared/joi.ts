export const MODEL_SOURCE_KINDS = [
  "kimi",
  "glm",
  "qwen",
  "doubao",
  "minimax",
  "deepseek",
  "generic-openai",
] as const;

export type ModelSourceKindDto = (typeof MODEL_SOURCE_KINDS)[number];
export const MODEL_SOURCE_CHOICES = [
  { kind: "kimi", label: "Kimi" },
  { kind: "glm", label: "GLM" },
  { kind: "qwen", label: "Qwen" },
  { kind: "doubao", label: "Doubao" },
  { kind: "minimax", label: "MiniMax" },
  { kind: "deepseek", label: "DeepSeek" },
  { kind: "generic-openai", label: "通用平台" },
] as const satisfies readonly { kind: ModelSourceKindDto; label: string }[];
export type ModelSourceStatusDto = "DRAFT" | "VALIDATING" | "READY" | "DEGRADED" | "NEEDS_AUTH" | "DISABLED";

export interface AvatarDto {
  avatarId: string;
  name: string;
  scopeSummary: string;
  updatedAt: string;
}

export interface PartnerDto {
  capabilities: string[];
  displayName: string;
  kind: "local-pi" | "a2a";
  partnerId: string;
  partnerRevisionId: string;
  registryRevision: number;
  skills: string[];
  status: "ACTIVE" | "DISABLED" | "DELETED";
  tools: string[];
}

export interface ModelSourceDto {
  activeModel: {
    capability: "release-tested" | "custom-unverified-tools";
    id: string;
    revisionId: string;
  };
  activeSourceRevisionId: string;
  baseUrl?: string;
  credential: { configured: boolean; version: number };
  displayName: string;
  kind: ModelSourceKindDto;
  lastValidatedAt?: string;
  order: number;
  primary: boolean;
  reasonCode?: string;
  sourceId: string;
  status: ModelSourceStatusDto;
}

export interface WorkItemDto {
  avatarId: string;
  status: "PLANNED" | "READY" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELED";
  title: string;
  workId: string;
}

export interface JoiSnapshotDto {
  avatars: AvatarDto[];
  modelSources: ModelSourceDto[];
  partners: PartnerDto[];
  runtime: {
    configured: boolean;
    status: "NOT_CONFIGURED" | "READY" | "DEGRADED" | "NEEDS_ATTENTION";
  };
  work: WorkItemDto[];
}

export interface JoiAcceptedMessageDto {
  acceptedAt: string;
  inputId: string;
  status: "PENDING";
}
