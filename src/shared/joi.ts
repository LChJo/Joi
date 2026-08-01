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

export interface ScenarioDto {
  blurb: string;
  id: string;
  prompt: string;
  source: "builtin" | "skill";
  title: string;
}

export const BUILTIN_SCENARIOS: readonly ScenarioDto[] = [
  {
    blurb: "想法还模糊时，先把它说清楚再决定分工",
    id: "plan-big-goal",
    prompt: "我有个偏大的想法还没想清楚：……（在这里补充）。请先帮我把目标和边界问清楚，判断这件事要不要拆给几位搭档分工；如果其实很小，直接答我就好，不必建团队。",
    source: "builtin",
    title: "规划一个大目标",
  },
  {
    blurb: "确认验收标准后用测试驱动做出来",
    id: "implement-feature",
    prompt: "我想实现：……（补充功能与约束）。先和我确认验收标准，再安排搭档用测试驱动的方式实现，完成后给我一个可验证的结论。",
    source: "builtin",
    title: "实现一个功能",
  },
  {
    blurb: "从正确性与可维护性分头看",
    id: "review-code",
    prompt: "请审查：……（贴代码或给出路径）。安排搭档分别从正确性、可维护性两个角度看，各自给出带证据的发现，最后由你汇总成一个有主见的结论，别只是罗列。",
    source: "builtin",
    title: "审查一段代码",
  },
  {
    blurb: "先复现定位，再谈修复",
    id: "diagnose-bug",
    prompt: "我遇到的问题是：……（补充现象与复现步骤）。先复现并定位根因，给出修复方案与影响面，先别直接改代码。",
    source: "builtin",
    title: "诊断一个 Bug",
  },
  {
    blurb: "并行调研后汇总成结论",
    id: "research-brief",
    prompt: "我想搞清楚：……（补充研究问题）。安排并行调研，各自给出带出处的结论，再由你汇总成一份简明综述和推荐。",
    source: "builtin",
    title: "做一次研究综述",
  },
  {
    blurb: "评估现状与目标再决定分头设计",
    id: "improve-architecture",
    prompt: "我想改进：……（补充模块或痛点）。先评估现状与目标差距，再决定是否需要多位搭档分头给出不同取向的设计，最后由你拍板一个方案。",
    source: "builtin",
    title: "改进代码库架构",
  },
];
