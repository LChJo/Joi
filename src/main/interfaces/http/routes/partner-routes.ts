import {
  base64Field,
  buildScenarioList,
  HttpError,
  optionalStringArray,
  readJson,
  sendEmpty,
  sendJson,
  stringField,
} from "../http-core.js";
import {
  assertLocalEngineAvailable,
  partnerEngineCatalog,
  partnerEngineField,
  partnerEngineParam,
  partnerInstanceManager,
  partnerKnowledgeService,
  partnerRegistryService,
  partnerSkillCatalog,
  rejectPartnerWorkspace,
} from "../api-dependencies.js";
import { exact, pattern, type RouteDefinition } from "../route-types.js";

export const PARTNER_CATALOG_ROUTES: RouteDefinition[] = [
  {
    auth: "read",
    id: "GET /api/v1/partners",
    match: exact("GET", "/api/v1/partners"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await partnerRegistryService(ctx.dependencies).list() });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/engines",
    match: exact("GET", "/api/v1/engines"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await partnerEngineCatalog(ctx.dependencies).list() });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/engines/:engine/skills",
    match: pattern("GET", /^\/api\/v1\/engines\/([^/]+)\/skills$/),
    handle: (ctx, match) => {
      const engine = partnerEngineParam(decodeURIComponent((match as RegExpExecArray)[1] ?? ""));
      sendJson(ctx.response, 200, { items: partnerSkillCatalog(ctx.dependencies).listForEngine(engine) });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/system/pick-directory",
    match: exact("GET", "/api/v1/system/pick-directory"),
    handle: () => {
      throw new HttpError("absolute_path_response_forbidden", "Directory selection is scoped to a workbench workspace operation.", 410);
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/scenarios",
    match: exact("GET", "/api/v1/scenarios"),
    handle: (ctx) => {
      sendJson(ctx.response, 200, { items: buildScenarioList(ctx.dependencies.skills === undefined ? [] : ctx.dependencies.skills.listForEngine("pi-core")) });
    },
  },
];

export const PARTNER_MUTATION_ROUTES: RouteDefinition[] = [
  {
    auth: "write",
    id: "POST /api/v1/scenarios/:scenarioId/partners",
    match: pattern("POST", /^\/api\/v1\/scenarios\/([^/]+)\/partners$/),
    handle: async (ctx, match) => {
      const scenarios = buildScenarioList(ctx.dependencies.skills === undefined ? [] : ctx.dependencies.skills.listForEngine("pi-core"));
      const scenario = scenarios.find((item) => item.id === decodeURIComponent((match as RegExpExecArray)[1] ?? ""));
      if (scenario === undefined) throw new HttpError("scenario_not_found", "Scenario was not found.", 404);
      const body = await readJson(ctx.request);
      const requested = optionalStringArray(body, "roleIds");
      const roles = scenario.roles ?? [];
      const chosen = requested === undefined ? roles : roles.filter((role) => requested.includes(role.id));
      if (requested !== undefined && (chosen.length === 0 || chosen.length !== requested.length)) {
        throw new HttpError("scenario_role_invalid", "Scenario roles are invalid.", 400);
      }
      const items = [];
      for (const role of chosen) {
        items.push(await partnerRegistryService(ctx.dependencies).add({
          capabilities: [],
          ...(role.blurb === undefined ? {} : { description: role.blurb }),
          displayName: role.title,
          kind: "local-pi",
          prompt: role.prompt,
          skills: role.skills ?? [],
          tools: [],
        }));
      }
      sendJson(ctx.response, 201, { items });
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/partners",
    match: exact("POST", "/api/v1/partners"),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      rejectPartnerWorkspace(body);
      const kind = stringField(body, "kind");
      if (kind !== "local-pi" && kind !== "a2a") throw new HttpError("partner_kind_invalid", "Partner kind is invalid.", 400);
      const engine = partnerEngineField(body);
      await assertLocalEngineAvailable(ctx.dependencies, engine);
      sendJson(ctx.response, 201, await partnerRegistryService(ctx.dependencies).add({
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
      }));
    },
  },
  {
    auth: "write",
    id: "PATCH /api/v1/partners/:partnerId",
    match: pattern("PATCH", /^\/api\/v1\/partners\/([^/]+)$/),
    handle: async (ctx, match) => {
      const partnerId = decodeURIComponent((match as RegExpExecArray)[1] ?? "");
      const body = await readJson(ctx.request);
      rejectPartnerWorkspace(body);
      if (body.disabled === true) {
        sendJson(ctx.response, 200, await partnerRegistryService(ctx.dependencies).disable(partnerId));
        return;
      }
      if (body.disabled === false) {
        sendJson(ctx.response, 200, await partnerRegistryService(ctx.dependencies).enable(partnerId));
        return;
      }
      const engine = partnerEngineField(body);
      await assertLocalEngineAvailable(ctx.dependencies, engine);
      sendJson(ctx.response, 200, await partnerRegistryService(ctx.dependencies).update(partnerId, {
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
      }));
    },
  },
  {
    auth: "write",
    id: "DELETE /api/v1/partners/:partnerId",
    match: pattern("DELETE", /^\/api\/v1\/partners\/([^/]+)$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 200, await partnerRegistryService(ctx.dependencies).delete(decodeURIComponent((match as RegExpExecArray)[1] ?? "")));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/partners/:partnerId/duplicate",
    match: pattern("POST", /^\/api\/v1\/partners\/([^/]+)\/duplicate$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 201, await partnerRegistryService(ctx.dependencies).duplicate(decodeURIComponent((match as RegExpExecArray)[1] ?? "")));
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/partners/:partnerId/knowledge",
    match: pattern("GET", /^\/api\/v1\/partners\/([^/]+)\/knowledge$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 200, { items: await partnerKnowledgeService(ctx.dependencies).list(decodeURIComponent((match as RegExpExecArray)[1] ?? "")) });
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/partners/:partnerId/knowledge",
    match: pattern("POST", /^\/api\/v1\/partners\/([^/]+)\/knowledge$/),
    handle: async (ctx, match) => {
      const partnerId = decodeURIComponent((match as RegExpExecArray)[1] ?? "");
      const body = await readJson(ctx.request);
      sendJson(ctx.response, 201, await partnerKnowledgeService(ctx.dependencies).add({
        body: Buffer.from(base64Field(body, "contentBase64")).toString("utf8"),
        filename: stringField(body, "filename"),
        partnerId,
      }));
    },
  },
  {
    auth: "write",
    id: "DELETE /api/v1/partners/:partnerId/knowledge/:docId",
    match: pattern("DELETE", /^\/api\/v1\/partners\/([^/]+)\/knowledge\/([^/]+)$/),
    handle: async (ctx, match) => {
      const groups = match as RegExpExecArray;
      const removed = await partnerKnowledgeService(ctx.dependencies).remove(
        decodeURIComponent(groups[1] ?? ""),
        decodeURIComponent(groups[2] ?? ""),
      );
      if (!removed) throw new HttpError("partner_kb_doc_not_found", "Knowledge document was not found.", 404);
      sendEmpty(ctx.response, 204);
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/partners/:partnerId/memory",
    match: pattern("GET", /^\/api\/v1\/partners\/([^/]+)\/memory$/),
    handle: () => {
      throw new HttpError("partner_memory_private", "Partner work memory is private to Workbench execution context.", 410);
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/partners/:partnerId/instances",
    match: pattern("GET", /^\/api\/v1\/partners\/([^/]+)\/instances$/),
    handle: async (ctx, match) => {
      const workbenchId = ctx.url.searchParams.get("workbenchId");
      if (workbenchId === null || workbenchId.trim() === "") throw new HttpError("workbench_id_required", "Workbench is required.", 400);
      sendJson(ctx.response, 200, { items: await partnerInstanceManager(ctx.dependencies).list({
        workbenchId,
        partnerId: decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
      }) });
    },
  },
];
