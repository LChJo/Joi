import {
  HttpError,
  readJson,
  sendEmpty,
  sendJson,
  sessionToken,
  stringField,
} from "../http-core.js";
import { interactionService, onboardingService } from "../api-dependencies.js";
import { isLocalePreference } from "../../../../shared/i18n/index.js";
import { exact, pattern, type RouteDefinition } from "../route-types.js";

export const AGENT_ROUTES: RouteDefinition[] = [
  {
    auth: "read",
    id: "GET /api/v1/agents",
    match: exact("GET", "/api/v1/agents"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await ctx.dependencies.agents.list() });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/interactions",
    match: exact("GET", "/api/v1/interactions"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await interactionService(ctx.dependencies).listPending() });
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/interactions/:interactionId/answer",
    match: pattern("POST", /^\/api\/v1\/interactions\/([^/]+)\/answer$/),
    handle: async (ctx, match) => {
      const body = await readJson(ctx.request);
      sendJson(ctx.response, 200, await interactionService(ctx.dependencies).answer(
        decodeURIComponent((match as RegExpExecArray)[1] ?? ""), stringField(body, "answer"),
      ));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/interactions/:interactionId/resume-authorization",
    match: pattern("POST", /^\/api\/v1\/interactions\/([^/]+)\/resume-authorization$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 200, await interactionService(ctx.dependencies).resumeAuthorization(
        decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
      ));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/agents",
    match: exact("POST", "/api/v1/agents"),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      const connection = await onboardingService(ctx.dependencies).onboard({
        cardUrl: stringField(body, "cardUrl"),
        token: stringField(body, "token"),
      });
      sendJson(ctx.response, 201, connection);
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/agents/:agentConnectionId/deletion-impact",
    match: pattern("GET", /^\/api\/v1\/agents\/([^/]+)\/deletion-impact$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 200, await onboardingService(ctx.dependencies).deletionImpact(decodeURIComponent((match as RegExpExecArray)[1] ?? "")));
    },
  },
  {
    auth: "write",
    id: "DELETE /api/v1/agents/:agentConnectionId",
    match: pattern("DELETE", /^\/api\/v1\/agents\/([^/]+)$/),
    handle: async (ctx, match) => {
      await onboardingService(ctx.dependencies).delete(decodeURIComponent((match as RegExpExecArray)[1] ?? ""));
      sendEmpty(ctx.response, 204);
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/agents/:agentConnectionId/(refresh|rotate-token|disable|enable)",
    match: pattern("POST", /^\/api\/v1\/agents\/([^/]+)\/(refresh|rotate-token|disable|enable)$/),
    handle: async (ctx, match) => {
      const groups = match as RegExpExecArray;
      const agentConnectionId = decodeURIComponent(groups[1] ?? "");
      const action = groups[2];
      if (action === "refresh") {
        sendJson(ctx.response, 200, await onboardingService(ctx.dependencies).refresh(agentConnectionId));
        return;
      }
      if (action === "disable") {
        sendJson(ctx.response, 200, await onboardingService(ctx.dependencies).disable(agentConnectionId));
        return;
      }
      if (action === "enable") {
        sendJson(ctx.response, 200, await onboardingService(ctx.dependencies).enable(agentConnectionId));
        return;
      }
      const body = await readJson(ctx.request);
      sendJson(ctx.response, 200, await onboardingService(ctx.dependencies).rotateToken(agentConnectionId, stringField(body, "token")));
    },
  },
];

export const SYSTEM_ROUTES: RouteDefinition[] = [
  {
    auth: "write",
    id: "POST /api/v1/runtime/emergency-stop",
    match: exact("POST", "/api/v1/runtime/emergency-stop"),
    handle: async (ctx) => {
      if (ctx.dependencies.globalEmergencyStop === undefined) throw new HttpError("runtime_unavailable", "Global Runtime control is unavailable.", 503);
      await ctx.dependencies.globalEmergencyStop();
      sendEmpty(ctx.response, 204);
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/diagnostics",
    match: exact("GET", "/api/v1/diagnostics"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, await ctx.dependencies.operations.diagnostics());
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/diagnostics/integrity-check",
    match: exact("POST", "/api/v1/diagnostics/integrity-check"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, await ctx.dependencies.operations.checkDatabaseIntegrity());
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/diagnostics/export",
    match: exact("GET", "/api/v1/diagnostics/export"),
    handle: async (ctx) => {
      await ctx.dependencies.auth.authenticate(sessionToken(ctx.request));
      sendJson(ctx.response, 200, await ctx.dependencies.operations.diagnostics(), {
        "content-disposition": `attachment; filename="joi-diagnostics-${new Date().toISOString().slice(0, 10)}.json"`,
      });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/settings",
    match: exact("GET", "/api/v1/settings"),
    handle: async (ctx) => {
      if (ctx.dependencies.settings === undefined) throw new HttpError("settings_unavailable", "Runtime settings are unavailable.", 503);
      sendJson(ctx.response, 200, await ctx.dependencies.settings.get());
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/settings",
    match: exact("POST", "/api/v1/settings"),
    handle: async (ctx) => {
      if (ctx.dependencies.settings === undefined) throw new HttpError("settings_unavailable", "Runtime settings are unavailable.", 503);
      const body = await readJson(ctx.request);
      if (body.uiLocale !== undefined) {
        const session = await ctx.dependencies.auth.authenticate(sessionToken(ctx.request));
        if (session.kind !== "desktop") throw new HttpError("desktop_required", "Desktop language is local to this computer.", 403);
        if (!isLocalePreference(body.uiLocale)) throw new HttpError("ui_locale_invalid", "Unsupported interface language.", 400);
      }
      if (body.joiSkills !== undefined && (!Array.isArray(body.joiSkills) || body.joiSkills.some((ref: unknown) => typeof ref !== "string"))) {
        throw new HttpError("joi_skills_invalid", "技能选择必须是引用列表。", 400);
      }
      const lanBody = body.lan;
      const lan = lanBody !== null && typeof lanBody === "object" && !Array.isArray(lanBody)
        ? lanBody as Record<string, unknown>
        : undefined;
      sendJson(ctx.response, 200, await ctx.dependencies.settings.update({
        ...(isLocalePreference(body.uiLocale) ? { uiLocale: body.uiLocale } : {}),
        ...(body.joiSkills === undefined ? {} : { joiSkills: body.joiSkills as string[] }),
        ...(typeof body.launchAtLogin === "boolean" ? { launchAtLogin: body.launchAtLogin } : {}),
        ...(lan === undefined ? {} : { lan: {
          ...(typeof lan.address === "string" ? { address: lan.address } : {}),
          ...(typeof lan.enabled === "boolean" ? { enabled: lan.enabled } : {}),
          ...(typeof lan.port === "number" ? { port: lan.port } : {}),
          ...(typeof lan.riskAccepted === "boolean" ? { riskAccepted: lan.riskAccepted } : {}),
        } }),
      }));
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/backups",
    match: exact("GET", "/api/v1/backups"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await ctx.dependencies.operations.listBackups() });
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/backups",
    match: exact("POST", "/api/v1/backups"),
    handle: async (ctx) => {
      sendJson(ctx.response, 201, await ctx.dependencies.operations.createBackup());
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/backups/:backupId/restore",
    match: pattern("POST", /^\/api\/v1\/backups\/([^/]+)\/restore$/),
    handle: async (ctx, match) => {
      const result = await ctx.dependencies.operations.stageRestore(decodeURIComponent((match as RegExpExecArray)[1] ?? ""));
      sendJson(ctx.response, 202, result);
      if (ctx.dependencies.requestRestart !== undefined) setTimeout(ctx.dependencies.requestRestart, 50).unref();
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/backups/manifest",
    match: exact("POST", "/api/v1/backups/manifest"),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      const artifactCount = body.artifactCount;
      const artifactTotalBytes = body.artifactTotalBytes;
      if (typeof artifactCount !== "number" || typeof artifactTotalBytes !== "number") {
        throw new HttpError("request_field_invalid", "Backup artifact counts must be numbers.", 400);
      }
      sendJson(ctx.response, 201, await ctx.dependencies.operations.createBackupManifest({
        appVersion: stringField(body, "appVersion"), artifactCount, artifactTotalBytes,
      }));
    },
  },
];
