import { automationService } from "../api-dependencies.js";
import { HttpError, optionalStringField, readJson, sendEmpty, sendJson, stringField } from "../http-core.js";
import { exact, pattern, type RouteDefinition } from "../route-types.js";
import type { AutomationFrequency, AutomationTarget } from "../../../../shared/automation.js";
import type { IncomingHttpHeaders } from "node:http";

function idempotencyKey(headers: IncomingHttpHeaders): string {
  const value = headers["idempotency-key"];
  if (typeof value !== "string" || value.trim() === "") throw new HttpError("idempotency_key_required", "Idempotency-Key is required.", 400);
  if (value.trim().length > 240) throw new HttpError("idempotency_key_invalid", "Idempotency-Key is too long.", 400);
  return value.trim();
}

function frequency(body: Record<string, unknown>): AutomationFrequency {
  const value = body.frequency;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new HttpError("routine_frequency_invalid", "frequency must be an object.", 400);
  return value as AutomationFrequency;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError("request_field_invalid", `${key} must be a boolean.`, 400);
  return value;
}

function optionalNewString(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalStringField(body, key);
  if (value === null) throw new HttpError("request_field_invalid", `${key} must be a string.`, 400);
  return value;
}

function target(body: Record<string, unknown>): AutomationTarget | undefined {
  const value = body.target;
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError("routine_target_invalid", "target must be an object.", 400);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "NEW_GOAL") return { kind: "NEW_GOAL" };
  if (record.kind === "GOAL_CONTINUATION" && typeof record.goalId === "string" && record.goalId.trim() !== "") {
    return { kind: "GOAL_CONTINUATION", goalId: record.goalId.trim() };
  }
  throw new HttpError("routine_target_invalid", "target must identify a supported automation target.", 400);
}

export const AUTOMATION_READ_ROUTES: RouteDefinition[] = [
  {
    auth: "read", id: "GET /api/v1/automations", match: exact("GET", "/api/v1/automations"),
    handle: async (ctx) => { sendJson(ctx.response, 200, { items: await automationService(ctx.dependencies).list() }); },
  },
  {
    auth: "read", id: "GET /api/v1/automations/:routineId", match: pattern("GET", /^\/api\/v1\/automations\/([^/]+)$/u),
    handle: async (ctx, match) => { sendJson(ctx.response, 200, await automationService(ctx.dependencies).get(decodeURIComponent((match as RegExpExecArray)[1] ?? ""))); },
  },
];

export const AUTOMATION_WRITE_ROUTES: RouteDefinition[] = [
  {
    auth: "write", id: "POST /api/v1/automations", match: exact("POST", "/api/v1/automations"),
    handle: async (ctx) => {
      const key = idempotencyKey(ctx.request.headers);
      const body = await readJson(ctx.request);
      const preferredPartnerId = optionalNewString(body, "preferredPartnerId");
      const from = optionalNewString(body, "from");
      const to = optionalNewString(body, "to");
      const automationTarget = target(body);
      const workbenchId = optionalNewString(body, "workbenchId");
      sendJson(ctx.response, 201, await automationService(ctx.dependencies).create({
        frequency: frequency(body), name: stringField(body, "name"), prompt: stringField(body, "prompt"),
        ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
        ...(preferredPartnerId === undefined ? {} : { preferredPartnerId }),
        ...(automationTarget === undefined ? {} : { target: automationTarget }),
        ...(workbenchId === undefined ? {} : { workbenchId }),
      }, key));
    },
  },
  {
    auth: "write", id: "POST /api/v1/automations/:routineId/prompt/reveal", match: pattern("POST", /^\/api\/v1\/automations\/([^/]+)\/prompt\/reveal$/u),
    handle: async (ctx, match) => { idempotencyKey(ctx.request.headers); sendJson(ctx.response, 200, await automationService(ctx.dependencies).revealPrompt(decodeURIComponent((match as RegExpExecArray)[1] ?? ""))); },
  },
  {
    auth: "write", id: "PATCH /api/v1/automations/:routineId", match: pattern("PATCH", /^\/api\/v1\/automations\/([^/]+)$/u),
    handle: async (ctx, match) => {
      const key = idempotencyKey(ctx.request.headers);
      const body = await readJson(ctx.request);
      const enabled = optionalBoolean(body, "enabled");
      const name = optionalNewString(body, "name");
      const prompt = optionalNewString(body, "prompt");
      const workbenchId = optionalNewString(body, "workbenchId");
      const from = optionalStringField(body, "from");
      const to = optionalStringField(body, "to");
      const preferredPartnerId = optionalStringField(body, "preferredPartnerId");
      const automationTarget = target(body);
      sendJson(ctx.response, 200, await automationService(ctx.dependencies).update(decodeURIComponent((match as RegExpExecArray)[1] ?? ""), {
        ...(enabled === undefined ? {} : { enabled }), ...(from === undefined ? {} : { from }),
        ...(body.frequency === undefined ? {} : { frequency: frequency(body) }),
        ...(name === undefined ? {} : { name }), ...(preferredPartnerId === undefined ? {} : { preferredPartnerId }),
        ...(prompt === undefined ? {} : { prompt }), ...(to === undefined ? {} : { to }), ...(workbenchId === undefined ? {} : { workbenchId }),
        ...(automationTarget === undefined ? {} : { target: automationTarget }),
      }, key));
    },
  },
  {
    auth: "write", id: "POST /api/v1/automations/:routineId/run-now", match: pattern("POST", /^\/api\/v1\/automations\/([^/]+)\/run-now$/u),
    handle: async (ctx, match) => { sendJson(ctx.response, 202, await automationService(ctx.dependencies).runNow(decodeURIComponent((match as RegExpExecArray)[1] ?? ""), idempotencyKey(ctx.request.headers))); },
  },
  {
    auth: "write", id: "DELETE /api/v1/automations/:routineId", match: pattern("DELETE", /^\/api\/v1\/automations\/([^/]+)$/u),
    handle: async (ctx, match) => { const key = idempotencyKey(ctx.request.headers); await automationService(ctx.dependencies).delete(decodeURIComponent((match as RegExpExecArray)[1] ?? ""), key); sendEmpty(ctx.response, 204); },
  },
];
