import type { IncomingMessage, ServerResponse } from "node:http";

import type { AgentService } from "../../application/agents/agent-service.js";
import type { AgentOnboardingService } from "../../application/agents/agent-onboarding-service.js";
import type { InteractionService } from "../../application/agents/interaction-service.js";
import { AuthError, type AuthService, type SessionGrant } from "../../application/auth/auth-service.js";
import type { EventService } from "../../application/events/event-service.js";
import type { ContinuityService } from "../../application/continuity/continuity-service.js";
import type { LifeRuntimeService } from "../../application/lives/life-runtime-service.js";
import type { LifeService } from "../../application/lives/life-service.js";
import type { OperationsService } from "../../application/operations/operations-service.js";
import type { ModelSourceService } from "../../application/model-sources/model-source-service.js";
import type { JoiInboxService } from "../../application/joi/joi-inbox-service.js";
import type { AvatarRegistryService } from "../../application/joi/avatar-registry-service.js";
import type { AvatarChangeService } from "../../application/joi/avatar-change-service.js";
import type { PartnerRegistryService } from "../../application/partners/partner-registry-service.js";
import type { PartnerKnowledgeService } from "../../application/partners/partner-knowledge-service.js";
import type { PartnerEngineCatalog } from "../../application/partners/partner-engine-catalog.js";
import type { PartnerInstanceManager } from "../../application/partners/partner-instance-manager.js";
import type { PartnerWorkMemoryService } from "../../application/partners/partner-work-memory-service.js";
import type { PartnerSkillCatalog } from "../../application/ports/partner-skills.js";
import type { AvatarCatalog } from "../../application/ports/avatar-context.js";
import type { SseService } from "../../application/sse/sse-service.js";
import type { BudgetService } from "../../application/rhythm/budget-service.js";
import type { SystemSettingsPort } from "../../application/ports/system-settings.js";
import type { ArtifactReadPort, JoiAttachmentPort, UserAttachmentPort } from "../../application/ports/managed-file-ports.js";
import type { WorkQuery } from "../../application/ports/work-orchestration.js";
import { BUILTIN_SCENARIOS, type JoiActivityDto, type PartnerEngineDto } from "../../../shared/joi.js";

const SESSION_COOKIE = "digital_life_session";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_REQUEST_BYTES = 14 * 1024 * 1024;

export interface ApiDependencies {
  agentOnboarding?: AgentOnboardingService;
  agents: AgentService;
  attachments?: UserAttachmentPort;
  artifacts?: ArtifactReadPort;
  avatarRegistry?: Pick<AvatarRegistryService, "create">;
  avatarChanges?: Pick<AvatarChangeService, "decide" | "listPending">;
  avatars?: AvatarCatalog;
  auth: AuthService;
  budgets?: BudgetService;
  continuity?: ContinuityService;
  events?: EventService;
  globalEmergencyStop?: () => Promise<void>;
  interactions?: InteractionService;
  joiInbox?: Pick<JoiInboxService, "accept" | "list">;
  joiActivity?: { listActivity(limit?: number): Promise<JoiActivityDto[]> };
  joiAttachments?: JoiAttachmentPort;
  engines?: Pick<PartnerEngineCatalog, "assertAvailable" | "list">;
  instances?: Pick<PartnerInstanceManager, "list">;
  knowledge?: Pick<PartnerKnowledgeService, "add" | "list" | "remove">;
  memory?: Pick<PartnerWorkMemoryService, "debugView">;
  skills?: Pick<PartnerSkillCatalog, "listForEngine">;
  directoryPicker?: () => Promise<string | null>;
  onJoiMessageAccepted?: (inputId: string) => void;
  onModelSourceReady?: () => void;
  lives: LifeService;
  lifeRuntime?: LifeRuntimeService;
  modelSources?: Pick<ModelSourceService, "create" | "delete" | "disable" | "hasReadySource" | "list" | "setOrder" | "update" | "validate">;
  operations: OperationsService;
  partners?: Pick<PartnerRegistryService, "add" | "delete" | "disable" | "duplicate" | "enable" | "list" | "update">;
  requestRestart?: () => void;
  sse: SseService;
  settings?: SystemSettingsPort;
  wakeCoordinator?: { emergencyStop(avatarId: string): void; notify(avatarId: string): void };
  work?: WorkQuery;
}

function onboardingService(dependencies: ApiDependencies): AgentOnboardingService {
  if (dependencies.agentOnboarding === undefined) throw new HttpError("agent_gateway_unavailable", "Agent Gateway is unavailable.", 503);
  return dependencies.agentOnboarding;
}

function eventService(dependencies: ApiDependencies): EventService {
  if (dependencies.events === undefined) throw new HttpError("runtime_unavailable", "Event Runtime is unavailable.", 503);
  return dependencies.events;
}

function continuityService(dependencies: ApiDependencies): ContinuityService {
  if (dependencies.continuity === undefined) throw new HttpError("runtime_unavailable", "Continuity Runtime is unavailable.", 503);
  return dependencies.continuity;
}

function budgetService(dependencies: ApiDependencies): BudgetService {
  if (dependencies.budgets === undefined) throw new HttpError("runtime_unavailable", "Budget Runtime is unavailable.", 503);
  return dependencies.budgets;
}

function lifeRuntimeService(dependencies: ApiDependencies): LifeRuntimeService {
  if (dependencies.lifeRuntime === undefined) throw new HttpError("runtime_unavailable", "Life Runtime is unavailable.", 503);
  return dependencies.lifeRuntime;
}

function interactionService(dependencies: ApiDependencies): InteractionService {
  if (dependencies.interactions === undefined) throw new HttpError("runtime_unavailable", "Interaction Runtime is unavailable.", 503);
  return dependencies.interactions;
}

function artifactService(dependencies: ApiDependencies): ArtifactReadPort {
  if (dependencies.artifacts === undefined) throw new HttpError("artifact_service_unavailable", "Artifact storage is unavailable.", 503);
  return dependencies.artifacts;
}

function attachmentService(dependencies: ApiDependencies): UserAttachmentPort {
  if (dependencies.attachments === undefined) throw new HttpError("attachment_service_unavailable", "Message attachment storage is unavailable.", 503);
  return dependencies.attachments;
}

function modelSourceService(dependencies: ApiDependencies): NonNullable<ApiDependencies["modelSources"]> {
  if (dependencies.modelSources === undefined) throw new HttpError("model_source_runtime_unavailable", "Model source runtime is unavailable.", 503);
  return dependencies.modelSources;
}

function joiInboxService(dependencies: ApiDependencies): NonNullable<ApiDependencies["joiInbox"]> {
  if (dependencies.joiInbox === undefined) throw new HttpError("joi_runtime_unavailable", "joi runtime is unavailable.", 503);
  return dependencies.joiInbox;
}

function partnerRegistryService(dependencies: ApiDependencies): NonNullable<ApiDependencies["partners"]> {
  if (dependencies.partners === undefined) throw new HttpError("partner_registry_unavailable", "Partner registry is unavailable.", 503);
  return dependencies.partners;
}

function partnerKnowledgeService(dependencies: ApiDependencies): NonNullable<ApiDependencies["knowledge"]> {
  if (dependencies.knowledge === undefined) throw new HttpError("partner_knowledge_unavailable", "Partner knowledge is unavailable.", 503);
  return dependencies.knowledge;
}

function partnerMemoryService(dependencies: ApiDependencies): NonNullable<ApiDependencies["memory"]> {
  if (dependencies.memory === undefined) throw new HttpError("partner_memory_unavailable", "Partner work memory is unavailable.", 503);
  return dependencies.memory;
}

function partnerInstanceManager(dependencies: ApiDependencies): NonNullable<ApiDependencies["instances"]> {
  if (dependencies.instances === undefined) throw new HttpError("partner_instances_unavailable", "Partner instances are unavailable.", 503);
  return dependencies.instances;
}

function partnerEngineCatalog(dependencies: ApiDependencies): NonNullable<ApiDependencies["engines"]> {
  if (dependencies.engines === undefined) throw new HttpError("partner_engines_unavailable", "Partner engines are unavailable.", 503);
  return dependencies.engines;
}

function partnerSkillCatalog(dependencies: ApiDependencies): NonNullable<ApiDependencies["skills"]> {
  if (dependencies.skills === undefined) throw new HttpError("partner_skills_unavailable", "Partner skills are unavailable.", 503);
  return dependencies.skills;
}

function partnerEngineParam(value: string): PartnerEngineDto {
  if (value === "pi-core" || value === "claude-code" || value === "codex") return value;
  throw new HttpError("partner_engine_invalid", "Partner engine is invalid.", 400);
}

async function assertLocalEngineAvailable(dependencies: ApiDependencies, engine: PartnerEngineDto | undefined): Promise<void> {
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

function avatarChangeService(dependencies: ApiDependencies): NonNullable<ApiDependencies["avatarChanges"]> {
  if (dependencies.avatarChanges === undefined) throw new HttpError("avatar_change_runtime_unavailable", "Avatar change runtime is unavailable.", 503);
  return dependencies.avatarChanges;
}

function artifactDisposition(filename: string, mode: "attachment" | "inline"): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "artifact";
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export type ApiHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

interface ApiErrorBody {
  code: string;
  details?: Record<string, unknown>;
  message: string;
  requestId: string;
}

function requestAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function expectedOrigin(request: IncomingMessage): string {
  const host = request.headers.host;
  return host === undefined ? "" : `http://${host}`;
}

function requestOrigin(request: IncomingMessage): string {
  const origin = request.headers.origin;
  if (typeof origin === "string") return origin;
  if (Array.isArray(origin)) return typeof origin[0] === "string" ? origin[0] : "";
  return "";
}

function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function sessionToken(request: IncomingMessage): string {
  return parseCookies(request).get(SESSION_COOKIE) ?? "";
}

function csrfToken(request: IncomingMessage): string {
  const header = request.headers["x-csrf-token"];
  return Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
}

function sessionCookie(grant: SessionGrant): string {
  return `${SESSION_COOKIE}=${grant.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError("request_too_large", `Request body exceeds ${String(Math.floor(maxBytes / 1024 / 1024))} MiB.`, 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError("request_json_invalid", "Request body must be a JSON object.", 400);
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError("request_field_invalid", `${key} must be a string.`, 400);
  return value;
}

function optionalStringField(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null || typeof value === "string") return value;
  throw new HttpError("request_field_invalid", `${key} must be a string or null.`, 400);
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError("request_field_invalid", `${key} must be an array of strings.`, 400);
  }
  return value as string[];
}

function integerField(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isInteger(value)) throw new HttpError("request_field_invalid", `${key} must be an integer.`, 400);
  return value as number;
}

function partnerEngineField(body: Record<string, unknown>): PartnerEngineDto | undefined {
  const value = optionalStringField(body, "engine");
  if (value === null || value === undefined) return undefined;
  return partnerEngineParam(value);
}

function base64Field(body: Record<string, unknown>, key: string): Uint8Array {
  const value = stringField(body, key);
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new HttpError("request_field_invalid", `${key} must be canonical base64.`, 400);
  }
  return Buffer.from(value, "base64");
}

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(payload));
}

function sendEmpty(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

function encodeCursor(sequence: number): string {
  return `sse_${Buffer.from(String(sequence)).toString("base64url")}`;
}

function decodeCursor(cursor: string | null): number {
  if (cursor === null || cursor === "") return 0;
  if (!cursor.startsWith("sse_")) throw new HttpError("stream_cursor_invalid", "SSE cursor is invalid.", 400);
  const decoded = Buffer.from(cursor.slice(4), "base64url").toString("utf8");
  if (!/^\d+$/.test(decoded)) throw new HttpError("stream_cursor_invalid", "SSE cursor is invalid.", 400);
  return Number(decoded);
}

class HttpError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

function errorDetails(error: unknown, requestId: string): { body: ApiErrorBody; status: number } {
  if (error instanceof AuthError || error instanceof HttpError) {
    return { body: { code: error.code, message: error.message, requestId }, status: error.status };
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const status = error.code.endsWith("_not_found") ? 404 : 400;
    return { body: { code: error.code, message: error.message, requestId }, status };
  }
  return { body: { code: "internal_error", message: "The request could not be completed.", requestId }, status: 500 };
}

async function verifyWrite(dependencies: ApiDependencies, request: IncomingMessage): Promise<void> {
  await dependencies.auth.verifyWrite({
    csrfToken: csrfToken(request),
    expectedOrigin: expectedOrigin(request),
    origin: requestOrigin(request),
    remoteAddress: requestAddress(request),
    sessionToken: sessionToken(request),
  });
}

function lifeCursor(value: string | null): { createdAt: string; lifeId: string } | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object") throw new Error("invalid cursor");
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.createdAt !== "string" || typeof candidate.lifeId !== "string") throw new Error("invalid cursor");
    return { createdAt: candidate.createdAt, lifeId: candidate.lifeId };
  } catch {
    throw new HttpError("cursor_invalid", "List cursor is invalid.", 400);
  }
}

function encodeLifeCursor(cursor: { createdAt: string; lifeId: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function eventCursor(value: string | null): { eventId: string; occurredAt: string } | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid cursor");
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.eventId !== "string" || typeof candidate.occurredAt !== "string") throw new Error("invalid cursor");
    return { eventId: candidate.eventId, occurredAt: candidate.occurredAt };
  } catch {
    throw new HttpError("cursor_invalid", "Event cursor is invalid.", 400);
  }
}

function encodeEventCursor(cursor: { eventId: string; occurredAt: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

async function streamEvents(dependencies: ApiDependencies, request: IncomingMessage, response: ServerResponse, cursor: number): Promise<void> {
  await dependencies.auth.authenticate(sessionToken(request));
  response.writeHead(200, {
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();
  const writeEvent = (event: Awaited<ReturnType<SseService["listAfter"]>>[number]) => {
    response.write(`id: ${encodeCursor(event.sequence)}\nevent: ${event.type}\ndata: ${JSON.stringify({ createdAt: event.createdAt, entityId: event.entityId, payload: event.payload })}\n\n`);
  };
  const replay = await dependencies.sse.replayAfter(cursor, 1000);
  if (replay.resetRequired) {
    response.write(`id: ${encodeCursor(replay.latestSequence)}\nevent: stream_reset\ndata: ${JSON.stringify({
      createdAt: new Date().toISOString(),
      entityId: "runtime",
      payload: {
        reason: "cursor_expired",
        resourcePaths: ["/api/v1/lives", "/api/v1/agents", "/api/v1/interactions", "/api/v1/diagnostics"],
        snapshotRequired: true,
      },
    })}\n\n`);
  } else {
    for (const event of replay.events) writeEvent(event);
  }
  const unsubscribe = dependencies.sse.subscribe(writeEvent);
  const keepAlive = setInterval(() => response.write(": keepalive\n\n"), 20_000);
  keepAlive.unref();
  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    response.end();
  });
}

export function createApiHandler(dependencies: ApiDependencies): ApiHandler {
  let requestSequence = 0;
  return async (request, response) => {
    const requestId = `req_${Date.now().toString(36)}_${String(++requestSequence)}`;
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", expectedOrigin(request) || "http://127.0.0.1");
      const pathname = url.pathname;

      if (method === "GET" && pathname === "/api/v1/health") {
        sendJson(response, 200, { database: "open", status: "ok" });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/auth/status") {
        sendJson(response, 200, { configured: await dependencies.auth.isConfigured() });
        return;
      }
      const artifactMatch = /^\/api\/v1\/lives\/([^/]+)\/artifacts\/([^/]+)\/(download|preview)$/.exec(pathname);
      if (method === "GET" && artifactMatch !== null) {
        await dependencies.auth.authenticate(sessionToken(request));
        const mode = artifactMatch[3] === "preview" ? "inline" : "attachment";
        const content = await artifactService(dependencies).read({
          artifactId: decodeURIComponent(artifactMatch[2] ?? ""),
          lifeId: decodeURIComponent(artifactMatch[1] ?? ""),
          preview: mode === "inline",
        });
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-disposition": artifactDisposition(content.filename, mode),
          "content-length": String(content.bytes.byteLength),
          "content-security-policy": "sandbox; default-src 'none'",
          "content-type": content.mimeType,
          "x-content-type-options": "nosniff",
        });
        response.end(content.bytes);
        return;
      }
      if (method === "POST" && pathname === "/api/v1/auth/bootstrap") {
        const body = await readJson(request);
        const grant = await dependencies.auth.exchangeDesktopBootstrap({
          nonce: stringField(body, "nonce"),
          remoteAddress: requestAddress(request),
        });
        sendJson(response, 200, { csrfToken: grant.csrfToken, expiresAt: grant.expiresAt }, { "set-cookie": sessionCookie(grant) });
        return;
      }
      if (method === "POST" && pathname === "/api/v1/auth/login") {
        const body = await readJson(request);
        const grant = await dependencies.auth.login({
          expectedOrigin: expectedOrigin(request),
          origin: requestOrigin(request),
          password: stringField(body, "password"),
          remoteAddress: requestAddress(request),
        });
        sendJson(response, 200, { csrfToken: grant.csrfToken, expiresAt: grant.expiresAt }, { "set-cookie": sessionCookie(grant) });
        return;
      }
      if (method === "POST" && pathname === "/api/v1/auth/setup") {
        const body = await readJson(request);
        await dependencies.auth.setupPassword({
          csrfToken: csrfToken(request),
          origin: requestOrigin(request),
          password: stringField(body, "password"),
          remoteAddress: requestAddress(request),
          sessionToken: sessionToken(request),
        });
        sendEmpty(response, 204);
        return;
      }
      if (method === "GET" && pathname === "/api/v1/stream") {
        await streamEvents(dependencies, request, response, decodeCursor(url.searchParams.get("cursor") ?? request.headers["last-event-id"] as string | null));
        return;
      }

      await dependencies.auth.authenticate(sessionToken(request));

      if (method === "GET" && pathname === "/api/v1/auth/session") {
        sendJson(response, 200, { authenticated: true });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/auth/sessions") {
        sendJson(response, 200, { items: await dependencies.auth.listSessions(sessionToken(request)) });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/model-sources") {
        sendJson(response, 200, { items: await modelSourceService(dependencies).list() });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/joi") {
        const configured = await modelSourceService(dependencies).hasReadySource();
        sendJson(response, 200, {
          avatarChanges: dependencies.avatarChanges === undefined ? [] : await dependencies.avatarChanges.listPending(),
          avatars: dependencies.avatars === undefined ? [] : await dependencies.avatars.listSummaries(),
          modelSources: await modelSourceService(dependencies).list(),
          partners: dependencies.partners === undefined ? [] : await dependencies.partners.list(),
          runtime: { configured, status: configured ? "READY" : "NOT_CONFIGURED" },
          work: dependencies.work === undefined ? [] : await dependencies.work.listActive(),
        });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/joi/runtime") {
        const configured = await modelSourceService(dependencies).hasReadySource();
        sendJson(response, 200, { configured, status: configured ? "READY" : "NOT_CONFIGURED" });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/joi/messages") {
        sendJson(response, 200, { items: await joiInboxService(dependencies).list() });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/joi/activity") {
        if (dependencies.joiActivity === undefined) throw new HttpError("joi_activity_unavailable", "joi activity is unavailable.", 503);
        sendJson(response, 200, { items: await dependencies.joiActivity.listActivity(100) });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/work") {
        sendJson(response, 200, { items: dependencies.work === undefined ? [] : await dependencies.work.listActive() });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/partners") {
        sendJson(response, 200, { items: await partnerRegistryService(dependencies).list() });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/engines") {
        sendJson(response, 200, { items: await partnerEngineCatalog(dependencies).list() });
        return;
      }
      const engineSkillsMatch = /^\/api\/v1\/engines\/([^/]+)\/skills$/.exec(pathname);
      if (method === "GET" && engineSkillsMatch !== null) {
        const engine = partnerEngineParam(decodeURIComponent(engineSkillsMatch[1] ?? ""));
        sendJson(response, 200, { items: partnerSkillCatalog(dependencies).listForEngine(engine) });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/system/pick-directory") {
        if (dependencies.directoryPicker === undefined) throw new HttpError("directory_picker_unavailable", "Directory picker is unavailable.", 503);
        sendJson(response, 200, { path: await dependencies.directoryPicker() });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/scenarios") {
        const skillScenarios = dependencies.skills === undefined ? [] : dependencies.skills.listForEngine("claude-code").map((skill) => ({
          blurb: "用本机已装技能开启一件事",
          id: `skill:${skill.id}`,
          prompt: `本机已装技能「${skill.displayName}」（${skill.id}）。我想围绕它做一件事：……（补充目标）。请先确认我的目标，再决定是否建一位搭档并把该技能挂给它。`,
          source: "skill" as const,
          title: skill.displayName,
        }));
        sendJson(response, 200, { items: [...BUILTIN_SCENARIOS, ...skillScenarios] });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/avatars") {
        if (dependencies.avatars === undefined) throw new HttpError("avatar_catalog_unavailable", "Avatar catalog is unavailable.", 503);
        sendJson(response, 200, { items: await dependencies.avatars.listSummaries() });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/avatar-change-requests") {
        sendJson(response, 200, { items: await avatarChangeService(dependencies).listPending() });
        return;
      }
      const avatarChangeDecisionMatch = /^\/api\/v1\/avatar-change-requests\/([^/]+)\/decision$/.exec(pathname);
      if (method === "POST" && avatarChangeDecisionMatch !== null) {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        const decision = stringField(body, "decision");
        if (decision !== "CONFIRM" && decision !== "REJECT") throw new HttpError("avatar_change_decision_invalid", "Decision must be CONFIRM or REJECT.", 400);
        sendJson(response, 200, await avatarChangeService(dependencies).decide({
          decision,
          requestId: decodeURIComponent(avatarChangeDecisionMatch[1] ?? ""),
        }));
        return;
      }
      if (method === "POST" && pathname === "/api/v1/avatars") {
        await verifyWrite(dependencies, request);
        if (dependencies.avatarRegistry === undefined) throw new HttpError("avatar_registry_unavailable", "Avatar registry is unavailable.", 503);
        const body = await readJson(request);
        const avatar = await dependencies.avatarRegistry.create({
          name: stringField(body, "name"),
          personaSummary: stringField(body, "personaSummary"),
          projectLabel: stringField(body, "projectLabel"),
          scopeSummary: stringField(body, "scopeSummary"),
        });
        sendJson(response, 201, {
          avatarId: avatar.avatarId,
          name: avatar.profile.name,
          scopeSummary: avatar.profile.scopeSummary,
          updatedAt: avatar.updatedAt,
        });
        return;
      }
      if (method === "POST" && pathname === "/api/v1/partners") {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        const kind = stringField(body, "kind");
        if (kind !== "local-pi" && kind !== "a2a") throw new HttpError("partner_kind_invalid", "Partner kind is invalid.", 400);
        const engine = partnerEngineField(body);
        await assertLocalEngineAvailable(dependencies, engine);
        sendJson(response, 201, await partnerRegistryService(dependencies).add({
          capabilities: optionalStringArray(body, "capabilities") ?? [],
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          displayName: stringField(body, "displayName"),
          ...(engine === undefined ? {} : { engine }),
          ...(typeof body.engineModelId === "string" ? { engineModelId: body.engineModelId } : {}),
          kind,
          ...(typeof body.modelIdOverride === "string" ? { modelIdOverride: body.modelIdOverride } : {}),
          ...(typeof body.modelSourceId === "string" ? { modelSourceId: body.modelSourceId } : {}),
          skills: optionalStringArray(body, "skills") ?? [],
          tools: optionalStringArray(body, "tools") ?? [],
          ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
          ...(typeof body.workspaceRef === "string" ? { workspaceRef: body.workspaceRef } : {}),
        }));
        return;
      }
      const partnerMatch = /^\/api\/v1\/partners\/([^/]+)$/.exec(pathname);
      if (partnerMatch !== null && method === "PATCH") {
        await verifyWrite(dependencies, request);
        const partnerId = decodeURIComponent(partnerMatch[1] ?? "");
        const body = await readJson(request);
        if (body.disabled === true) {
          sendJson(response, 200, await partnerRegistryService(dependencies).disable(partnerId));
          return;
        }
        if (body.disabled === false) {
          sendJson(response, 200, await partnerRegistryService(dependencies).enable(partnerId));
          return;
        }
        const engine = partnerEngineField(body);
        await assertLocalEngineAvailable(dependencies, engine);
        sendJson(response, 200, await partnerRegistryService(dependencies).update(partnerId, {
          capabilities: optionalStringArray(body, "capabilities") ?? [],
          ...(typeof body.description === "string" ? { description: body.description } : {}),
          displayName: stringField(body, "displayName"),
          ...(engine === undefined ? {} : { engine }),
          ...(typeof body.engineModelId === "string" ? { engineModelId: body.engineModelId } : {}),
          ...(typeof body.modelIdOverride === "string" ? { modelIdOverride: body.modelIdOverride } : {}),
          ...(typeof body.modelSourceId === "string" ? { modelSourceId: body.modelSourceId } : {}),
          skills: optionalStringArray(body, "skills") ?? [],
          tools: optionalStringArray(body, "tools") ?? [],
          ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
          ...(typeof body.workspaceRef === "string" ? { workspaceRef: body.workspaceRef } : {}),
        }));
        return;
      }
      if (partnerMatch !== null && method === "DELETE") {
        await verifyWrite(dependencies, request);
        sendJson(response, 200, await partnerRegistryService(dependencies).delete(decodeURIComponent(partnerMatch[1] ?? "")));
        return;
      }
      const partnerDuplicateMatch = /^\/api\/v1\/partners\/([^/]+)\/duplicate$/.exec(pathname);
      if (partnerDuplicateMatch !== null && method === "POST") {
        await verifyWrite(dependencies, request);
        sendJson(response, 201, await partnerRegistryService(dependencies).duplicate(decodeURIComponent(partnerDuplicateMatch[1] ?? "")));
        return;
      }
      const partnerKnowledgeMatch = /^\/api\/v1\/partners\/([^/]+)\/knowledge$/.exec(pathname);
      if (partnerKnowledgeMatch !== null && method === "GET") {
        sendJson(response, 200, { items: await partnerKnowledgeService(dependencies).list(decodeURIComponent(partnerKnowledgeMatch[1] ?? "")) });
        return;
      }
      if (partnerKnowledgeMatch !== null && method === "POST") {
        await verifyWrite(dependencies, request);
        const partnerId = decodeURIComponent(partnerKnowledgeMatch[1] ?? "");
        const body = await readJson(request);
        sendJson(response, 201, await partnerKnowledgeService(dependencies).add({
          body: Buffer.from(base64Field(body, "contentBase64")).toString("utf8"),
          filename: stringField(body, "filename"),
          partnerId,
        }));
        return;
      }
      const partnerKnowledgeDocMatch = /^\/api\/v1\/partners\/([^/]+)\/knowledge\/([^/]+)$/.exec(pathname);
      if (partnerKnowledgeDocMatch !== null && method === "DELETE") {
        await verifyWrite(dependencies, request);
        const removed = await partnerKnowledgeService(dependencies).remove(
          decodeURIComponent(partnerKnowledgeDocMatch[1] ?? ""),
          decodeURIComponent(partnerKnowledgeDocMatch[2] ?? ""),
        );
        if (!removed) throw new HttpError("partner_kb_doc_not_found", "Knowledge document was not found.", 404);
        sendEmpty(response, 204);
        return;
      }
      const partnerMemoryMatch = /^\/api\/v1\/partners\/([^/]+)\/memory$/.exec(pathname);
      if (partnerMemoryMatch !== null && method === "GET") {
        sendJson(response, 200, await partnerMemoryService(dependencies).debugView(decodeURIComponent(partnerMemoryMatch[1] ?? "")));
        return;
      }
      const partnerInstancesMatch = /^\/api\/v1\/partners\/([^/]+)\/instances$/.exec(pathname);
      if (partnerInstancesMatch !== null && method === "GET") {
        sendJson(response, 200, { items: await partnerInstanceManager(dependencies).list(decodeURIComponent(partnerInstancesMatch[1] ?? "")) });
        return;
      }
      if (method === "POST" && pathname === "/api/v1/joi/messages") {
        await verifyWrite(dependencies, request);
        const idempotencyKey = request.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string") throw new HttpError("idempotency_key_required", "Idempotency-Key is required.", 400);
        const body = await readJson(request);
        const accepted = await joiInboxService(dependencies).accept({
          attachmentIds: optionalStringArray(body, "attachmentIds") ?? [],
          idempotencyKey,
          text: stringField(body, "text"),
        });
        sendJson(response, 202, accepted);
        dependencies.onJoiMessageAccepted?.(accepted.inputId);
        return;
      }
      if (method === "POST" && pathname === "/api/v1/joi/attachments") {
        await verifyWrite(dependencies, request);
        if (dependencies.joiAttachments === undefined) throw new HttpError("joi_attachment_service_unavailable", "joi attachment storage is unavailable.", 503);
        const body = await readJson(request, MAX_ATTACHMENT_REQUEST_BYTES);
        sendJson(response, 201, await dependencies.joiAttachments.upload({
          bytes: base64Field(body, "bytes"),
          filename: stringField(body, "filename"),
          mimeType: stringField(body, "mimeType"),
        }));
        return;
      }
      if (method === "POST" && pathname === "/api/v1/model-sources") {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        const kind = stringField(body, "kind");
        if (!["kimi", "glm", "qwen", "doubao", "minimax", "deepseek", "generic-openai"].includes(kind)) {
          throw new HttpError("model_source_kind_invalid", "Model source kind is invalid.", 400);
        }
        const accessMode = typeof body.accessMode === "string" ? body.accessMode : undefined;
        if (accessMode !== undefined && !["api", "coding-plan", "custom"].includes(accessMode)) {
          throw new HttpError("model_source_access_mode_invalid", "Model source access mode is invalid.", 400);
        }
        const protocol = typeof body.protocol === "string" ? body.protocol : undefined;
        if (protocol !== undefined && !["openai", "anthropic"].includes(protocol)) {
          throw new HttpError("model_source_protocol_invalid", "Model source protocol is invalid.", 400);
        }
        const source = await modelSourceService(dependencies).create({
          ...(accessMode === undefined ? {} : { accessMode: accessMode as "api" | "coding-plan" | "custom" }),
          apiKey: stringField(body, "apiKey"),
          kind: kind as Parameters<ModelSourceService["create"]>[0]["kind"],
          ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
          ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
          ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
          ...(protocol === undefined ? {} : { protocol: protocol as "openai" | "anthropic" }),
        });
        sendJson(response, 201, source);
        return;
      }
      if (method === "PUT" && pathname === "/api/v1/model-sources/order") {
        await verifyWrite(dependencies, request);
        const sourceIds = optionalStringArray(await readJson(request), "sourceIds");
        if (sourceIds === undefined) throw new HttpError("request_field_invalid", "sourceIds is required.", 400);
        sendJson(response, 200, { items: await modelSourceService(dependencies).setOrder(sourceIds) });
        return;
      }
      const modelSourceValidateMatch = /^\/api\/v1\/model-sources\/([^/]+)\/validate$/.exec(pathname);
      if (method === "POST" && modelSourceValidateMatch !== null) {
        await verifyWrite(dependencies, request);
        const validated = await modelSourceService(dependencies).validate(decodeURIComponent(modelSourceValidateMatch[1] ?? ""));
        sendJson(response, 200, validated);
        if (validated.status === "READY") dependencies.onModelSourceReady?.();
        return;
      }
      const modelSourceMatch = /^\/api\/v1\/model-sources\/([^/]+)$/.exec(pathname);
      if (modelSourceMatch !== null) {
        const sourceId = decodeURIComponent(modelSourceMatch[1] ?? "");
        if (method === "PATCH") {
          await verifyWrite(dependencies, request);
          const body = await readJson(request);
          const source = body.disabled === true
            ? await modelSourceService(dependencies).disable(sourceId)
            : await modelSourceService(dependencies).update(sourceId, {
              ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
              ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
              ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
              ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
            });
          sendJson(response, 200, source);
          return;
        }
        if (method === "DELETE") {
          await verifyWrite(dependencies, request);
          await modelSourceService(dependencies).delete(sourceId);
          sendEmpty(response, 204);
          return;
        }
      }
      if (method === "POST" && pathname === "/api/v1/auth/logout") {
        await verifyWrite(dependencies, request);
        await dependencies.auth.logout(sessionToken(request));
        sendEmpty(response, 204, { "set-cookie": clearSessionCookie() });
        return;
      }
      if (method === "POST" && pathname === "/api/v1/auth/logout-all") {
        await verifyWrite(dependencies, request);
        await dependencies.auth.revokeAllLanSessions();
        sendEmpty(response, 204);
        return;
      }
      if (method === "POST" && pathname === "/api/v1/auth/password") {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        await dependencies.auth.changePassword({
          csrfToken: csrfToken(request),
          currentPassword: stringField(body, "currentPassword"),
          expectedOrigin: expectedOrigin(request),
          newPassword: stringField(body, "newPassword"),
          origin: requestOrigin(request),
          remoteAddress: requestAddress(request),
          sessionToken: sessionToken(request),
        });
        sendEmpty(response, 204);
        return;
      }
      if (method !== "GET" && /^\/api\/v1\/lives(?:\/|$)/.test(pathname)) {
        throw new HttpError("legacy_life_read_only", "Legacy Life resources are read-only. Use joi and Avatar APIs.", 410);
      }
      if (method === "GET" && pathname === "/api/v1/lives") {
        const limitValue = Number(url.searchParams.get("limit") ?? "20");
        if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) throw new HttpError("limit_invalid", "limit must be between 1 and 100.", 400);
        const after = lifeCursor(url.searchParams.get("cursor"));
        const page = await dependencies.lives.list({
          ...(after === undefined ? {} : { after }),
          limit: limitValue,
        });
        sendJson(response, 200, { items: page.items, ...(page.next === undefined ? {} : { nextCursor: encodeLifeCursor(page.next) }) });
        return;
      }
      if (method === "POST" && pathname === "/api/v1/runtime/emergency-stop") {
        await verifyWrite(dependencies, request);
        if (dependencies.globalEmergencyStop === undefined) throw new HttpError("runtime_unavailable", "Global Runtime control is unavailable.", 503);
        await dependencies.globalEmergencyStop();
        sendEmpty(response, 204);
        return;
      }
      if (method === "POST" && pathname === "/api/v1/lives") {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        const principles = optionalStringArray(body, "principles");
        const life = await dependencies.lives.create({
          mainAgentConnectionId: stringField(body, "mainAgentConnectionId"),
          name: stringField(body, "name"),
          personaSummary: stringField(body, "personaSummary"),
          timezone: stringField(body, "timezone"),
          ...(principles === undefined ? {} : { principles }),
          ...(typeof body.avatarUrl === "string" ? { avatarUrl: body.avatarUrl } : {}),
          ...(typeof body.initialGoal === "string" ? { initialGoal: body.initialGoal } : {}),
          ...(typeof body.role === "string" ? { role: body.role } : {}),
        }, { ...(typeof request.headers["idempotency-key"] === "string" ? { idempotencyKey: request.headers["idempotency-key"] } : {}) });
        sendJson(response, 201, life);
        return;
      }
      const lifeMatch = /^\/api\/v1\/lives\/([^/]+)$/.exec(pathname);
      if (lifeMatch !== null) {
        const lifeId = decodeURIComponent(lifeMatch[1] ?? "");
        if (method === "GET") {
          sendJson(response, 200, await dependencies.lives.get(lifeId));
          return;
        }
        if (method === "PATCH") {
          await verifyWrite(dependencies, request);
          const body = await readJson(request);
          const principles = optionalStringArray(body, "principles");
          const avatarUrl = optionalStringField(body, "avatarUrl");
          const initialGoal = optionalStringField(body, "initialGoal");
          const role = optionalStringField(body, "role");
          const life = await dependencies.lives.update(lifeId, {
            ...(typeof body.name === "string" ? { name: body.name } : {}),
            ...(typeof body.personaSummary === "string" ? { personaSummary: body.personaSummary } : {}),
            ...(typeof body.timezone === "string" ? { timezone: body.timezone } : {}),
            ...(principles === undefined ? {} : { principles }),
            ...(avatarUrl === undefined ? {} : { avatarUrl }),
            ...(initialGoal === undefined ? {} : { initialGoal }),
            ...(role === undefined ? {} : { role }),
          });
          sendJson(response, 200, life);
          return;
        }
        if (method === "DELETE") {
          await verifyWrite(dependencies, request);
          await dependencies.lives.delete(lifeId);
          sendEmpty(response, 204);
          return;
        }
      }
      const lifeImpactMatch = /^\/api\/v1\/lives\/([^/]+)\/deletion-impact$/.exec(pathname);
      if (method === "GET" && lifeImpactMatch !== null) {
        sendJson(response, 200, await dependencies.lives.getDeletionImpact(decodeURIComponent(lifeImpactMatch[1] ?? "")));
        return;
      }
      const lifeArchiveMatch = /^\/api\/v1\/lives\/([^/]+)\/archive$/.exec(pathname);
      if (method === "POST" && lifeArchiveMatch !== null) {
        await verifyWrite(dependencies, request);
        sendJson(response, 200, await dependencies.lives.archive(decodeURIComponent(lifeArchiveMatch[1] ?? "")));
        return;
      }
      const lifePrimaryAgentMatch = /^\/api\/v1\/lives\/([^/]+)\/primary-agent$/.exec(pathname);
      if (lifePrimaryAgentMatch !== null) {
        const lifeId = decodeURIComponent(lifePrimaryAgentMatch[1] ?? "");
        if (method === "GET") {
          sendJson(response, 200, { items: await dependencies.lives.getPrimaryAgentHandoffs(lifeId) });
          return;
        }
        if (method === "POST") {
          await verifyWrite(dependencies, request);
          const body = await readJson(request);
          sendJson(response, 200, await dependencies.lives.changePrimaryAgent(lifeId, stringField(body, "agentConnectionId")));
          return;
        }
      }
      const lifeRuntimeMatch = /^\/api\/v1\/lives\/([^/]+)\/runtime\/(start|pause|resume|stop|cancel-run|emergency-stop)$/.exec(pathname);
      if (method === "POST" && lifeRuntimeMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(lifeRuntimeMatch[1] ?? "");
        const action = lifeRuntimeMatch[2];
        const runtime = lifeRuntimeService(dependencies);
        if (action === "emergency-stop" || action === "cancel-run" || action === "pause") dependencies.wakeCoordinator?.emergencyStop(lifeId);
        const life = action === "start"
          ? await runtime.start(lifeId)
          : action === "pause"
            ? await runtime.pause(lifeId)
            : action === "resume"
              ? await runtime.resume(lifeId)
              : action === "stop"
                ? await runtime.stop(lifeId)
                : action === "cancel-run" ? await runtime.stopRun(lifeId) : await runtime.emergencyStop(lifeId);
        if (action === "start" || action === "resume") dependencies.wakeCoordinator?.notify(lifeId);
        sendJson(response, 200, life);
        return;
      }
      const lifeEventsMatch = /^\/api\/v1\/lives\/([^/]+)\/events$/.exec(pathname);
      if (method === "GET" && lifeEventsMatch !== null) {
        const lifeId = decodeURIComponent(lifeEventsMatch[1] ?? "");
        await dependencies.lives.get(lifeId);
        const limit = Number(url.searchParams.get("limit") ?? "100");
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError("limit_invalid", "Event limit must be between 1 and 200.", 400);
        const before = eventCursor(url.searchParams.get("cursor"));
        const page = await eventService(dependencies).list(lifeId, { ...(before === undefined ? {} : { before }), limit });
        sendJson(response, 200, { items: page.items, ...(page.next === undefined ? {} : { nextCursor: encodeEventCursor(page.next) }) });
        return;
      }
      const lifeActivityMatch = /^\/api\/v1\/lives\/([^/]+)\/activity$/.exec(pathname);
      if (method === "GET" && lifeActivityMatch !== null) {
        const lifeId = decodeURIComponent(lifeActivityMatch[1] ?? "");
        await dependencies.lives.get(lifeId);
        sendJson(response, 200, { items: await eventService(dependencies).activity(lifeId, 100) });
        return;
      }
      const lifeMessagesMatch = /^\/api\/v1\/lives\/([^/]+)\/messages$/.exec(pathname);
      if (method === "POST" && lifeMessagesMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(lifeMessagesMatch[1] ?? "");
        await dependencies.lives.get(lifeId);
        const body = await readJson(request);
        const text = stringField(body, "text");
        const attachmentIds = optionalStringArray(body, "attachmentIds");
        const idempotencyKey = typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : undefined;
        const event = await eventService(dependencies).ingest({
          ...(idempotencyKey === undefined ? {} : { dedupeKey: idempotencyKey }),
          lifeId,
          ...(attachmentIds === undefined ? {} : { attachmentIds }),
          payload: {
            ...(typeof body.channelId === "string" ? { channelId: body.channelId } : {}),
            ...(typeof body.threadId === "string" ? { threadId: body.threadId } : {}),
            text,
          },
          source: "human",
          type: "human.message",
        });
        dependencies.wakeCoordinator?.notify(lifeId);
        sendJson(response, 202, event);
        return;
      }
      const lifeAttachmentMatch = /^\/api\/v1\/lives\/([^/]+)\/attachments$/.exec(pathname);
      if (method === "POST" && lifeAttachmentMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(lifeAttachmentMatch[1] ?? "");
        await dependencies.lives.get(lifeId);
        const body = await readJson(request, MAX_ATTACHMENT_REQUEST_BYTES);
        const attachment = await attachmentService(dependencies).upload({
          bytes: base64Field(body, "bytes"),
          filename: stringField(body, "filename"),
          lifeId,
          mimeType: stringField(body, "mimeType"),
        });
        sendJson(response, 201, attachment);
        return;
      }
      const continuityMatch = /^\/api\/v1\/lives\/([^/]+)\/(continuity|affairs|todos|alarms|memories|schedules|delegations)$/.exec(pathname);
      if (method === "GET" && continuityMatch !== null) {
        const lifeId = decodeURIComponent(continuityMatch[1] ?? "");
        const resource = continuityMatch[2] ?? "continuity";
        const snapshot = await continuityService(dependencies).snapshot(lifeId);
        sendJson(response, 200, resource === "continuity" ? snapshot : { items: snapshot[resource as keyof typeof snapshot] });
        return;
      }
      const scheduleUpdateMatch = /^\/api\/v1\/lives\/([^/]+)\/schedules\/([^/]+)$/.exec(pathname);
      if (method === "PATCH" && scheduleUpdateMatch !== null) {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        if (typeof body.enabled !== "boolean") throw new HttpError("request_field_invalid", "enabled must be boolean.", 400);
        sendJson(response, 200, await continuityService(dependencies).updateSchedule(
          decodeURIComponent(scheduleUpdateMatch[1] ?? ""),
          decodeURIComponent(scheduleUpdateMatch[2] ?? ""),
          { enabled: body.enabled, localTime: stringField(body, "localTime") },
        ));
        return;
      }
      const rhythmUpdateMatch = /^\/api\/v1\/lives\/([^/]+)\/rhythm$/.exec(pathname);
      if (method === "PATCH" && rhythmUpdateMatch !== null) {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        sendJson(response, 200, await continuityService(dependencies).updateRhythm(
          decodeURIComponent(rhythmUpdateMatch[1] ?? ""),
          {
            autonomousWakesDefault: integerField(body, "autonomousWakesDefault"),
            idleExplorationsDefault: integerField(body, "idleExplorationsDefault"),
            invocationsDefault: integerField(body, "invocationsDefault"),
            quietEnd: stringField(body, "quietEnd"),
            quietStart: stringField(body, "quietStart"),
          },
        ));
        return;
      }
      const expressionsMatch = /^\/api\/v1\/lives\/([^/]+)\/expressions$/.exec(pathname);
      if (method === "GET" && expressionsMatch !== null) {
        const lifeId = decodeURIComponent(expressionsMatch[1] ?? "");
        sendJson(response, 200, { items: await continuityService(dependencies).expressions(lifeId) });
        return;
      }
      const todoReminderMatch = /^\/api\/v1\/lives\/([^/]+)\/todos\/([^/]+)\/remind$/.exec(pathname);
      if (method === "POST" && todoReminderMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(todoReminderMatch[1] ?? "");
        const todoId = decodeURIComponent(todoReminderMatch[2] ?? "");
        const todo = (await continuityService(dependencies).snapshot(lifeId)).todos.find((item) => item.todoId === todoId);
        if (todo === undefined) throw new HttpError("todo_not_found", "Todo was not found.", 404);
        const event = await eventService(dependencies).ingest({
          ...(todo.affairId === undefined ? {} : { affairId: todo.affairId }),
          lifeId,
          payload: { requestedBy: "human", title: todo.title, todoId },
          source: "human",
          type: "todo.reminder",
        });
        dependencies.wakeCoordinator?.notify(lifeId);
        sendJson(response, 202, event);
        return;
      }
      const todoMutationMatch = /^\/api\/v1\/lives\/([^/]+)\/todos(?:\/([^/]+))?$/.exec(pathname);
      if ((method === "POST" || method === "PATCH" || method === "DELETE") && todoMutationMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(todoMutationMatch[1] ?? "");
        const todoId = todoMutationMatch[2] === undefined ? undefined : decodeURIComponent(todoMutationMatch[2]);
        if (method !== "POST" && todoId === undefined) throw new HttpError("todo_not_found", "Todo identifier is required.", 404);
        const body = method === "DELETE" ? {} : await readJson(request);
        if (method === "POST" && (typeof body.title !== "string" || body.title.trim() === "")) {
          throw new HttpError("request_field_invalid", "title must not be empty.", 400);
        }
        if (typeof body.dueAt === "string" && !Number.isFinite(Date.parse(body.dueAt))) {
          throw new HttpError("request_field_invalid", "dueAt must be an ISO timestamp.", 400);
        }
        if (body.affairId !== undefined && body.affairId !== null && typeof body.affairId !== "string") {
          throw new HttpError("request_field_invalid", "affairId must be string or null.", 400);
        }
        if (body.assignee !== undefined && body.assignee !== null && typeof body.assignee !== "string") {
          throw new HttpError("request_field_invalid", "assignee must be string or null.", 400);
        }
        const event = await eventService(dependencies).ingest({
          lifeId,
          payload: {
            operation: method === "POST" ? "create" : method === "DELETE" ? "cancel" : "update",
            ...(todoId === undefined ? {} : { todoId }),
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.dueAt === "string" || body.dueAt === null ? { dueAt: body.dueAt } : {}),
            ...(typeof body.affairId === "string" || body.affairId === null ? { affairId: body.affairId } : {}),
            ...(typeof body.assignee === "string" || body.assignee === null ? { assignee: body.assignee } : {}),
            ...(typeof body.status === "string" ? { status: body.status } : {}),
          },
          source: "human",
          type: "todo.user_changed",
        });
        dependencies.wakeCoordinator?.notify(lifeId);
        sendJson(response, 202, event);
        return;
      }
      const alarmMutationMatch = /^\/api\/v1\/lives\/([^/]+)\/alarms(?:\/([^/]+))?$/.exec(pathname);
      if ((method === "POST" || method === "DELETE") && alarmMutationMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(alarmMutationMatch[1] ?? "");
        const alarmId = alarmMutationMatch[2] === undefined ? undefined : decodeURIComponent(alarmMutationMatch[2]);
        if (method === "DELETE" && alarmId === undefined) throw new HttpError("alarm_not_found", "Alarm identifier is required.", 404);
        const body = method === "DELETE" ? {} : await readJson(request);
        if (method === "POST" && (typeof body.reason !== "string" || body.reason.trim() === "" || typeof body.nextAt !== "string" || !Number.isFinite(Date.parse(body.nextAt)))) {
          throw new HttpError("request_field_invalid", "Alarm requires a reason and ISO nextAt timestamp.", 400);
        }
        if (body.repeatEveryMinutes !== undefined && (typeof body.repeatEveryMinutes !== "number"
          || !Number.isInteger(body.repeatEveryMinutes) || body.repeatEveryMinutes < 1 || body.repeatEveryMinutes > 525_600)) {
          throw new HttpError("request_field_invalid", "repeatEveryMinutes is outside supported limits.", 400);
        }
        if (body.recurrenceRule !== undefined && (typeof body.recurrenceRule !== "string"
          || !["DAILY", "WEEKDAYS", "WEEKENDS", "WEEKLY"].includes(body.recurrenceRule))) {
          throw new HttpError("request_field_invalid", "recurrenceRule is unsupported.", 400);
        }
        if (body.repeatEveryMinutes !== undefined && body.recurrenceRule !== undefined) {
          throw new HttpError("request_field_invalid", "Alarm must use either interval or calendar recurrence.", 400);
        }
        if (body.allowQuietHours !== undefined && typeof body.allowQuietHours !== "boolean") {
          throw new HttpError("request_field_invalid", "allowQuietHours must be boolean.", 400);
        }
        const event = await eventService(dependencies).ingest({
          lifeId,
          payload: {
            operation: method === "DELETE" ? "cancel" : "create",
            ...(alarmId === undefined ? {} : { alarmId }),
            ...(typeof body.nextAt === "string" ? { nextAt: body.nextAt } : {}),
            ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
            ...(typeof body.repeatEveryMinutes === "number" ? { repeatEveryMinutes: body.repeatEveryMinutes } : {}),
            ...(typeof body.recurrenceRule === "string" ? { recurrenceRule: body.recurrenceRule } : {}),
            ...(typeof body.allowQuietHours === "boolean" ? { allowQuietHours: body.allowQuietHours } : {}),
            creator: "HUMAN",
          },
          source: "human",
          type: "alarm.user_changed",
        });
        dependencies.wakeCoordinator?.notify(lifeId);
        sendJson(response, 202, event);
        return;
      }
      const memoryCorrectionMatch = /^\/api\/v1\/lives\/([^/]+)\/memories\/([^/]+)\/correct$/.exec(pathname);
      if (method === "POST" && memoryCorrectionMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(memoryCorrectionMatch[1] ?? "");
        const memoryId = decodeURIComponent(memoryCorrectionMatch[2] ?? "");
        const memory = (await continuityService(dependencies).snapshot(lifeId)).memories.find((item) => item.memoryId === memoryId);
        if (memory === undefined) throw new HttpError("memory_not_found", "Memory was not found.", 404);
        const body = await readJson(request);
        const content = stringField(body, "content").trim();
        if (content === "") throw new HttpError("request_field_invalid", "content must not be empty.", 400);
        const event = await eventService(dependencies).ingest({
          ...(memory.affairId === undefined ? {} : { affairId: memory.affairId }),
          lifeId,
          payload: { content, memoryId, previousRevision: memory.revision },
          source: "human",
          type: "memory.corrected",
        });
        dependencies.wakeCoordinator?.notify(lifeId);
        sendJson(response, 202, event);
        return;
      }
      const memoryForgetMatch = /^\/api\/v1\/lives\/([^/]+)\/memories\/([^/]+)\/forget$/.exec(pathname);
      if (method === "POST" && memoryForgetMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(memoryForgetMatch[1] ?? "");
        const memoryId = decodeURIComponent(memoryForgetMatch[2] ?? "");
        const memory = (await continuityService(dependencies).snapshot(lifeId)).memories.find((item) => item.memoryId === memoryId);
        if (memory === undefined) throw new HttpError("memory_not_found", "Memory was not found.", 404);
        const event = await eventService(dependencies).ingest({ lifeId, payload: { memoryId, previousRevision: memory.revision }, source: "human", type: "memory.forgotten" });
        dependencies.wakeCoordinator?.notify(lifeId);
        sendJson(response, 202, event);
        return;
      }
      const collaboratorsMatch = /^\/api\/v1\/lives\/([^/]+)\/collaborators$/.exec(pathname);
      if (method === "POST" && collaboratorsMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(collaboratorsMatch[1] ?? "");
        const body = await readJson(request);
        sendJson(response, 200, { items: await continuityService(dependencies).bindCollaborator(lifeId, stringField(body, "agentConnectionId")) });
        return;
      }
      const collaboratorDeleteMatch = /^\/api\/v1\/lives\/([^/]+)\/collaborators\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && collaboratorDeleteMatch !== null) {
        await verifyWrite(dependencies, request);
        sendJson(response, 200, { items: await continuityService(dependencies).unbindCollaborator(
          decodeURIComponent(collaboratorDeleteMatch[1] ?? ""), decodeURIComponent(collaboratorDeleteMatch[2] ?? ""),
        ) });
        return;
      }
      const budgetExtendMatch = /^\/api\/v1\/lives\/([^/]+)\/budget\/extend$/.exec(pathname);
      if (method === "POST" && budgetExtendMatch !== null) {
        await verifyWrite(dependencies, request);
        const lifeId = decodeURIComponent(budgetExtendMatch[1] ?? "");
        const body = await readJson(request);
        sendJson(response, 200, await budgetService(dependencies).extend(lifeId, {
          autonomousWakes: integerField(body, "autonomousWakes"),
          invocations: integerField(body, "invocations"),
        }));
        return;
      }
      if (method === "GET" && pathname === "/api/v1/agents") {
        sendJson(response, 200, { items: await dependencies.agents.list() });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/interactions") {
        sendJson(response, 200, { items: await interactionService(dependencies).listPending() });
        return;
      }
      const interactionAnswerMatch = /^\/api\/v1\/interactions\/([^/]+)\/answer$/.exec(pathname);
      if (method === "POST" && interactionAnswerMatch !== null) {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        sendJson(response, 200, await interactionService(dependencies).answer(
          decodeURIComponent(interactionAnswerMatch[1] ?? ""), stringField(body, "answer"),
        ));
        return;
      }
      const interactionAuthorizeMatch = /^\/api\/v1\/interactions\/([^/]+)\/resume-authorization$/.exec(pathname);
      if (method === "POST" && interactionAuthorizeMatch !== null) {
        await verifyWrite(dependencies, request);
        sendJson(response, 200, await interactionService(dependencies).resumeAuthorization(
          decodeURIComponent(interactionAuthorizeMatch[1] ?? ""),
        ));
        return;
      }
      if (method === "POST" && pathname === "/api/v1/agents") {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        const connection = await onboardingService(dependencies).onboard({
          cardUrl: stringField(body, "cardUrl"),
          token: stringField(body, "token"),
        });
        sendJson(response, 201, connection);
        return;
      }
      const agentImpactMatch = /^\/api\/v1\/agents\/([^/]+)\/deletion-impact$/.exec(pathname);
      if (method === "GET" && agentImpactMatch !== null) {
        sendJson(response, 200, await onboardingService(dependencies).deletionImpact(decodeURIComponent(agentImpactMatch[1] ?? "")));
        return;
      }
      const agentDeleteMatch = /^\/api\/v1\/agents\/([^/]+)$/.exec(pathname);
      if (method === "DELETE" && agentDeleteMatch !== null) {
        await verifyWrite(dependencies, request);
        await onboardingService(dependencies).delete(decodeURIComponent(agentDeleteMatch[1] ?? ""));
        sendEmpty(response, 204);
        return;
      }
      const agentActionMatch = /^\/api\/v1\/agents\/([^/]+)\/(refresh|rotate-token|disable|enable)$/.exec(pathname);
      if (method === "POST" && agentActionMatch !== null) {
        await verifyWrite(dependencies, request);
        const agentConnectionId = decodeURIComponent(agentActionMatch[1] ?? "");
        const action = agentActionMatch[2];
        if (action === "refresh") {
          sendJson(response, 200, await onboardingService(dependencies).refresh(agentConnectionId));
          return;
        }
        if (action === "disable") {
          sendJson(response, 200, await onboardingService(dependencies).disable(agentConnectionId));
          return;
        }
        if (action === "enable") {
          sendJson(response, 200, await onboardingService(dependencies).enable(agentConnectionId));
          return;
        }
        const body = await readJson(request);
        sendJson(response, 200, await onboardingService(dependencies).rotateToken(agentConnectionId, stringField(body, "token")));
        return;
      }
      if (method === "GET" && pathname === "/api/v1/diagnostics") {
        sendJson(response, 200, await dependencies.operations.diagnostics());
        return;
      }
      if (method === "GET" && pathname === "/api/v1/diagnostics/export") {
        await dependencies.auth.authenticate(sessionToken(request));
        sendJson(response, 200, await dependencies.operations.diagnostics(), {
          "content-disposition": `attachment; filename="joi-diagnostics-${new Date().toISOString().slice(0, 10)}.json"`,
        });
        return;
      }
      if (method === "GET" && pathname === "/api/v1/settings") {
        if (dependencies.settings === undefined) throw new HttpError("settings_unavailable", "Runtime settings are unavailable.", 503);
        sendJson(response, 200, await dependencies.settings.get());
        return;
      }
      if (method === "POST" && pathname === "/api/v1/settings") {
        await verifyWrite(dependencies, request);
        if (dependencies.settings === undefined) throw new HttpError("settings_unavailable", "Runtime settings are unavailable.", 503);
        const body = await readJson(request);
        const lanBody = body.lan;
        const lan = lanBody !== null && typeof lanBody === "object" && !Array.isArray(lanBody)
          ? lanBody as Record<string, unknown>
          : undefined;
        sendJson(response, 200, await dependencies.settings.update({
          ...(typeof body.launchAtLogin === "boolean" ? { launchAtLogin: body.launchAtLogin } : {}),
          ...(lan === undefined ? {} : { lan: {
            ...(typeof lan.address === "string" ? { address: lan.address } : {}),
            ...(typeof lan.enabled === "boolean" ? { enabled: lan.enabled } : {}),
            ...(typeof lan.port === "number" ? { port: lan.port } : {}),
            ...(typeof lan.riskAccepted === "boolean" ? { riskAccepted: lan.riskAccepted } : {}),
          } }),
        }));
        return;
      }
      if (method === "GET" && pathname === "/api/v1/backups") {
        sendJson(response, 200, { items: await dependencies.operations.listBackups() });
        return;
      }
      if (method === "POST" && pathname === "/api/v1/backups") {
        await verifyWrite(dependencies, request);
        sendJson(response, 201, await dependencies.operations.createBackup());
        return;
      }
      const backupRestoreMatch = /^\/api\/v1\/backups\/([^/]+)\/restore$/.exec(pathname);
      if (method === "POST" && backupRestoreMatch !== null) {
        await verifyWrite(dependencies, request);
        const result = await dependencies.operations.stageRestore(decodeURIComponent(backupRestoreMatch[1] ?? ""));
        sendJson(response, 202, result);
        if (dependencies.requestRestart !== undefined) setTimeout(dependencies.requestRestart, 50).unref();
        return;
      }
      if (method === "POST" && pathname === "/api/v1/backups/manifest") {
        await verifyWrite(dependencies, request);
        const body = await readJson(request);
        const artifactCount = body.artifactCount;
        const artifactTotalBytes = body.artifactTotalBytes;
        if (typeof artifactCount !== "number" || typeof artifactTotalBytes !== "number") {
          throw new HttpError("request_field_invalid", "Backup artifact counts must be numbers.", 400);
        }
        sendJson(response, 201, await dependencies.operations.createBackupManifest({
          appVersion: stringField(body, "appVersion"), artifactCount, artifactTotalBytes,
        }));
        return;
      }
      throw new HttpError("route_not_found", "API route was not found.", 404);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const failure = errorDetails(error, requestId);
      sendJson(response, failure.status, failure.body);
    }
  };
}
