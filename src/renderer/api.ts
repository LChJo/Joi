import type {
  AgentDto,
  BackupDto,
  ContinuityDto,
  DiagnosticsDto,
  ExpressionDto,
  InteractionDto,
  LifeDto,
  LifeDeletionImpactDto,
  LifeEventDto,
  LifeRuntimeActivityDto,
  PrimaryAgentHandoffDto,
  SessionDto,
  SystemSettingsDto,
  UserAttachmentDto,
} from "./types";
import type { AgentConversationPageDto, CodexPermissionsDto, WorkbenchAgentCardDto, WorkbenchChangeRequestDto, WorkbenchDetailDto, WorkbenchDto, WorkbenchWorkspaceDto, JoiAcceptedMessageDto, JoiActivityDto, JoiAttachmentDto, JoiHomeFeedDto, JoiSnapshotDto, ModelSourceAccessModeDto, ModelSourceDto, ModelSourceKindDto, ModelSourceProtocolDto, PartnerDto, PartnerEngineDto, PartnerKnowledgeDocDto, PartnerModelTestDto, PartnerPromptDto, ScenarioDto, ScenarioPackDto, ScenarioPackInstallResultDto } from "../shared/joi";
import type { RemoteAccessStatusDto } from "../shared/remote";
import type { AutomationDto, CreateAutomationInput, UpdateAutomationInput } from "../shared/automation";
import type { UpdateSystemSettingsInput } from "../shared/system-settings";
import { randomUuid } from "./random-uuid";
import type { EvolutionStatusDto } from "../shared/evolution";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
}

export class DigitalLifeApi {
  private csrfToken: string | null = null;

  constructor(readonly origin: string, readonly desktop = false) {}

  setCsrfToken(token: string) {
    this.csrfToken = token;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    if (method !== "GET" && this.csrfToken !== null) headers["x-csrf-token"] = this.csrfToken;
    const response = await fetch(`${this.origin}${path}`, {
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      credentials: "include",
      headers,
      method,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ code: "request_failed", message: "请求没成功。" })) as {
        code?: string; message?: string;
      };
      throw new ApiError(failure.code ?? "request_failed", failure.message ?? "请求没成功。", response.status);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  authStatus() { return this.request<{ configured: boolean }>("/api/v1/auth/status"); }
  bootstrap(nonce: string) { return this.request<{ csrfToken: string }>("/api/v1/auth/bootstrap", { body: { nonce }, method: "POST" }); }
  login(password: string) { return this.request<{ csrfToken: string }>("/api/v1/auth/login", { body: { password }, method: "POST" }); }
  setup(password: string) { return this.request<undefined>("/api/v1/auth/setup", { body: { password }, method: "POST" }); }
  logout() { return this.request<undefined>("/api/v1/auth/logout", { method: "POST" }); }
  listSessions() { return this.request<{ items: SessionDto[] }>("/api/v1/auth/sessions"); }
  logoutAllLan() { return this.request<undefined>("/api/v1/auth/logout-all", { method: "POST" }); }
  changePassword(currentPassword: string, newPassword: string) {
    return this.request<undefined>("/api/v1/auth/password", { body: { currentPassword, newPassword }, method: "POST" });
  }
  joiSnapshot() { return this.request<JoiSnapshotDto>("/api/v1/joi"); }
  listWorkbenches() { return this.request<{ items: WorkbenchDto[] }>("/api/v1/workbenches"); }
  evolutionStatus(workbenchId: string) { return this.request<EvolutionStatusDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}/evolution`); }
  configureEvolution(workbenchId: string, dailyCallLimit: number) { return this.request<EvolutionStatusDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}/evolution`, { method: "PATCH", body: { dailyCallLimit } }); }
  rollbackEvolution(workbenchId: string, revisionId: string) { return this.request<EvolutionStatusDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}/evolution/rollback`, { method: "POST", body: { revisionId } }); }
  evolutionNegativeFeedback(workbenchId: string, goalId: string) { return this.request<EvolutionStatusDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}/evolution/feedback`, { method: "POST", body: { goalId } }); }
  listAutomations() { return this.request<{ items: AutomationDto[] }>("/api/v1/automations"); }
  getAutomation(routineId: string) { return this.request<AutomationDto>(`/api/v1/automations/${encodeURIComponent(routineId)}`); }
  createAutomation(body: CreateAutomationInput) { return this.request<AutomationDto>("/api/v1/automations", { body: body as unknown as Record<string, unknown>, idempotencyKey: randomUuid(), method: "POST" }); }
  revealAutomationPrompt(routineId: string) { return this.request<{ prompt: string }>(`/api/v1/automations/${encodeURIComponent(routineId)}/prompt/reveal`, { idempotencyKey: randomUuid(), method: "POST" }); }
  updateAutomation(routineId: string, body: UpdateAutomationInput) { return this.request<AutomationDto>(`/api/v1/automations/${encodeURIComponent(routineId)}`, { body: body as unknown as Record<string, unknown>, idempotencyKey: randomUuid(), method: "PATCH" }); }
  runAutomationNow(routineId: string) { return this.request<AutomationDto>(`/api/v1/automations/${encodeURIComponent(routineId)}/run-now`, { idempotencyKey: randomUuid(), method: "POST" }); }
  deleteAutomation(routineId: string) { return this.request<undefined>(`/api/v1/automations/${encodeURIComponent(routineId)}`, { idempotencyKey: randomUuid(), method: "DELETE" }); }
  createWorkbench(body: { name: string; personaSummary: string; projectLabel: string; scopeSummary: string }) {
    return this.request<WorkbenchDto>("/api/v1/workbenches", { body, method: "POST" });
  }
  archiveWorkbench(workbenchId: string) {
    return this.request<WorkbenchChangeRequestDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}/archive`, { method: "POST" });
  }
  getWorkbench(workbenchId: string) { return this.request<WorkbenchDetailDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}`); }
  updateWorkbench(workbenchId: string, body: { name?: string; persona?: string; projectLabel?: string; responsibility?: string }) {
    return this.request<WorkbenchDetailDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}`, { body, method: "PATCH" });
  }
  bindWorkbenchWorkspace(workbenchId: string) {
    return this.request<WorkbenchWorkspaceDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}/workspace/bind`, { method: "POST" });
  }
  joiHomeFeed() { return this.request<JoiHomeFeedDto>("/api/v1/joi/home-feed"); }
  listWorkbenchAgents(workbenchId: string, options: { cursor?: string; goalId?: string; limit?: number } = {}) {
    const query = [
      ...(options.cursor === undefined ? [] : [`cursor=${encodeURIComponent(options.cursor)}`]),
      ...(options.goalId === undefined ? [] : [`goalId=${encodeURIComponent(options.goalId)}`]),
      ...(options.limit === undefined ? [] : [`limit=${encodeURIComponent(String(options.limit))}`]),
    ];
    const suffix = query.length === 0 ? "" : `?${query.join("&")}`;
    return this.request<{ items: WorkbenchAgentCardDto[]; nextCursor?: string }>(
      `/api/v1/workbenches/${encodeURIComponent(workbenchId)}/agents${suffix}`,
    );
  }
  agentConversation(workbenchId: string, agentId: string, options: { cursor?: string; goalId?: string; latest?: boolean; limit?: number } = {}) {
    const query = [
      ...(options.latest === true ? ["latest=true"] : []),
      ...(options.goalId === undefined ? [] : [`goalId=${encodeURIComponent(options.goalId)}`]),
      ...(options.cursor === undefined ? [] : [`cursor=${encodeURIComponent(options.cursor)}`]),
      ...(options.limit === undefined ? [] : [`limit=${encodeURIComponent(String(options.limit))}`]),
    ];
    const suffix = query.length === 0 ? "" : `?${query.join("&")}`;
    return this.request<AgentConversationPageDto>(
      `/api/v1/workbenches/${encodeURIComponent(workbenchId)}/agents/${encodeURIComponent(agentId)}/conversation${suffix}`,
    );
  }
  deleteWorkbenchAgent(workbenchId: string, agentId: string) {
    return this.request<undefined>(
      `/api/v1/workbenches/${encodeURIComponent(workbenchId)}/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" },
    );
  }
  openWorkbenchArtifact(workbenchId: string, input: {
    artifactId: string;
    mode: "OPEN" | "REVEAL";
    source: "AGENT" | "GOAL";
    sourceId: string;
  }) {
    return this.request<{ opened: true }>(
      `/api/v1/workbenches/${encodeURIComponent(workbenchId)}/artifacts/${encodeURIComponent(input.artifactId)}/open`,
      { body: { mode: input.mode, source: input.source, sourceId: input.sourceId }, method: "POST" },
    );
  }
  rebuildWorkbenchWorkspace(workbenchId: string) {
    return this.request<WorkbenchWorkspaceDto>(`/api/v1/workbenches/${encodeURIComponent(workbenchId)}/workspace/rebuild`, { method: "POST" });
  }
  decideWorkbenchChange(requestId: string, decision: "CONFIRM" | "REJECT") {
    return this.request<WorkbenchChangeRequestDto>(`/api/v1/workbench-change-requests/${encodeURIComponent(requestId)}/decision`, {
      body: { decision }, method: "POST",
    });
  }
  listJoiMessages() { return this.request<{ items: JoiAcceptedMessageDto[] }>("/api/v1/joi/messages"); }
  listJoiActivity() { return this.request<{ items: JoiActivityDto[] }>("/api/v1/joi/activity"); }
  sendJoiMessage(text: string, options: { attachmentIds?: string[]; workbenchId?: string } = {}) {
    return this.request<JoiAcceptedMessageDto>("/api/v1/joi/messages", {
      body: {
        text,
        ...(options.attachmentIds === undefined || options.attachmentIds.length === 0 ? {} : { attachmentIds: options.attachmentIds }),
        ...(options.workbenchId === undefined ? {} : { workbenchId: options.workbenchId }),
      },
      idempotencyKey: randomUuid(), method: "POST",
    });
  }
  clarifyJoiMessage(inputId: string, resolution: { actionChoice?: "RESUME" | "CONTINUE" | "ACCEPT_CURRENT"; partnerId?: string; questionId?: string; questionVersion?: number; workbenchId?: string; text?: string }) {
    return this.request<JoiAcceptedMessageDto>(`/api/v1/joi/messages/${encodeURIComponent(inputId)}/clarify`, {
      body: {
        ...(resolution.actionChoice === undefined ? {} : { actionChoice: resolution.actionChoice }),
        ...(resolution.partnerId === undefined ? {} : { partnerId: resolution.partnerId }),
        ...(resolution.questionId === undefined ? {} : { questionId: resolution.questionId }),
        ...(resolution.questionVersion === undefined ? {} : { questionVersion: resolution.questionVersion }),
        ...(resolution.workbenchId === undefined ? {} : { workbenchId: resolution.workbenchId }),
        ...(resolution.text === undefined ? {} : { text: resolution.text }),
      },
      method: "POST",
    });
  }
  cancelJoiMessage(inputId: string) {
    return this.request<JoiAcceptedMessageDto>(`/api/v1/joi/messages/${encodeURIComponent(inputId)}/cancel`, {
      method: "POST",
    });
  }
  closeHistoricalReview(inputId: string) {
    return this.request<JoiAcceptedMessageDto>(`/api/v1/joi/messages/${encodeURIComponent(inputId)}/close-historical-review`, {
      method: "POST",
    });
  }
  dismissJoiMessage(inputId: string) {
    return this.request<JoiAcceptedMessageDto>(`/api/v1/joi/messages/${encodeURIComponent(inputId)}/dismiss`, {
      method: "POST",
    });
  }
  retryJoiMessage(inputId: string, options: { text?: string } = {}) {
    return this.request<JoiAcceptedMessageDto>(`/api/v1/joi/messages/${encodeURIComponent(inputId)}/retry`, {
      body: {
        ...(options.text === undefined ? {} : { text: options.text }),
      },
      method: "POST",
    });
  }
  async uploadJoiAttachment(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return this.request<JoiAttachmentDto>("/api/v1/joi/attachments", {
      body: { bytes: btoa(binary), filename: file.name, mimeType: file.type || "application/octet-stream" },
      method: "POST",
    });
  }
  listModelSources() { return this.request<{ items: ModelSourceDto[] }>("/api/v1/model-sources"); }
  engineCatalog() {
    return this.request<{ items: { available: boolean; id: PartnerEngineDto; reason?: string; tools: string[] }[] }>("/api/v1/engines");
  }
  engineSkills(engine: PartnerEngineDto) {
    return this.request<{ items: { displayName: string; id: string }[] }>(`/api/v1/engines/${encodeURIComponent(engine)}/skills`);
  }
  scenarios() {
    return this.request<{ items: ScenarioDto[] }>("/api/v1/scenarios");
  }
  scenarioPacks() {
    return this.request<{ items: ScenarioPackDto[] }>("/api/v1/scenario-packs");
  }
  installScenarioPack(packId: string, teamIds?: string[]) {
    return this.request<ScenarioPackInstallResultDto>(`/api/v1/scenario-packs/${encodeURIComponent(packId)}/install`, {
      body: teamIds === undefined ? {} : { teamIds }, method: "POST",
    });
  }
  createScenarioPartners(scenarioId: string, roleIds: string[]) {
    return this.request<{ items: PartnerDto[] }>(`/api/v1/scenarios/${encodeURIComponent(scenarioId)}/partners`, {
      body: { roleIds }, method: "POST",
    });
  }
  createModelSource(body: { accessMode: ModelSourceAccessModeDto; apiKey: string; baseUrl?: string; displayName?: string; kind: ModelSourceKindDto; modelId?: string; protocol: ModelSourceProtocolDto }) {
    return this.request<ModelSourceDto>("/api/v1/model-sources", { body, method: "POST" });
  }
  validateModelSource(sourceId: string) {
    return this.request<ModelSourceDto>(`/api/v1/model-sources/${encodeURIComponent(sourceId)}/validate`, { method: "POST" });
  }
  updateModelSource(sourceId: string, body: Record<string, unknown>) {
    return this.request<ModelSourceDto>(`/api/v1/model-sources/${encodeURIComponent(sourceId)}`, { body, method: "PATCH" });
  }
  deleteModelSource(sourceId: string) {
    return this.request<undefined>(`/api/v1/model-sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
  }
  orderModelSources(sourceIds: string[]) {
    return this.request<{ items: ModelSourceDto[] }>("/api/v1/model-sources/order", { body: { sourceIds }, method: "PUT" });
  }
  listPartners() { return this.request<{ items: PartnerDto[] }>("/api/v1/partners"); }
  createPartner(body: {
    capabilities?: string[]; codexPermissions?: CodexPermissionsDto; description?: string; displayName: string; engine?: PartnerEngineDto; engineModelId?: string;
    kind: "a2a" | "local-pi"; modelIdOverride?: string; modelSourceId?: string; prompt?: string; skills: string[];
    toolPolicyMode?: "ALL" | "CUSTOM"; tools: string[];
  }) {
    return this.request<PartnerDto>("/api/v1/partners", { body, method: "POST" });
  }
  updatePartner(partnerId: string, body: {
    capabilities?: string[]; codexPermissions?: CodexPermissionsDto; description?: string; displayName: string; engine?: PartnerEngineDto; engineModelId?: string | null;
    modelIdOverride?: string | null; modelSourceId?: string | null; prompt?: string; promptMode?: "APPEND" | "REPLACE"; skills: string[]; toolPolicyMode?: "ALL" | "CUSTOM"; tools: string[];
  }) {
    return this.request<PartnerDto>(`/api/v1/partners/${encodeURIComponent(partnerId)}`, { body, method: "PATCH" });
  }
  revealPartnerPrompt(partnerId: string) {
    return this.request<PartnerPromptDto>(`/api/v1/partners/${encodeURIComponent(partnerId)}/prompt/reveal`, { method: "POST" });
  }
  testPartnerModel(partnerId: string) {
    return this.request<PartnerModelTestDto>(`/api/v1/partners/${encodeURIComponent(partnerId)}/test-model`, { method: "POST" });
  }
  setPartnerEnabled(partnerId: string, enabled: boolean) {
    return this.request<PartnerDto>(`/api/v1/partners/${encodeURIComponent(partnerId)}`, { body: { disabled: !enabled }, method: "PATCH" });
  }
  disablePartner(partnerId: string) {
    return this.request<PartnerDto>(`/api/v1/partners/${encodeURIComponent(partnerId)}`, { body: { disabled: true }, method: "PATCH" });
  }
  duplicatePartner(partnerId: string) {
    return this.request<PartnerDto>(`/api/v1/partners/${encodeURIComponent(partnerId)}/duplicate`, { method: "POST" });
  }
  deletePartner(partnerId: string) {
    return this.request<PartnerDto>(`/api/v1/partners/${encodeURIComponent(partnerId)}`, { method: "DELETE" });
  }
  listKnowledgeDocs(partnerId: string) {
    return this.request<{ items: PartnerKnowledgeDocDto[] }>(`/api/v1/partners/${encodeURIComponent(partnerId)}/knowledge`);
  }
  async uploadKnowledgeDoc(partnerId: string, file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return this.request<PartnerKnowledgeDocDto>(`/api/v1/partners/${encodeURIComponent(partnerId)}/knowledge`, {
      body: { contentBase64: btoa(binary), filename: file.name },
      method: "POST",
    });
  }
  deleteKnowledgeDoc(partnerId: string, docId: string) {
    return this.request<undefined>(`/api/v1/partners/${encodeURIComponent(partnerId)}/knowledge/${encodeURIComponent(docId)}`, { method: "DELETE" });
  }
  partnerMemory(workbenchId: string, partnerId: string) {
    return this.request<{
      entries: { createdAt: string; memoryId: string; outcome: string; partnerId: string; sessionDataSource: string; title: string; workId?: string }[];
      summary?: string;
      summaryUpdatedAt?: string;
    }>(`/api/v1/partners/${encodeURIComponent(partnerId)}/memory?workbenchId=${encodeURIComponent(workbenchId)}`);
  }
  listPartnerInstances(workbenchId: string, partnerId: string) {
    return this.request<{ items: {
      createdAt: string; engine: string; externalSessionRef?: string; instanceId: string; lastUsedAt: string;
      partnerId: string; sessionPolicy: string; status: string;
    }[] }>(`/api/v1/partners/${encodeURIComponent(partnerId)}/instances?workbenchId=${encodeURIComponent(workbenchId)}`);
  }
  listLives() { return this.request<{ items: LifeDto[] }>("/api/v1/lives?limit=100"); }
  getLife(lifeId: string) { return this.request<LifeDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}`); }
  createLife(body: Record<string, unknown>) {
    return this.request<LifeDto>("/api/v1/lives", { body, idempotencyKey: randomUuid(), method: "POST" });
  }
  updateLife(lifeId: string, body: Record<string, unknown>) {
    return this.request<LifeDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}`, { body, method: "PATCH" });
  }
  archiveLife(lifeId: string) {
    return this.request<LifeDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/archive`, { method: "POST" });
  }
  deleteLife(lifeId: string) {
    return this.request<undefined>(`/api/v1/lives/${encodeURIComponent(lifeId)}`, { method: "DELETE" });
  }
  getLifeDeletionImpact(lifeId: string) {
    return this.request<LifeDeletionImpactDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/deletion-impact`);
  }
  changePrimaryAgent(lifeId: string, agentConnectionId: string) {
    return this.request<{ handoff: PrimaryAgentHandoffDto; life: LifeDto }>(`/api/v1/lives/${encodeURIComponent(lifeId)}/primary-agent`, {
      body: { agentConnectionId }, method: "POST",
    });
  }
  runtime(lifeId: string, action: "cancel-run" | "emergency-stop" | "pause" | "resume" | "start" | "stop") {
    return this.request<LifeDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/runtime/${action}`, { method: "POST" });
  }
  emergencyStopAll() { return this.request<undefined>("/api/v1/runtime/emergency-stop", { method: "POST" }); }
  sendMessage(lifeId: string, text: string, attachmentIds?: string[]) {
    return this.request<LifeEventDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/messages`, {
      body: { text, ...(attachmentIds === undefined || attachmentIds.length === 0 ? {} : { attachmentIds }) }, idempotencyKey: randomUuid(), method: "POST",
    });
  }
  async uploadAttachment(lifeId: string, file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
    }
    return this.request<UserAttachmentDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/attachments`, {
      body: { bytes: btoa(binary), filename: file.name, mimeType: file.type || "application/octet-stream" },
      method: "POST",
    });
  }
  listEvents(lifeId: string) { return this.request<{ items: LifeEventDto[] }>(`/api/v1/lives/${encodeURIComponent(lifeId)}/events`); }
  listActivity(lifeId: string) { return this.request<{ items: LifeRuntimeActivityDto[] }>(`/api/v1/lives/${encodeURIComponent(lifeId)}/activity`); }
  listExpressions(lifeId: string) { return this.request<{ items: ExpressionDto[] }>(`/api/v1/lives/${encodeURIComponent(lifeId)}/expressions`); }
  continuity(lifeId: string) { return this.request<ContinuityDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/continuity`); }
  updateSchedule(lifeId: string, scheduleId: string, localTime: string, enabled: boolean) {
    return this.request<ContinuityDto["schedules"][number]>(`/api/v1/lives/${encodeURIComponent(lifeId)}/schedules/${encodeURIComponent(scheduleId)}`, {
      body: { enabled, localTime }, method: "PATCH",
    });
  }
  updateRhythm(lifeId: string, body: Record<string, unknown>) {
    return this.request<LifeDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/rhythm`, { body, method: "PATCH" });
  }
  listAgents() { return this.request<{ items: AgentDto[] }>("/api/v1/agents"); }
  addAgent(cardUrl: string, token: string) { return this.request<AgentDto>("/api/v1/agents", { body: { cardUrl, token }, method: "POST" }); }
  agentAction(agentId: string, action: "disable" | "enable" | "refresh", body?: Record<string, unknown>) {
    return this.request<AgentDto>(`/api/v1/agents/${encodeURIComponent(agentId)}/${action}`, { ...(body === undefined ? {} : { body }), method: "POST" });
  }
  getAgentDeletionImpact(agentId: string) {
    return this.request<{ activeInvocations: number; bindings: { lifeId: string; name: string; role: "COLLABORATOR" | "PRIMARY" }[] }>(`/api/v1/agents/${encodeURIComponent(agentId)}/deletion-impact`);
  }
  deleteAgent(agentId: string) { return this.request<undefined>(`/api/v1/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" }); }
  rotateAgentToken(agentId: string, token: string) {
    return this.request<AgentDto>(`/api/v1/agents/${encodeURIComponent(agentId)}/rotate-token`, { body: { token }, method: "POST" });
  }
  bindCollaborator(lifeId: string, agentConnectionId: string) {
    return this.request<{ items: AgentDto[] }>(`/api/v1/lives/${encodeURIComponent(lifeId)}/collaborators`, {
      body: { agentConnectionId }, method: "POST",
    });
  }
  unbindCollaborator(lifeId: string, agentConnectionId: string) {
    return this.request<{ items: AgentDto[] }>(`/api/v1/lives/${encodeURIComponent(lifeId)}/collaborators/${encodeURIComponent(agentConnectionId)}`, { method: "DELETE" });
  }
  listInteractions() { return this.request<{ items: InteractionDto[] }>("/api/v1/interactions"); }
  answerInteraction(interactionId: string, answer: string) {
    return this.request<InteractionDto>(`/api/v1/interactions/${encodeURIComponent(interactionId)}/answer`, { body: { answer }, method: "POST" });
  }
  resumeAuthorization(interactionId: string) {
    return this.request<InteractionDto>(`/api/v1/interactions/${encodeURIComponent(interactionId)}/resume-authorization`, { method: "POST" });
  }
  extendBudget(lifeId: string, autonomousWakes = 6, invocations = 20) {
    return this.request<ContinuityDto["budget"]>(`/api/v1/lives/${encodeURIComponent(lifeId)}/budget/extend`, {
      body: { autonomousWakes, invocations }, method: "POST",
    });
  }
  remindTodo(lifeId: string, todoId: string) {
    return this.request<LifeEventDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/todos/${encodeURIComponent(todoId)}/remind`, { method: "POST" });
  }
  createTodo(lifeId: string, title: string, options: string | { affairId?: string; assignee?: string; dueAt?: string } = {}) {
    const fields = typeof options === "string" ? { dueAt: options } : options;
    return this.request<LifeEventDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/todos`, { body: { title, ...fields }, method: "POST" });
  }
  updateTodo(lifeId: string, todoId: string, body: Record<string, unknown>) {
    return this.request<LifeEventDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/todos/${encodeURIComponent(todoId)}`, { body, method: "PATCH" });
  }
  createAlarm(lifeId: string, reason: string, nextAt: string, options: { allowQuietHours?: boolean; recurrenceRule?: "DAILY" | "WEEKDAYS" | "WEEKENDS" | "WEEKLY"; repeatEveryMinutes?: number } = {}) {
    return this.request<LifeEventDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/alarms`, { body: { nextAt, reason, ...options }, method: "POST" });
  }
  cancelAlarm(lifeId: string, alarmId: string) {
    return this.request<LifeEventDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/alarms/${encodeURIComponent(alarmId)}`, { method: "DELETE" });
  }
  correctMemory(lifeId: string, memoryId: string, content: string) {
    return this.request<LifeEventDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/memories/${encodeURIComponent(memoryId)}/correct`, {
      body: { content }, method: "POST",
    });
  }
  forgetMemory(lifeId: string, memoryId: string) {
    return this.request<LifeEventDto>(`/api/v1/lives/${encodeURIComponent(lifeId)}/memories/${encodeURIComponent(memoryId)}/forget`, { method: "POST" });
  }
  artifactUrl(lifeId: string, artifactId: string, mode: "download" | "preview") {
    return `${this.origin}/api/v1/lives/${encodeURIComponent(lifeId)}/artifacts/${encodeURIComponent(artifactId)}/${mode}`;
  }
  diagnostics() { return this.request<DiagnosticsDto>("/api/v1/diagnostics"); }
  diagnosticsExportUrl() { return `${this.origin}/api/v1/diagnostics/export`; }
  settings() { return this.request<SystemSettingsDto>("/api/v1/settings"); }
  updateSettings(body: UpdateSystemSettingsInput) { return this.request<SystemSettingsDto>("/api/v1/settings", { body: body as Record<string, unknown>, method: "POST" }); }
  remoteAccessStatus() { return this.request<RemoteAccessStatusDto>("/api/v1/remote"); }
  updateRemoteAccess(body: { enabled?: boolean; relayAuthentication?: string | null; relayUrl?: string }) {
    return this.request<RemoteAccessStatusDto>("/api/v1/remote", { body, method: "POST" });
  }
  createRemotePairing() { return this.request<RemoteAccessStatusDto>("/api/v1/remote/pairings", { method: "POST" }); }
  revokeRemoteDevice(deviceId: string) {
    return this.request<RemoteAccessStatusDto>(`/api/v1/remote/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  }
  listBackups() { return this.request<{ items: BackupDto[] }>("/api/v1/backups"); }
  createBackup() { return this.request<BackupDto>("/api/v1/backups", { method: "POST" }); }
  restoreBackup(backupId: string) {
    return this.request<{ backupId: string; restartRequired: true }>(`/api/v1/backups/${encodeURIComponent(backupId)}/restore`, { method: "POST" });
  }
}

export async function createApi(): Promise<{ api: DigitalLifeApi; configured: boolean; desktop: boolean }> {
  const bridge = window.digitalLifeDesktop;
  const runtimeInfo = bridge === undefined ? undefined : await bridge.getRuntimeInfo();
  const origin = import.meta.env.DEV ? window.location.origin : runtimeInfo?.apiOrigin ?? window.location.origin;
  const api = new DigitalLifeApi(origin, bridge !== undefined);
  const { configured } = await api.authStatus();
  if (bridge !== undefined) {
    const nonce = await bridge.createBootstrapNonce();
    const grant = await api.bootstrap(nonce.nonce);
    api.setCsrfToken(grant.csrfToken);
  }
  return { api, configured, desktop: bridge !== undefined };
}
