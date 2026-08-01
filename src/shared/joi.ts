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
  clarificationReasonCode?: string;
  inputId: string;
  status: "PENDING" | "CLARIFICATION_REQUIRED" | "ROUTED" | "CONSUMED";
  textPreview?: string;
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

export interface ScenarioDto {
  blurb: string;
  id: string;
  prompt: string;
  source: "builtin" | "skill";
  title: string;
}

export const BUILTIN_SCENARIOS: readonly ScenarioDto[] = [
  {
    blurb: "组建一支能把模糊目标规划清楚的搭档团队",
    id: "plan-big-goal",
    prompt: "我想为『把一个模糊的大目标规划清楚』这类工作组建搭档团队。请判断需要哪几位本机搭档、各自的职责与默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时为它们挑选合适的 READY 模型源，然后用 partner.create 创建它们。本轮只组建团队，不必执行具体的规划任务。",
    source: "builtin",
    title: "规划一个大目标",
  },
  {
    blurb: "组建一支用测试驱动实现功能的搭档团队",
    id: "implement-feature",
    prompt: "我想为『用测试驱动的方式实现功能』这类工作组建搭档团队。请判断需要哪几位本机搭档、各自的职责与默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时为它们挑选合适的 READY 模型源，然后用 partner.create 创建它们。本轮只组建团队，不必动手实现功能。",
    source: "builtin",
    title: "实现一个功能",
  },
  {
    blurb: "组建一支覆盖多视角的代码审查搭档团队",
    id: "review-code",
    prompt: "我想为『代码审查』这类工作组建搭档团队，至少包含分别盯正确性与可维护性的两位搭档，并把相关的本机技能挂给它们。请为每位搭档写自包含的默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时挑选合适的 READY 模型源，然后用 partner.create 创建它们。本轮只组建团队，不必执行具体审查。",
    source: "builtin",
    title: "审查一段代码",
  },
  {
    blurb: "组建一支能复现并诊断缺陷的搭档团队",
    id: "diagnose-bug",
    prompt: "我想为『复现并诊断缺陷』这类工作组建搭档团队。请判断需要哪几位本机搭档、各自的职责与默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外，强调先复现定位再谈修复），用 pi-core 引擎、必要时挑选合适的 READY 模型源，然后用 partner.create 创建它们。本轮只组建团队，不必直接改代码。",
    source: "builtin",
    title: "诊断一个 Bug",
  },
  {
    blurb: "组建一支能并行调研并汇总的搭档团队",
    id: "research-brief",
    prompt: "我想为『并行调研后汇总结论』这类工作组建搭档团队，安排几位可并行调研、各持不同视角或来源的本机搭档。请为每位搭档写自包含的默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时挑选合适的 READY 模型源，然后用 partner.create 创建它们。本轮只组建团队，不必执行具体调研。",
    source: "builtin",
    title: "做一次研究综述",
  },
  {
    blurb: "组建一支能评估并改进架构的搭档团队",
    id: "improve-architecture",
    prompt: "我想为『评估并改进代码库架构』这类工作组建搭档团队，安排几位能给出不同设计取向的本机搭档。请为每位搭档写自包含的默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时挑选合适的 READY 模型源，然后用 partner.create 创建它们。本轮只组建团队，不必动手重构。",
    source: "builtin",
    title: "改进代码库架构",
  },
];
