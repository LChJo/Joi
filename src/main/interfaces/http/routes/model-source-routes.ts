import type { ModelSourceService } from "../../../application/model-sources/model-source-service.js";
import { THINKING_EFFORTS } from "../../../../shared/joi.js";
import {
  HttpError,
  optionalEnumField,
  optionalIntegerField,
  optionalStringArray,
  readJson,
  sendEmpty,
  sendJson,
  stringField,
} from "../http-core.js";
import { modelSourceService } from "../api-dependencies.js";
import { exact, pattern, type RouteDefinition } from "../route-types.js";

export const MODEL_SOURCE_READ_ROUTES: RouteDefinition[] = [
  {
    auth: "read",
    id: "GET /api/v1/model-sources",
    match: exact("GET", "/api/v1/model-sources"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await modelSourceService(ctx.dependencies).list() });
    },
  },
];

export const MODEL_SOURCE_WRITE_ROUTES: RouteDefinition[] = [
  {
    auth: "write",
    id: "POST /api/v1/model-sources",
    match: exact("POST", "/api/v1/model-sources"),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      const kind = stringField(body, "kind");
      if (!["kimi", "glm", "qwen", "doubao", "minimax", "deepseek", "generic-openai"].includes(kind)) {
        throw new HttpError("model_source_kind_invalid", "Model source kind is invalid.", 400);
      }
      const accessMode = typeof body.accessMode === "string" ? body.accessMode : undefined;
      if (accessMode !== undefined && !["api", "coding-plan", "token-plan", "custom"].includes(accessMode)) {
        throw new HttpError("model_source_access_mode_invalid", "Model source access mode is invalid.", 400);
      }
      const protocol = typeof body.protocol === "string" ? body.protocol : undefined;
      if (protocol !== undefined && !["openai", "anthropic"].includes(protocol)) {
        throw new HttpError("model_source_protocol_invalid", "Model source protocol is invalid.", 400);
      }
      // These three are numbers, so they need explicit parsing: the string-typed filters used for
      // the remaining fields silently drop anything that is not a string.
      const compactionThresholdPercent = optionalIntegerField(body, "compactionThresholdPercent");
      const contextWindow = optionalIntegerField(body, "contextWindow");
      const maxOutputTokens = optionalIntegerField(body, "maxOutputTokens");
      const thinkingEffort = optionalEnumField(body, "thinkingEffort", THINKING_EFFORTS);
      const source = await modelSourceService(ctx.dependencies).create({
        ...(accessMode === undefined ? {} : { accessMode: accessMode as "api" | "coding-plan" | "token-plan" | "custom" }),
        apiKey: stringField(body, "apiKey"),
        kind: kind as Parameters<ModelSourceService["create"]>[0]["kind"],
        ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
        ...(protocol === undefined ? {} : { protocol: protocol as "openai" | "anthropic" }),
        ...(typeof compactionThresholdPercent === "number" ? { compactionThresholdPercent } : {}),
        ...(typeof contextWindow === "number" ? { contextWindow } : {}),
        ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}),
        ...(typeof thinkingEffort === "string" ? { thinkingEffort } : {}),
      });
      sendJson(ctx.response, 201, source);
    },
  },
  {
    auth: "write",
    id: "PUT /api/v1/model-sources/order",
    match: exact("PUT", "/api/v1/model-sources/order"),
    handle: async (ctx) => {
      const sourceIds = optionalStringArray(await readJson(ctx.request), "sourceIds");
      if (sourceIds === undefined) throw new HttpError("request_field_invalid", "sourceIds is required.", 400);
      sendJson(ctx.response, 200, { items: await modelSourceService(ctx.dependencies).setOrder(sourceIds) });
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/model-sources/:sourceId/validate",
    match: pattern("POST", /^\/api\/v1\/model-sources\/([^/]+)\/validate$/),
    handle: async (ctx, match) => {
      const validated = await modelSourceService(ctx.dependencies).validate(decodeURIComponent((match as RegExpExecArray)[1] ?? ""));
      sendJson(ctx.response, 200, validated);
    },
  },
  {
    auth: "write",
    id: "PATCH /api/v1/model-sources/:sourceId",
    match: pattern("PATCH", /^\/api\/v1\/model-sources\/([^/]+)$/),
    handle: async (ctx, match) => {
      const sourceId = decodeURIComponent((match as RegExpExecArray)[1] ?? "");
      const body = await readJson(ctx.request);
      // Keeps all three states: omitted leaves the value alone, null clears it, a number sets it.
      const compactionThresholdPercent = optionalIntegerField(body, "compactionThresholdPercent");
      const contextWindow = optionalIntegerField(body, "contextWindow");
      const maxOutputTokens = optionalIntegerField(body, "maxOutputTokens");
      const thinkingEffort = optionalEnumField(body, "thinkingEffort", THINKING_EFFORTS);
      const source = body.disabled === true
        ? await modelSourceService(ctx.dependencies).disable(sourceId)
        : await modelSourceService(ctx.dependencies).update(sourceId, {
          ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
          ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
          ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
          ...(typeof body.modelId === "string" ? { modelId: body.modelId } : {}),
          ...(compactionThresholdPercent === undefined ? {} : { compactionThresholdPercent }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
          ...(thinkingEffort === undefined ? {} : { thinkingEffort }),
        });
      sendJson(ctx.response, 200, source);
    },
  },
  {
    auth: "write",
    id: "DELETE /api/v1/model-sources/:sourceId",
    match: pattern("DELETE", /^\/api\/v1\/model-sources\/([^/]+)$/),
    handle: async (ctx, match) => {
      await modelSourceService(ctx.dependencies).delete(decodeURIComponent((match as RegExpExecArray)[1] ?? ""));
      sendEmpty(ctx.response, 204);
    },
  },
];
