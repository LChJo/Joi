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
export const MODEL_SOURCE_ACCESS_MODES = ["api", "coding-plan", "custom"] as const;
export type ModelSourceAccessModeDto = (typeof MODEL_SOURCE_ACCESS_MODES)[number];
export const MODEL_SOURCE_PROTOCOLS = ["openai", "anthropic"] as const;
export type ModelSourceProtocolDto = (typeof MODEL_SOURCE_PROTOCOLS)[number];
export const MODEL_SOURCE_CHOICES = [
  { kind: "kimi", label: "Kimi", options: [
    { accessMode: "api", description: "开放平台按量计费", label: "开放平台 API", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
    ] },
    { accessMode: "coding-plan", description: "Kimi 会员编程权益", label: "Kimi Code", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "glm", label: "GLM", options: [
    { accessMode: "api", description: "智谱开放平台按量计费", label: "开放平台 API", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
    ] },
    { accessMode: "coding-plan", description: "GLM 编程订阅套餐", label: "GLM Coding Plan", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "qwen", label: "Qwen", options: [
    { accessMode: "api", description: "阿里云百炼按量计费", label: "百炼 API", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
    { accessMode: "coding-plan", description: "百炼编程订阅套餐", label: "百炼 Coding Plan", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "doubao", label: "Doubao", options: [
    { accessMode: "api", description: "火山方舟按量计费", label: "方舟 API", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
    ] },
    { accessMode: "coding-plan", description: "火山方舟编程订阅套餐", label: "方舟 Coding Plan", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "minimax", label: "MiniMax", options: [
    { accessMode: "api", description: "开放平台按量计费", label: "开放平台 API", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
    { accessMode: "coding-plan", description: "MiniMax 订阅额度", label: "MiniMax Token Plan", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "deepseek", label: "DeepSeek", options: [
    { accessMode: "api", description: "DeepSeek 开放平台按量计费", label: "DeepSeek API", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
    ] },
  ] },
  { kind: "generic-openai", label: "通用平台", options: [
    { accessMode: "custom", description: "自定义兼容接口", label: "自定义接口", protocols: [
      { description: "OpenAI Chat Completions", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
] as const satisfies readonly {
  kind: ModelSourceKindDto;
  label: string;
  options: readonly {
    accessMode: ModelSourceAccessModeDto;
    description: string;
    label: string;
    protocols: readonly { description: string; label: string; protocol: ModelSourceProtocolDto }[];
  }[];
}[];
export type ModelSourceStatusDto = "DRAFT" | "VALIDATING" | "READY" | "DEGRADED" | "NEEDS_AUTH" | "DISABLED";

export interface AvatarDto {
  avatarId: string;
  name: string;
  scopeSummary: string;
  updatedAt: string;
}

export interface AvatarChangeRequestDto {
  createdAt: string;
  kind: "ARCHIVE" | "MERGE";
  reason: string;
  requestId: string;
  sourceAvatarId: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  targetAvatarId?: string;
}

export const PARTNER_ENGINES = ["claude-code", "codex", "pi-core"] as const;
export type PartnerEngineDto = (typeof PARTNER_ENGINES)[number];

export interface PartnerKnowledgeDocDto {
  bytes: number;
  createdAt: string;
  docId: string;
  filename: string;
  sha256: string;
}

export interface PartnerDto {
  capabilities: string[];
  createdBy: "joi" | "user";
  description?: string;
  displayName: string;
  engine: PartnerEngineDto;
  engineModelId?: string;
  inFlightCount: number;
  kind: "local-pi" | "a2a";
  knowledgeDocCount: number;
  lifecyclePolicy: "DRAIN";
  modelIdOverride?: string;
  modelSourceId?: string;
  partnerId: string;
  partnerRevisionId: string;
  registryRevision: number;
  skills: string[];
  status: "ACTIVE" | "DISABLED" | "DELETED";
  tools: string[];
}

export interface ModelSourceDto {
  accessMode: ModelSourceAccessModeDto;
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
  protocol: ModelSourceProtocolDto;
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
  avatarChanges: AvatarChangeRequestDto[];
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
  avatarId?: string;
  inputId: string;
  status: "PENDING" | "CLARIFICATION_REQUIRED" | "ROUTED" | "CONSUMED";
}

export interface JoiAttachmentDto {
  attachmentId: string;
  createdAt: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface JoiActivityDto {
  activityId: string;
  avatarId?: string;
  kind: "MESSAGE" | "TURN" | "WORK" | "PARTNER_RESULT";
  occurredAt: string;
  status: string;
  workId?: string;
}
