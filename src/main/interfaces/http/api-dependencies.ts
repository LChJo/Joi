import type { AgentService } from "../../application/agents/agent-service.js";
import type { AgentOnboardingService } from "../../application/agents/agent-onboarding-service.js";
import type { InteractionService } from "../../application/agents/interaction-service.js";
import type { AuthService } from "../../application/auth/auth-service.js";
import type { EventService } from "../../application/events/event-service.js";
import type { ContinuityService } from "../../application/continuity/continuity-service.js";
import type { LifeService } from "../../application/lives/life-service.js";
import type { OperationsService } from "../../application/operations/operations-service.js";
import type { ModelSourceService } from "../../application/model-sources/model-source-service.js";
import type { JoiInboxService } from "../../application/joi/joi-inbox-service.js";
import type { WorkbenchRegistryService } from "../../application/joi/workbench-registry-service.js";
import type { WorkbenchChangeService } from "../../application/joi/workbench-change-service.js";
import type { WorkbenchManagementService } from "../../application/joi/workbench-management-service.js";
import type { WorkbenchWorkspaceService } from "../../application/joi/workbench-workspace-service.js";
import type { JoiHomeFeedService } from "../../application/joi/joi-home-feed-service.js";
import type { WorkbenchAgentService } from "../../application/partners/workbench-agent-service.js";
import type { PartnerRegistryService } from "../../application/partners/partner-registry-service.js";
import type { PartnerKnowledgeService } from "../../application/partners/partner-knowledge-service.js";
import type { PartnerModelProbeService } from "../../application/partners/partner-model-probe-service.js";
import type { PartnerEngineCatalog } from "../../application/partners/partner-engine-catalog.js";
import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import type { PartnerWorkMemoryService } from "../../application/partners/partner-work-memory-service.js";
import type { PartnerSkillCatalog } from "../../application/ports/partner-skills.js";
import type { WorkbenchCatalog } from "../../application/ports/workbench-context.js";
import type { SystemSettingsPort } from "../../application/ports/system-settings.js";
import type { ArtifactReadPort, JoiAttachmentPort } from "../../application/ports/managed-file-ports.js";
import type { WorkQuery } from "../../application/ports/work-orchestration.js";
import type { JoiActivityDto, PartnerEngineDto } from "../../../shared/joi.js";
import { csrfToken, expectedOrigin, HttpError, optionalStringField, requestAddress, requestOrigin, sessionToken } from "./http-core.js";
import type { IncomingMessage } from "node:http";

export interface ApiDependencies {
  agentOnboarding?: AgentOnboardingService;
  agents: AgentService;
  artifacts?: ArtifactReadPort;
  workbenchRegistry?: Pick<WorkbenchRegistryService, "create">;
  workbenchManagement?: Pick<WorkbenchManagementService, "get" | "update">;
  workbenchWorkspaces?: Pick<WorkbenchWorkspaceService, "bindExisting" | "rebuildManaged">;
  workbenchAgents?: Pick<WorkbenchAgentService, "conversation" | "dismiss" | "list">;
  workbenchChanges?: Pick<WorkbenchChangeService, "decide" | "listPending">;
  workbenches?: WorkbenchCatalog;
  auth: AuthService;
  continuity?: ContinuityService;
  events?: EventService;
  globalEmergencyStop?: () => Promise<void>;
  interactions?: InteractionService;
  joiInbox?: Pick<JoiInboxService, "accept" | "cancel" | "clarify" | "dismiss" | "list" | "retry">;
  joiHomeFeed?: Pick<JoiHomeFeedService, "load">;
  joiActivity?: { listActivity(limit?: number): Promise<JoiActivityDto[]> };
  joiAttachments?: JoiAttachmentPort;
  engines?: Pick<PartnerEngineCatalog, "assertAvailable" | "list">;
  instances?: Pick<PartnerInstanceManager, "list">;
  knowledge?: Pick<PartnerKnowledgeService, "add" | "list" | "remove">;
  partnerModelProbe?: Pick<PartnerModelProbeService, "test">;
  memory?: Pick<PartnerWorkMemoryService, "debugView">;
  skills?: Pick<PartnerSkillCatalog, "listForEngine">;
  directoryPicker?: () => Promise<string | null>;
  lives: LifeService;
  modelSources?: Pick<ModelSourceService, "create" | "delete" | "disable" | "hasReadySource" | "list" | "setOrder" | "update" | "validate">;
  operations: OperationsService;
  partners?: Pick<PartnerRegistryService, "add" | "delete" | "disable" | "duplicate" | "enable" | "list" | "update">;
  requestRestart?: () => void;
  settings?: SystemSettingsPort;
  work?: WorkQuery;
}

export async function verifyWrite(dependencies: ApiDependencies, request: IncomingMessage): Promise<void> {
  await dependencies.auth.verifyWrite({
    csrfToken: csrfToken(request),
    expectedOrigin: expectedOrigin(request),
    origin: requestOrigin(request),
    remoteAddress: requestAddress(request),
    sessionToken: sessionToken(request),
  });
}

export function onboardingService(dependencies: ApiDependencies): AgentOnboardingService {
  if (dependencies.agentOnboarding === undefined) throw new HttpError("agent_gateway_unavailable", "Agent Gateway is unavailable.", 503);
  return dependencies.agentOnboarding;
}

export function eventService(dependencies: ApiDependencies): EventService {
  if (dependencies.events === undefined) throw new HttpError("runtime_unavailable", "Event Runtime is unavailable.", 503);
  return dependencies.events;
}

export function continuityService(dependencies: ApiDependencies): ContinuityService {
  if (dependencies.continuity === undefined) throw new HttpError("runtime_unavailable", "Continuity Runtime is unavailable.", 503);
  return dependencies.continuity;
}

export function interactionService(dependencies: ApiDependencies): InteractionService {
  if (dependencies.interactions === undefined) throw new HttpError("runtime_unavailable", "Interaction Runtime is unavailable.", 503);
  return dependencies.interactions;
}

export function artifactService(dependencies: ApiDependencies): ArtifactReadPort {
  if (dependencies.artifacts === undefined) throw new HttpError("artifact_service_unavailable", "Artifact storage is unavailable.", 503);
  return dependencies.artifacts;
}

export function modelSourceService(dependencies: ApiDependencies): NonNullable<ApiDependencies["modelSources"]> {
  if (dependencies.modelSources === undefined) throw new HttpError("model_source_runtime_unavailable", "Model source runtime is unavailable.", 503);
  return dependencies.modelSources;
}

export function joiInboxService(dependencies: ApiDependencies): NonNullable<ApiDependencies["joiInbox"]> {
  if (dependencies.joiInbox === undefined) throw new HttpError("joi_runtime_unavailable", "joi runtime is unavailable.", 503);
  return dependencies.joiInbox;
}

export function partnerRegistryService(dependencies: ApiDependencies): NonNullable<ApiDependencies["partners"]> {
  if (dependencies.partners === undefined) throw new HttpError("partner_registry_unavailable", "Partner registry is unavailable.", 503);
  return dependencies.partners;
}

export function partnerModelProbeService(dependencies: ApiDependencies): NonNullable<ApiDependencies["partnerModelProbe"]> {
  if (dependencies.partnerModelProbe === undefined) throw new HttpError("partner_model_probe_unavailable", "Partner model probe is unavailable.", 503);
  return dependencies.partnerModelProbe;
}

export function rejectPartnerWorkspace(body: Record<string, unknown>): void {
  if (body.workspaceRef !== undefined || body.cwd !== undefined) {
    throw new HttpError("partner_workspace_forbidden", "Partner templates cannot own a workspace.", 400);
  }
}

export function partnerKnowledgeService(dependencies: ApiDependencies): NonNullable<ApiDependencies["knowledge"]> {
  if (dependencies.knowledge === undefined) throw new HttpError("partner_knowledge_unavailable", "Partner knowledge is unavailable.", 503);
  return dependencies.knowledge;
}

export function partnerInstanceManager(dependencies: ApiDependencies): NonNullable<ApiDependencies["instances"]> {
  if (dependencies.instances === undefined) throw new HttpError("partner_instances_unavailable", "Partner instances are unavailable.", 503);
  return dependencies.instances;
}

export function partnerEngineCatalog(dependencies: ApiDependencies): NonNullable<ApiDependencies["engines"]> {
  if (dependencies.engines === undefined) throw new HttpError("partner_engines_unavailable", "Partner engines are unavailable.", 503);
  return dependencies.engines;
}

export function partnerSkillCatalog(dependencies: ApiDependencies): NonNullable<ApiDependencies["skills"]> {
  if (dependencies.skills === undefined) throw new HttpError("partner_skills_unavailable", "Partner skills are unavailable.", 503);
  return dependencies.skills;
}

export function partnerEngineParam(value: string): PartnerEngineDto {
  if (value === "pi-core" || value === "claude-code" || value === "codex") return value;
  throw new HttpError("partner_engine_invalid", "Partner engine is invalid.", 400);
}

export async function assertLocalEngineAvailable(dependencies: ApiDependencies, engine: PartnerEngineDto | undefined): Promise<void> {
  if (engine === undefined || engine === "pi-core") return;
  try {
    await partnerEngineCatalog(dependencies).assertAvailable(engine);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      throw new HttpError(error.code, error.message, 409);
    }
    throw error;
  }
}

export function partnerEngineField(body: Record<string, unknown>): PartnerEngineDto | undefined {
  const value = optionalStringField(body, "engine");
  if (value === null || value === undefined) return undefined;
  return partnerEngineParam(value);
}

export function workbenchChangeService(dependencies: ApiDependencies): NonNullable<ApiDependencies["workbenchChanges"]> {
  if (dependencies.workbenchChanges === undefined) throw new HttpError("workbench_change_runtime_unavailable", "Workbench change runtime is unavailable.", 503);
  return dependencies.workbenchChanges;
}

export function workbenchAgentService(dependencies: ApiDependencies): NonNullable<ApiDependencies["workbenchAgents"]> {
  if (dependencies.workbenchAgents === undefined) throw new HttpError("workbench_agent_runtime_unavailable", "Workbench Agent runtime is unavailable.", 503);
  return dependencies.workbenchAgents;
}

export function joiHomeFeedService(dependencies: ApiDependencies): NonNullable<ApiDependencies["joiHomeFeed"]> {
  if (dependencies.joiHomeFeed === undefined) throw new HttpError("joi_home_feed_unavailable", "joi home feed is unavailable.", 503);
  return dependencies.joiHomeFeed;
}
