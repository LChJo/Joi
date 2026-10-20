/** Fixed task input remains independent of the interface locale. */
export const REVIEW_RETRY_TEXT = "沿用已保存的回答，重试评审。";

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
export const MODEL_SOURCE_ACCESS_MODES = ["api", "coding-plan", "token-plan", "custom"] as const;
export type ModelSourceAccessModeDto = (typeof MODEL_SOURCE_ACCESS_MODES)[number];
export const MODEL_SOURCE_PROTOCOLS = ["openai", "anthropic"] as const;
export type ModelSourceProtocolDto = (typeof MODEL_SOURCE_PROTOCOLS)[number];
/** Ordered least-to-most, mirroring pi-ai's own thinking ladder with `minimal` left out. The
 *  order is also the order the settings page renders, so the array must stay sorted. */
export const THINKING_EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
export const THINKING_EFFORT_LABELS: Record<ThinkingEffort, string> = {
  off: "关闭",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};
export const MODEL_SOURCE_CHOICES = [
  { kind: "kimi", label: "Kimi", options: [
    { accessMode: "api", description: "开放平台按量计费", label: "开放平台 API", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
    ] },
    { accessMode: "coding-plan", description: "Kimi 会员编程权益", label: "Kimi Code", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "glm", label: "GLM", options: [
    { accessMode: "api", description: "智谱开放平台按量计费", label: "开放平台 API", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
    ] },
    { accessMode: "coding-plan", description: "GLM 编程订阅套餐", label: "GLM Coding Plan", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "qwen", label: "Qwen", options: [
    { accessMode: "api", description: "阿里云百炼按量计费", label: "百炼 API", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
    { accessMode: "coding-plan", description: "百炼编程订阅套餐", label: "百炼 Coding Plan", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
    { accessMode: "token-plan", description: "百炼 Credits 订阅套餐", label: "百炼 Token Plan", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "doubao", label: "Doubao", options: [
    { accessMode: "api", description: "火山方舟按量计费", label: "方舟 API", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
    ] },
    { accessMode: "coding-plan", description: "火山方舟编程订阅套餐", label: "方舟 Coding Plan", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "minimax", label: "MiniMax", options: [
    { accessMode: "api", description: "开放平台按量计费", label: "开放平台 API", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
    { accessMode: "coding-plan", description: "MiniMax 订阅额度", label: "MiniMax Token Plan", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
      { description: "Anthropic Messages", label: "Anthropic-compatible", protocol: "anthropic" },
    ] },
  ] },
  { kind: "deepseek", label: "DeepSeek", options: [
    { accessMode: "api", description: "DeepSeek 开放平台按量计费", label: "DeepSeek API", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
    ] },
  ] },
  { kind: "generic-openai", label: "通用平台", options: [
    { accessMode: "custom", description: "自定义兼容接口", label: "自定义接口", protocols: [
      { description: "OpenAI Responses", label: "OpenAI-compatible", protocol: "openai" },
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

export interface WorkbenchDto {
  workbenchId: string;
  name: string;
  scopeSummary: string;
  updatedAt: string;
}

export interface WorkbenchWorkspaceDto {
  displayName: string;
  failureReasonCode?: string;
  kind: "BOUND" | "MANAGED";
  status: "FAILED" | "PROVISIONING" | "READY";
}

export interface WorkbenchDetailDto {
  activeWork: WorkItemDto[];
  workbenchId: string;
  instances: {
    engine: PartnerEngineDto;
    instanceId: string;
    lastUsedAt: string;
    partnerId: string;
    partnerName: string;
    sessionPolicy: "EPHEMERAL" | "RESIDENT";
    status: "BUSY" | "IDLE";
  }[];
  name: string;
  personaRevisionId: string;
  projectLabel: string;
  recentOutcomes: {
    completedAt: string;
    goalId: string;
    resultRevision: number;
    status: "COMPLETED" | "COMPLETED_WITH_GAPS" | "FAILED" | "CANCELED";
    summary: string;
    title: string;
  }[];
  recentResults: {
    createdAt: string;
    isLate: boolean;
    partnerRevisionId: string;
    resultId: string;
    status: "COMPLETED" | "FAILED" | "WAITING_INPUT" | "WAITING_AUTH" | "UNKNOWN";
    summary: string;
    workId: string;
  }[];
  responsibility: string;
  updatedAt: string;
  workspace: WorkbenchWorkspaceDto;
}

export interface WorkbenchChangeRequestDto {
  createdAt: string;
  kind: "ARCHIVE" | "MERGE";
  reason: string;
  requestId: string;
  sourceWorkbenchId: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  targetWorkbenchId?: string;
}

export const PARTNER_ENGINES = ["claude-code", "codex", "pi-core"] as const;
export type PartnerEngineDto = (typeof PARTNER_ENGINES)[number];
export type ToolPolicyModeDto = "ALL" | "CUSTOM";
export interface CodexPermissionsDto {
  approvalPolicy: "never";
  networkAccessEnabled: boolean;
  sandboxMode: "read-only" | "workspace-write";
  webSearchMode: "disabled" | "cached" | "live";
}

export interface PartnerKnowledgeDocDto {
  bytes: number;
  createdAt: string;
  docId: string;
  filename: string;
  sha256: string;
}

export interface PartnerConfigurationDto {
  reasonCodes: string[];
  status: "ACTION_REQUIRED";
}

export interface PartnerDto {
  capabilities: string[];
  codexPermissions?: CodexPermissionsDto;
  configuration?: PartnerConfigurationDto;
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
  promptConfigured?: boolean;
  registryRevision: number;
  skills: string[];
  status: "ACTIVE" | "DISABLED" | "DELETED";
  toolPolicyMode?: ToolPolicyModeDto;
  tools: string[];
}

export interface PartnerPromptDto {
  prompt: string | null;
}

export interface PartnerModelTestDto {
  modelId?: string;
  partnerId: string;
  reasonCode?: string;
  sourceDisplayName?: string;
  sourceId?: string;
  status: "FAILED" | "READY";
  /** Absent when the state was derived from the pinned source alone and nothing has been tested. */
  testedAt?: string;
}

export interface ModelSourceDto {
  anthropicAuthMode?: "bearer";
  accessMode: ModelSourceAccessModeDto;
  activeModel: {
    capability: "release-tested" | "custom-unverified-tools";
    /** Percent of the route's window at which the session is compacted; absent means joi's default. */
    compactionThresholdPercent?: number;
    contextWindow?: number;
    /** What the route will actually accept. `contextWindow`/`maxOutputTokens` are what the user
     *  configured; this is what the request is sized to — a provider that rejected an oversized
     *  request states its real limit, and joi holds the route to that until the process restarts. */
    effective?: { contextWindow: number; maxOutputTokens: number };
    id: string;
    maxOutputTokens?: number;
    revisionId: string;
    /** Absent means joi falls back to its endpoint allowlist (always-on hosts get "low", others "off"). */
    thinkingEffort?: ThinkingEffort;
  };
  activeSourceRevisionId: string;
  baseUrl?: string;
  credential: { configured: boolean; version: number };
  displayName: string;
  kind: ModelSourceKindDto;
  lastError?: string;
  lastValidatedAt?: string;
  order: number;
  primary: boolean;
  protocol: ModelSourceProtocolDto;
  reasonCode?: string;
  sourceId: string;
  status: ModelSourceStatusDto;
}

export interface WorkItemDto {
  executionPhase?: LocalExecutionPhaseDto;
  waitReason?: ExecutionWaitReasonDto;
  workbenchId: string;
  status: "PLANNED" | "READY" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELED";
  title: string;
  workId: string;
}

export interface JoiRuntimeDto {
  configured: boolean;
  status: "NOT_CONFIGURED" | "READY" | "DEGRADED" | "NEEDS_ATTENTION";
  modelHealth?: { ready: number; recovering: number; unavailable: number };
}

export interface JoiSnapshotDto {
  workbenchChanges: WorkbenchChangeRequestDto[];
  workbenches: WorkbenchDto[];
  modelSources: ModelSourceDto[];
  partners: PartnerDto[];
  runtime: JoiRuntimeDto;
  work: WorkItemDto[];
}

export interface WorkbenchProposalDto {
  name: string;
  projectLabel: string;
  scopeSummary: string;
}

export interface WorkbenchBindingDto {
  bindInputId: string;
  questionId: string;
  questionVersion: number;
  idempotencyKey: string;
}

export interface JoiAcceptedMessageDto {
  workbenchProposal?: WorkbenchProposalDto;
  acceptedAt: string;
  workbenchId?: string;
  canceled?: boolean;
  clarificationPrompt?: string;
  clarificationReasonCode?: string;
  failure?: JoiGoalFailureDto;
  inputId: string;
  questionId?: string;
  questionVersion?: number;
  status: "CLARIFICATION_REQUIRED" | "CONSUMED" | "PENDING" | "ROUTED";
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
  workbenchId?: string;
  kind: "MESSAGE" | "TURN" | "WORK" | "PARTNER_RESULT";
  occurredAt: string;
  status: string;
  workId?: string;
}

export type JoiGoalStatusDto = "ARRANGING" | "ARRANGED" | "RUNNING" | "REVIEWING" | "EXTENDING" | "NEEDS_ATTENTION" | "FINALIZING" | "COMPLETED" | "COMPLETED_WITH_GAPS" | "FAILED" | "CANCELED";

export type JoiFailureSuggestedActionDto = "CHECK_MODEL_SOURCE" | "RESTART_OR_UPDATE" | "RETRY_OR_EXPORT_DIAGNOSTICS";

export interface JoiGoalFailureDto {
  attempts: number;
  executionStarted: boolean;
  reasonCode: string;
  suggestedAction: JoiFailureSuggestedActionDto;
}

export interface JoiGoalHarnessDto {
  currentLayer: number;
  decisionCount: number;
  destination?: string;
  fogCount: number;
  mapStatus: "ACTIVE" | "CLEARED";
  openPathCount: number;
  reviewedRevision: number;
  revision: number;
  topFogNote?: string;
  topPaths: { pathId: string; status: "CLOSED" | "OPEN" | "OUT_OF_SCOPE"; title: string }[];
}

export interface JoiGoalMapPathDto {
  pathId: string;
  layer: number;
  title: string;
  status: "CLOSED" | "OPEN" | "OUT_OF_SCOPE";
  workId?: string;
  workStatus?: "PLANNED" | "READY" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELED";
  resolvedDecisionId?: string;
}

export interface JoiGoalMapDetailDto {
  destination?: string;
  mapStatus: "ACTIVE" | "CLEARED";
  revision: number;
  currentLayer: number;
  pathCount: number;
  decisionCount: number;
  fogCount: number;
  paths: JoiGoalMapPathDto[];
  decisions: {
    decisionId: string;
    kind: "APPROACH" | "SCOPE" | "OUT_OF_SCOPE" | "WORKBENCH_REFINE";
    summary: string;
    detail: string;
    createdAt: string;
  }[];
  fog: {
    fogId: string;
    note: string;
    status: "ACTIVE" | "GRADUATED";
    graduatedPathId?: string;
  }[];
}

/** Each map collection is paged with the same offset and limit, independently of the feed. */
export interface JoiGoalDetailDto {
  goalId: string;
  fullTitle: string;
  harness?: JoiGoalMapDetailDto;
  nextOffset?: number;
}

export interface JoiGoalDetailPage {
  offset?: number;
  limit?: number;
}

export interface JoiGoalWorkDto {
  executing?: number;
  resourceWaiting?: number;
  waitingReasons?: ExecutionWaitReasonDto[];
  active: number;
  completed: number;
  failed: number;
  /**
   * How many of `failed` a recovery chain has superseded by finishing a replacement Work.
   * Optional so a caller that only needs the counts can omit a fact it does not project.
   */
  failedResolved?: number;
  total: number;
}

export interface JoiGoalCardBaseDto {
  agentCount: number;
  artifacts?: WorkbenchArtifactDto[];
  workbench: { workbenchId: string; name: string; projectLabel?: string };
  /**
   * Whether the user may file this card away. `canDelete` cannot stand in for it: removal also
   * demands a finalized outcome, and a failed card that never reached one is exactly the card a
   * user wants out of the feed — archiving is reversible, so it can be offered there.
   */
  canArchive?: boolean;
  canDelete: boolean;
  completedAt?: string;
  /** Set while the card lives in the archived list instead of the home feed. */
  archivedAt?: string;
  completionSummary?: string;
  failure?: JoiGoalFailureDto;
  goalId: string;
  harness?: JoiGoalHarnessDto;
  title: string;
  updatedAt: string;
  work: JoiGoalWorkDto;
}

export type JoiGoalCardDto = JoiGoalCardBaseDto & (
  | { clarification: { prompt?: string; questionId?: string; questionVersion?: number; reasonCode: string }; status: "NEEDS_ATTENTION" }
  | { clarification?: never; status: Exclude<JoiGoalStatusDto, "NEEDS_ATTENTION"> }
);

export type JoiThinkingStageDto = "ROUTING" | "PLANNING" | "DISPATCHING" | "RUNNING" | "WAITING" | "FINALIZING" | "REVIEWING" | "EXTENDING";

export interface JoiThinkingItemDto {
  agentCount: number;
  expiresAt?: string;
  goalId: string;
  phase: "queued" | "progressing" | "settled";
  stage: JoiThinkingStageDto;
  startedAt: string;
  turnId: string;
  work: JoiGoalWorkDto;
}

export interface JoiHomeFeedDto {
  /**
   * Every goal card, archived ones included: a card carries `archivedAt` when the user filed it
   * away, and the clients partition the list from there.
   *
   * Filtering in SQL instead would mean a second run of the feed's projection query for a list
   * nobody polls — and archived cards would still have to travel here for the archive screen and
   * for `RemoteHomeQueryService.goal()` to open one. The payload is what it was before archiving
   * existed, since these cards used to sit in this list until they were removed.
   */
  goals: JoiGoalCardDto[];
  thinking: JoiThinkingItemDto[];
  unassignedActions: JoiAcceptedMessageDto[];
  /**
   * Pending workbench confirmations ride along with the feed so the home screen polls one endpoint.
   * Absent on transports that do not carry them.
   */
  workbenchChanges?: WorkbenchChangeRequestDto[];
}

export type WorkbenchAgentStatusDto = "IDLE" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED" | "CANCELED" | "UNKNOWN";
export type LocalExecutionPhaseDto = "READ_QUEUED" | "READ_RUNNING" | "WRITE_QUEUED" | "WRITE_RUNNING";
export type ExecutionWaitReasonDto = "CAPACITY" | "WORKSPACE_READ" | "WORKSPACE_WRITE";

export interface WorkbenchAgentCardDto {
  /** A retained deliverable whose acceptance could not be established; execution status is unchanged. */
  resultAssessment?: "INSUFFICIENT";
  executionPhase?: LocalExecutionPhaseDto;
  waitReason?: ExecutionWaitReasonDto;
  agentId: string;
  workbenchId: string;
  canDelete: boolean;
  createdAt: string;
  engine: PartnerEngineDto;
  lastActivityAt: string;
  partnerId: string;
  partnerName: string;
  sessionPolicy: "EPHEMERAL" | "RESIDENT";
  status: WorkbenchAgentStatusDto;
  transport: "A2A" | "LOCAL";
}

export interface WorkbenchArtifactDto {
  artifactId?: string;
  /**
   * POSIX relative directory used for folder grouping in the renderer.
   * - FILE: dirname of the workspace-relative path; undefined for workspace-root
   *   files and for non-workspace refs (e.g. "work_result_artifact:").
   * - DIRECTORY: the directory's own workspace-relative path (undefined when unknown).
   */
  directory?: string;
  kind: "DIRECTORY" | "FILE";
  mimeType: string;
  name: string;
  size: number;
}

export interface AgentConversationEntryDto {
  artifact?: WorkbenchArtifactDto;
  createdAt: string;
  entryId: string;
  kind: "MARKDOWN" | "TOOL_CALL" | "TOOL_RESULT" | "ARTIFACT" | "ERROR";
  role: "USER" | "AGENT" | "TOOL" | "SYSTEM";
  sequence: number;
  text?: string;
  /** Opaque link to the private tool body; never a payload, so it stays safe on this surface. */
  toolCallId?: string;
  toolName?: string;
}

/**
 * Private per-call tool body for local debugging (AC-61). Read on demand only, never part
 * of the conversation projection, the home feed, diagnostics, SSE or the remote surface.
 */
export interface WorkbenchToolTraceDto {
  command: string;
  isError: boolean;
  result: string;
  toolCallId: string;
  toolName: string;
  truncated: boolean;
}

export interface AgentConversationPageDto {
  agent: WorkbenchAgentCardDto;
  items: AgentConversationEntryDto[];
  nextCursor?: string;
}

export interface ScenarioRoleDto {
  blurb?: string;
  id: string;
  prompt: string;
  skills?: string[];
  title: string;
}

export interface ScenarioDto {
  blurb: string;
  id: string;
  prompt: string;
  roles?: ScenarioRoleDto[];
  source: "builtin" | "skill";
  title: string;
}

export type ScenarioPackStatusDto = "NOT_INSTALLED" | "ACTIVE" | "ACTION_REQUIRED" | "OUTDATED";
export type ScenarioPackRoleStateDto = "NOT_INSTALLED" | "ACTIVE" | "DISABLED" | "ACTION_REQUIRED" | "OUTDATED";

export interface ScenarioPackRoleStatusDto {
  partnerId?: string;
  reasonCode?: string;
  roleId: string;
  status: ScenarioPackRoleStateDto;
}

export interface ScenarioPackRoleDto extends ScenarioPackRoleStatusDto {
  blurb: string;
  id: string;
  title: string;
}

export interface ScenarioPackTeamDto {
  blurb: string;
  id: string;
  roles: ScenarioPackRoleDto[];
  title: string;
}

export interface ScenarioPackDto {
  blurb: string;
  definitionVersion: number;
  id: string;
  installedRoleCount: number;
  source: { license: string; repository: string; revision: string };
  status: ScenarioPackStatusDto;
  teams: ScenarioPackTeamDto[];
  title: string;
  totalRoleCount: number;
}

export interface ScenarioPackRoleInstallOutcomeDto {
  outcome: "CREATED" | "REUSED" | "ACTION_REQUIRED";
  partnerId: string;
  reasonCode?: string;
  roleId: string;
}

export interface ScenarioPackInstallResultDto {
  installedRoleCount: number;
  outcomes: ScenarioPackRoleInstallOutcomeDto[];
  packId: string;
  status: ScenarioPackStatusDto;
}

export const BUILTIN_SCENARIOS: readonly ScenarioDto[] = [
  {
    blurb: "组建一支能把模糊目标规划清楚的搭档团队",
    id: "plan-big-goal",
    prompt: "我想为『把一个模糊的大目标规划清楚』这类工作组建搭档团队。请判断需要哪几位本机搭档、各自的职责与默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时为它们挑选合适的 READY 模型源，然后用 partner_create 创建它们。本轮只组建团队，不必执行具体的规划任务。",
    roles: [
      {
        blurb: "把模糊大目标拆成结果、里程碑与下一步动作",
        id: "goal-planner",
        prompt: "你是一位负责把模糊大目标拆成可执行计划的搭档。DO：将目标拆为结果、里程碑与下一步动作的层级，并显式标注假设与决策点。验收标准：每个里程碑有可独立验证的产出描述，且依赖顺序明确。范围外：不执行具体任务、不写代码、不做外部调研。",
        title: "目标规划搭档",
      },
      {
        blurb: "识别关键不确定性、外部依赖与兜底方向",
        id: "risk-scout",
        prompt: "你是一位负责识别计划风险与依赖的搭档。DO：列出可能推翻目标的关键不确定性及其廉价验证方式，标注外部依赖与触发信号。验收标准：每项风险都有触发信号与兜底方向，可被逐条核对。范围外：不自行制定主计划、不做最终取舍。",
        title: "风险侦察搭档",
      },
    ],
    source: "builtin",
    title: "规划一个大目标",
  },
  {
    blurb: "组建一支用测试驱动实现功能的搭档团队",
    id: "implement-feature",
    prompt: "我想为『用测试驱动的方式实现功能』这类工作组建搭档团队。请判断需要哪几位本机搭档、各自的职责与默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时为它们挑选合适的 READY 模型源，然后用 partner_create 创建它们。本轮只组建团队，不必动手实现功能。",
    roles: [
      {
        blurb: "先写失败测试再实现，保持小步可验证",
        id: "tdd-implementer",
        prompt: "你是一位负责用测试驱动方式实现功能的搭档。DO：为每个行为先写失败测试，再实现最小代码使其通过，保持每次迭代可验证。验收标准：所有新行为都有对应测试，且能说清运行与验证方式。范围外：不做无关重构、不扩大功能范围。",
        title: "编码搭档",
      },
      {
        blurb: "对照验收标准逐项核对并跑回归",
        id: "acceptance-guard",
        prompt: "你是一位负责功能验收与回归的搭档。DO：对照验收标准逐项核对，运行相关测试与检查，如实报告失败与缺口。验收标准：验收结论与每条标准的运行证据一一对应。范围外：不直接改代码、不新增功能。",
        title: "验收回归搭档",
      },
    ],
    source: "builtin",
    title: "实现一个功能",
  },
  {
    blurb: "组建一支覆盖多视角的代码审查搭档团队",
    id: "review-code",
    prompt: "我想为『代码审查』这类工作组建搭档团队，至少包含分别盯正确性与可维护性的两位搭档，并把相关的本机技能挂给它们。请为每位搭档写自包含的默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时挑选合适的 READY 模型源，然后用 partner_create 创建它们。本轮只组建团队，不必执行具体审查。",
    roles: [
      {
        blurb: "盯逻辑错误、边界条件与并发/资源问题",
        id: "correctness-reviewer",
        prompt: "你是一位负责审查代码正确性的搭档。DO：寻找逻辑错误、边界条件、并发与资源泄漏问题，按严重度给出带证据的结论。验收标准：每个问题都能复现或指出推理链条，并附修复方向。范围外：不评价风格与命名、不直接改代码。",
        title: "正确性审查搭档",
      },
      {
        blurb: "盯结构、可读性、可测试性与长期成本",
        id: "maintainability-reviewer",
        prompt: "你是一位负责审查代码可维护性的搭档。DO：评估结构、命名、重复与可测试性，优先指出会形成长期成本的问题。验收标准：建议保持行为不变且标注具体位置。范围外：不重复正确性审查、不要求大规模重写。",
        title: "可维护性搭档",
      },
    ],
    source: "builtin",
    title: "审查一段代码",
  },
  {
    blurb: "组建一支能复现并诊断缺陷的搭档团队",
    id: "diagnose-bug",
    prompt: "我想为『复现并诊断缺陷』这类工作组建搭档团队。请判断需要哪几位本机搭档、各自的职责与默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外，强调先复现定位再谈修复），用 pi-core 引擎、必要时挑选合适的 READY 模型源，然后用 partner_create 创建它们。本轮只组建团队，不必直接改代码。",
    roles: [
      {
        blurb: "先复现缺陷，产出最小复现步骤与证据",
        id: "reproducer",
        prompt: "你是一位负责复现与定位缺陷的搭档。DO：先构建最小复现步骤再谈修复，记录环境、输入与观察到的行为。验收标准：复现步骤可被他人稳定执行，并附关键证据。范围外：不改代码做修复、不在无证据时猜测根因。",
        title: "复现定位搭档",
      },
      {
        blurb: "基于复现证据给出根因与修复选项",
        id: "root-cause-analyst",
        prompt: "你是一位负责诊断缺陷根因的搭档。DO：基于复现证据提出根因假设并验证，给出最小修复选项及其风险。验收标准：根因解释能覆盖全部观察到的现象，选项可被验证。范围外：不直接做大范围重构、不跳过证据下结论。",
        title: "根因诊断搭档",
      },
    ],
    source: "builtin",
    title: "诊断一个 Bug",
  },
  {
    blurb: "组建一支能并行调研并汇总的搭档团队",
    id: "research-brief",
    prompt: "我想为『并行调研后汇总结论』这类工作组建搭档团队，安排几位可并行调研、各持不同视角或来源的本机搭档。请为每位搭档写自包含的默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时挑选合适的 READY 模型源，然后用 partner_create 创建它们。本轮只组建团队，不必执行具体调研。",
    roles: [
      {
        blurb: "从一个独立视角并行调研，附来源与反例",
        id: "angle-researcher",
        prompt: "你是一位负责单一视角调研的搭档。DO：围绕指定视角收集证据与反例，区分事实与观点，附来源。验收标准：结论带来源与置信度，并说明反例检索情况。范围外：不汇总其他视角、不做最终建议。",
        title: "多视角研究搭档",
      },
      {
        blurb: "把各视角调研汇总成有立场的结论",
        id: "brief-synthesizer",
        prompt: "你是一位负责汇总结论的搭档。DO：对照各视角证据，指出一致与冲突之处，形成有立场的结论与遗留问题。验收标准：结论可追溯到各调研来源，冲突不被掩盖。范围外：不重新做一手调研、不罗列资料不给结论。",
        title: "结论汇总搭档",
      },
    ],
    source: "builtin",
    title: "做一次研究综述",
  },
  {
    blurb: "组建一支能评估并改进架构的搭档团队",
    id: "improve-architecture",
    prompt: "我想为『评估并改进代码库架构』这类工作组建搭档团队，安排几位能给出不同设计取向的本机搭档。请为每位搭档写自包含的默认提示词（行为化描述、含可独立验证的验收标准与明确的范围外），用 pi-core 引擎、必要时挑选合适的 READY 模型源，然后用 partner_create 创建它们。本轮只组建团队，不必动手重构。",
    roles: [
      {
        blurb: "评估现状架构痛点及其真实成本",
        id: "architecture-assessor",
        prompt: "你是一位负责评估代码库架构的搭档。DO：识别真正抬高维护成本的痛点，用代码结构证据支撑，并按影响排序。验收标准：每个痛点都有成本说明与证据，而非审美偏好。范围外：不写重构代码、不提推倒重来方案。",
        title: "架构评估搭档",
      },
      {
        blurb: "把改进拆成可验证、可回滚的小步迁移",
        id: "migration-planner",
        prompt: "你是一位负责规划渐进迁移的搭档。DO：把改进方向拆成一系列可独立验证、可回滚的小步，标注每步的验证方式与回滚点。验收标准：每步完成后系统保持可运行。范围外：不亲自执行迁移、不安排需要停机的步骤。",
        title: "迁移规划搭档",
      },
    ],
    source: "builtin",
    title: "改进代码库架构",
  },
];
