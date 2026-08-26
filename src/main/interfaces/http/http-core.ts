import type { IncomingMessage, ServerResponse } from "node:http";

import { AuthError } from "../../application/auth/auth-service.js";
import type { PartnerSkillOption } from "../../application/ports/partner-skills.js";
import { BUILTIN_SCENARIOS, type ScenarioDto } from "../../../shared/joi.js";

export const SESSION_COOKIE = "digital_life_session";
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_REQUEST_BYTES = 14 * 1024 * 1024;

export interface ApiErrorBody {
  code: string;
  details?: Record<string, unknown>;
  message: string;
  requestId: string;
}

export class HttpError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
    this.name = "HttpError";
  }
}

export function requestAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

export function expectedOrigin(request: IncomingMessage): string {
  const host = request.headers.host;
  return host === undefined ? "" : `http://${host}`;
}

export function requestOrigin(request: IncomingMessage): string {
  const origin = request.headers.origin;
  if (typeof origin === "string") return origin;
  if (Array.isArray(origin)) return typeof origin[0] === "string" ? origin[0] : "";
  return "";
}

export function parseCookies(request: IncomingMessage): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

export function sessionToken(request: IncomingMessage): string {
  return parseCookies(request).get(SESSION_COOKIE) ?? "";
}

export function csrfToken(request: IncomingMessage): string {
  const header = request.headers["x-csrf-token"];
  return Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
}

export function sessionCookie(grant: { csrfToken: string; sessionToken: string }): string {
  return `${SESSION_COOKIE}=${grant.sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export async function readJson(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
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

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new HttpError("request_field_invalid", `${key} must be a string.`, 400);
  return value;
}

export function optionalStringField(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = body[key];
  if (value === undefined || value === null || typeof value === "string") return value;
  throw new HttpError("request_field_invalid", `${key} must be a string or null.`, 400);
}

export function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError("request_field_invalid", `${key} must be an array of strings.`, 400);
  }
  return value as string[];
}

export function base64Field(body: Record<string, unknown>, key: string): Uint8Array {
  const value = stringField(body, key);
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new HttpError("request_field_invalid", `${key} must be canonical base64.`, 400);
  }
  return Buffer.from(value, "base64");
}

export function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(payload));
}

export function sendEmpty(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "cache-control": "no-store", ...headers });
  response.end();
}

export function errorDetails(error: unknown, requestId: string): { body: ApiErrorBody; status: number } {
  if (error instanceof AuthError || error instanceof HttpError) {
    return { body: { code: error.code, message: error.message, requestId }, status: error.status };
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    const conflictCodes = ["workbench_workspace_busy", "workbench_agent_resident_delete_forbidden", "workbench_agent_not_terminal"];
    const status = error.code.endsWith("_not_found") ? 404 : conflictCodes.includes(error.code) ? 409 : 400;
    return { body: { code: error.code, message: error.message, requestId }, status };
  }
  return { body: { code: "internal_error", message: "The request could not be completed.", requestId }, status: 500 };
}

export function artifactDisposition(filename: string, mode: "attachment" | "inline"): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "artifact";
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function lifeCursor(value: string | null): { createdAt: string; lifeId: string } | undefined {
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

export function encodeLifeCursor(cursor: { createdAt: string; lifeId: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function eventCursor(value: string | null): { eventId: string; occurredAt: string } | undefined {
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

export function encodeEventCursor(cursor: { eventId: string; occurredAt: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function buildScenarioList(skills: PartnerSkillOption[]): ScenarioDto[] {
  const skillScenarios = skills
    .slice()
    .sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0))
    .slice(0, 6)
    .map((skill) => ({
      blurb: skill.description === undefined ? "围绕这个能力组建搭档团队" : (skill.description.length > 48 ? `${skill.description.slice(0, 48)}…` : skill.description),
      id: `skill:${skill.id}`,
      prompt: `我想围绕能力「${skill.displayName}」（${skill.id}）组建能运用它的搭档团队：请创建合适的本机搭档并把该技能挂给它（pi-core 引擎，必要时挑选合适的 READY 模型源）；本轮只组建团队，不必执行具体任务。`,
      roles: [{
        id: "primary",
        prompt: `你是一位围绕能力「${skill.displayName}」（${skill.id}）开展工作的搭档。DO：接到相关工作时先读取并遵循该技能的说明，再完成行为并交付结果。验收标准：交付物体现该技能的关键约束，且可被独立验证。范围外：不做与该技能无关的工作、不修改技能本身。`,
        skills: [skill.id],
        title: `${skill.displayName} 工坊`,
      }],
      source: "skill" as const,
      title: skill.displayName,
    }));
  return [...BUILTIN_SCENARIOS, ...skillScenarios];
}
