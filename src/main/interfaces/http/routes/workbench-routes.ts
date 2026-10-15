import {
  HttpError,
  readJson,
  sendEmpty,
  sendJson,
  sessionToken,
  stringField,
} from "../http-core.js";
import { AuthError } from "../../../application/auth/auth-service.js";
import { workbenchAgentService, workbenchChangeService } from "../api-dependencies.js";
import { exact, pattern, type RouteDefinition } from "../route-types.js";

export const WORKBENCH_ROUTES: RouteDefinition[] = [
  {
    auth: "write",
    id: "POST /api/v1/workbenches/:workbenchId/archive",
    match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/archive$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 200, await workbenchChangeService(ctx.dependencies).archive(
        decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
      ));
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/workbenches",
    match: exact("GET", "/api/v1/workbenches"),
    handle: async (ctx) => {
      if (ctx.dependencies.workbenches === undefined) throw new HttpError("workbench_catalog_unavailable", "Workbench catalog is unavailable.", 503);
      sendJson(ctx.response, 200, { items: await ctx.dependencies.workbenches.listSummaries() });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/workbenches/:workbenchId/agents",
    match: pattern("GET", /^\/api\/v1\/workbenches\/([^/]+)\/agents$/),
    handle: async (ctx, match) => {
      const cursor = ctx.url.searchParams.get("cursor") ?? undefined;
      const goalId = ctx.url.searchParams.get("goalId") ?? undefined;
      const requestedLimit = Number(ctx.url.searchParams.get("limit") ?? "50");
      sendJson(ctx.response, 200, await workbenchAgentService(ctx.dependencies).list({
        workbenchId: decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
        ...(cursor === undefined ? {} : { cursor }),
        ...(goalId === undefined ? {} : { goalId }),
        limit: Number.isFinite(requestedLimit) ? requestedLimit : 50,
      }));
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/workbenches/:workbenchId/agents/:agentId/conversation",
    match: pattern("GET", /^\/api\/v1\/workbenches\/([^/]+)\/agents\/([^/]+)\/conversation$/),
    handle: async (ctx, match) => {
      const groups = match as RegExpExecArray;
      const cursor = ctx.url.searchParams.get("cursor") ?? undefined;
      const requestedLimit = Number(ctx.url.searchParams.get("limit") ?? "50");
      sendJson(ctx.response, 200, await workbenchAgentService(ctx.dependencies).conversation({
        agentId: decodeURIComponent(groups[2] ?? ""),
        latest: ctx.url.searchParams.get("latest") === "true",
        ...(ctx.url.searchParams.has("goalId") ? { goalId: ctx.url.searchParams.get("goalId") ?? "" } : {}),
        workbenchId: decodeURIComponent(groups[1] ?? ""),
        ...(cursor === undefined ? {} : { cursor }),
        limit: Number.isFinite(requestedLimit) ? requestedLimit : 50,
      }));
    },
  },
  {
    // Private tool bodies are machine-generated facts about this computer (commands and local
    // paths), not text the user typed, so they are desktop-only rather than merely write-gated.
    auth: "write",
    id: "POST /api/v1/workbenches/:workbenchId/agents/:agentId/tool-traces/:toolCallId/reveal",
    match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/agents\/([^/]+)\/tool-traces\/([^/]+)\/reveal$/),
    handle: async (ctx, match) => {
      const session = await ctx.dependencies.auth.authenticate(sessionToken(ctx.request));
      if (session.kind !== "desktop") throw new AuthError("desktop_required", "Tool output can only be read from this computer.", 403);
      const groups = match as RegExpExecArray;
      sendJson(ctx.response, 200, await workbenchAgentService(ctx.dependencies).revealToolTrace({
        agentId: decodeURIComponent(groups[2] ?? ""),
        toolCallId: decodeURIComponent(groups[3] ?? ""),
        workbenchId: decodeURIComponent(groups[1] ?? ""),
      }));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/workbenches/:workbenchId/artifacts/:artifactId/open",
    match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/artifacts\/([^/]+)\/open$/),
    handle: async (ctx, match) => {
      const session = await ctx.dependencies.auth.authenticate(sessionToken(ctx.request));
      if (session.kind !== "desktop") throw new AuthError("desktop_required", "Artifacts can only be opened from this computer.", 403);
      const groups = match as RegExpExecArray;
      const body = await readJson(ctx.request);
      const mode = stringField(body, "mode");
      const source = stringField(body, "source");
      if (mode !== "OPEN" && mode !== "REVEAL") throw new HttpError("workbench_artifact_mode_invalid", "Artifact mode must be OPEN or REVEAL.", 400);
      if (source !== "AGENT" && source !== "GOAL") throw new HttpError("workbench_artifact_source_invalid", "Artifact source must be AGENT or GOAL.", 400);
      sendJson(ctx.response, 200, await workbenchAgentService(ctx.dependencies).openArtifact({
        artifactId: decodeURIComponent(groups[2] ?? ""),
        mode,
        source,
        sourceId: stringField(body, "sourceId"),
        workbenchId: decodeURIComponent(groups[1] ?? ""),
      }));
    },
  },
  {
    auth: "write",
    id: "DELETE /api/v1/workbenches/:workbenchId/agents/:agentId",
    match: pattern("DELETE", /^\/api\/v1\/workbenches\/([^/]+)\/agents\/([^/]+)$/),
    handle: async (ctx, match) => {
      const groups = match as RegExpExecArray;
      await workbenchAgentService(ctx.dependencies).dismiss({
        agentId: decodeURIComponent(groups[2] ?? ""),
        workbenchId: decodeURIComponent(groups[1] ?? ""),
      });
      sendEmpty(ctx.response, 204);
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/workbenches/:workbenchId",
    match: pattern("GET", /^\/api\/v1\/workbenches\/([^/]+)$/),
    handle: async (ctx, match) => {
      if (ctx.dependencies.workbenchManagement === undefined) throw new HttpError("workbench_management_unavailable", "Workbench management is unavailable.", 503);
      sendJson(ctx.response, 200, await ctx.dependencies.workbenchManagement.get(decodeURIComponent((match as RegExpExecArray)[1] ?? "")));
    },
  },
  {
    auth: "write",
    id: "PATCH /api/v1/workbenches/:workbenchId",
    match: pattern("PATCH", /^\/api\/v1\/workbenches\/([^/]+)$/),
    handle: async (ctx, match) => {
      if (ctx.dependencies.workbenchManagement === undefined) throw new HttpError("workbench_management_unavailable", "Workbench management is unavailable.", 503);
      const body = await readJson(ctx.request);
      sendJson(ctx.response, 200, await ctx.dependencies.workbenchManagement.update(decodeURIComponent((match as RegExpExecArray)[1] ?? ""), {
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.persona === "string" ? { persona: body.persona } : {}),
        ...(typeof body.projectLabel === "string" ? { projectLabel: body.projectLabel } : {}),
        ...(typeof body.responsibility === "string" ? { responsibility: body.responsibility } : {}),
      }));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/workbenches/:workbenchId/workspace/bind",
    match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/workspace\/bind$/),
    handle: async (ctx, match) => {
      if (ctx.dependencies.workbenchWorkspaces === undefined || ctx.dependencies.directoryPicker === undefined) throw new HttpError("workbench_workspace_unavailable", "Workbench workspace management is unavailable.", 503);
      const selected = await ctx.dependencies.directoryPicker();
      if (selected === null) throw new HttpError("workbench_workspace_selection_canceled", "Directory selection was canceled.", 409);
      sendJson(ctx.response, 200, await ctx.dependencies.workbenchWorkspaces.bindExisting(decodeURIComponent((match as RegExpExecArray)[1] ?? ""), selected));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/workbenches/:workbenchId/workspace/rebuild",
    match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/workspace\/rebuild$/),
    handle: async (ctx, match) => {
      if (ctx.dependencies.workbenchWorkspaces === undefined) throw new HttpError("workbench_workspace_unavailable", "Workbench workspace management is unavailable.", 503);
      sendJson(ctx.response, 202, await ctx.dependencies.workbenchWorkspaces.rebuildManaged(decodeURIComponent((match as RegExpExecArray)[1] ?? "")));
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/workbench-change-requests",
    match: exact("GET", "/api/v1/workbench-change-requests"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await workbenchChangeService(ctx.dependencies).listPending() });
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/workbench-change-requests/:requestId/decision",
    match: pattern("POST", /^\/api\/v1\/workbench-change-requests\/([^/]+)\/decision$/),
    handle: async (ctx, match) => {
      const body = await readJson(ctx.request);
      const decision = stringField(body, "decision");
      if (decision !== "CONFIRM" && decision !== "REJECT") throw new HttpError("workbench_change_decision_invalid", "Decision must be CONFIRM or REJECT.", 400);
      sendJson(ctx.response, 200, await workbenchChangeService(ctx.dependencies).decide({
        decision,
        requestId: decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
      }));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/workbenches",
    match: exact("POST", "/api/v1/workbenches"),
    handle: async (ctx) => {
      if (ctx.dependencies.workbenchRegistry === undefined) throw new HttpError("workbench_registry_unavailable", "Workbench registry is unavailable.", 503);
      const body = await readJson(ctx.request);
      const workbench = await ctx.dependencies.workbenchRegistry.create({
        name: stringField(body, "name"),
        personaSummary: stringField(body, "personaSummary"),
        projectLabel: stringField(body, "projectLabel"),
        scopeSummary: stringField(body, "scopeSummary"),
        ...(body.bindInputId === undefined ? {} : {
          bindInputId: stringField(body, "bindInputId"), questionId: stringField(body, "questionId"),
          questionVersion: typeof body.questionVersion === "number" ? body.questionVersion : 0,
          idempotencyKey: stringField(body, "idempotencyKey"),
        }),
      });
      sendJson(ctx.response, 201, {
        workbenchId: workbench.workbenchId,
        name: workbench.profile.name,
        scopeSummary: workbench.profile.scopeSummary,
        updatedAt: workbench.updatedAt,
      });
    },
  },
];
