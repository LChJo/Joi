import {
  base64Field,
  HttpError,
  MAX_ATTACHMENT_REQUEST_BYTES,
  optionalStringArray,
  readJson,
  sendJson,
  stringField,
} from "../http-core.js";
import { joiHomeFeedService, joiInboxService, modelSourceService } from "../api-dependencies.js";
import { exact, pattern, type RouteDefinition } from "../route-types.js";

export const JOI_READ_ROUTES: RouteDefinition[] = [
  {
    auth: "read",
    id: "GET /api/v1/joi",
    match: exact("GET", "/api/v1/joi"),
    handle: async (ctx) => {
      const configured = await modelSourceService(ctx.dependencies).hasReadySource();
      sendJson(ctx.response, 200, {
        workbenchChanges: ctx.dependencies.workbenchChanges === undefined ? [] : await ctx.dependencies.workbenchChanges.listPending(),
        workbenches: ctx.dependencies.workbenches === undefined ? [] : await ctx.dependencies.workbenches.listSummaries(),
        modelSources: await modelSourceService(ctx.dependencies).list(),
        partners: ctx.dependencies.partners === undefined ? [] : await ctx.dependencies.partners.list(),
        runtime: { configured, status: configured ? "READY" : "NOT_CONFIGURED" },
        work: ctx.dependencies.work === undefined ? [] : await ctx.dependencies.work.listActive(),
      });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/joi/runtime",
    match: exact("GET", "/api/v1/joi/runtime"),
    handle: async (ctx) => {
      const configured = await modelSourceService(ctx.dependencies).hasReadySource();
      sendJson(ctx.response, 200, { configured, status: configured ? "READY" : "NOT_CONFIGURED" });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/joi/messages",
    match: exact("GET", "/api/v1/joi/messages"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await joiInboxService(ctx.dependencies).list() });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/joi/activity",
    match: exact("GET", "/api/v1/joi/activity"),
    handle: async (ctx) => {
      if (ctx.dependencies.joiActivity === undefined) throw new HttpError("joi_activity_unavailable", "joi activity is unavailable.", 503);
      sendJson(ctx.response, 200, { items: await ctx.dependencies.joiActivity.listActivity(100) });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/joi/home-feed",
    match: exact("GET", "/api/v1/joi/home-feed"),
    handle: async (ctx) => {
      const feed = await joiHomeFeedService(ctx.dependencies).load();
      sendJson(ctx.response, 200, {
        ...feed,
        workbenchChanges: ctx.dependencies.workbenchChanges === undefined ? [] : await ctx.dependencies.workbenchChanges.listPending(),
      });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/work",
    match: exact("GET", "/api/v1/work"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: ctx.dependencies.work === undefined ? [] : await ctx.dependencies.work.listActive() });
    },
  },
];

export const JOI_WRITE_ROUTES: RouteDefinition[] = [
  {
    auth: "write",
    id: "POST /api/v1/joi/messages",
    match: exact("POST", "/api/v1/joi/messages"),
    handle: async (ctx) => {
      const idempotencyKey = ctx.request.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string") throw new HttpError("idempotency_key_required", "Idempotency-Key is required.", 400);
      const body = await readJson(ctx.request);
      const accepted = await joiInboxService(ctx.dependencies).accept({
        attachmentIds: optionalStringArray(body, "attachmentIds") ?? [],
        ...(typeof body.workbenchId === "string" ? { workbenchId: body.workbenchId } : {}),
        idempotencyKey,
        text: stringField(body, "text"),
      });
      sendJson(ctx.response, 202, accepted);
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/joi/messages/:inputId/clarify",
    match: pattern("POST", /^\/api\/v1\/joi\/messages\/([^/]+)\/clarify$/),
    handle: async (ctx, match) => {
      const body = await readJson(ctx.request);
      const clarified = await joiInboxService(ctx.dependencies).clarify({
        ...(typeof body.actionChoice === "string" ? { actionChoice: body.actionChoice } : {}),
        ...(typeof body.partnerId === "string" ? { partnerId: body.partnerId } : {}),
        ...(typeof body.questionId === "string" ? { questionId: body.questionId } : {}),
        ...(typeof body.questionVersion === "number" ? { questionVersion: body.questionVersion } : {}),
        ...(typeof body.workbenchId === "string" ? { workbenchId: body.workbenchId } : {}),
        inputId: decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
      });
      sendJson(ctx.response, 202, clarified);
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/joi/messages/:inputId/cancel",
    match: pattern("POST", /^\/api\/v1\/joi\/messages\/([^/]+)\/cancel$/),
    handle: async (ctx, match) => {
      const canceled = await joiInboxService(ctx.dependencies).cancel({
        inputId: decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
      });
      sendJson(ctx.response, 200, canceled);
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/joi/messages/:inputId/dismiss",
    match: pattern("POST", /^\/api\/v1\/joi\/messages\/([^/]+)\/dismiss$/),
    handle: async (ctx, match) => {
      const dismissed = await joiInboxService(ctx.dependencies).dismiss({
        inputId: decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
      });
      sendJson(ctx.response, 200, dismissed);
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/joi/messages/:inputId/close-historical-review",
    match: pattern("POST", /^\/api\/v1\/joi\/messages\/([^/]+)\/close-historical-review$/),
    handle: async (ctx, match) => {
      const closed = await joiInboxService(ctx.dependencies).closeHistoricalReview({
        inputId: decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
      });
      sendJson(ctx.response, 200, closed);
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/joi/messages/:inputId/retry",
    match: pattern("POST", /^\/api\/v1\/joi\/messages\/([^/]+)\/retry$/),
    handle: async (ctx, match) => {
      const body = await readJson(ctx.request);
      const retried = await joiInboxService(ctx.dependencies).retry({
        inputId: decodeURIComponent((match as RegExpExecArray)[1] ?? ""),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
      });
      sendJson(ctx.response, 202, retried);
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/joi/attachments",
    match: exact("POST", "/api/v1/joi/attachments"),
    handle: async (ctx) => {
      if (ctx.dependencies.joiAttachments === undefined) throw new HttpError("joi_attachment_service_unavailable", "joi attachment storage is unavailable.", 503);
      const body = await readJson(ctx.request, MAX_ATTACHMENT_REQUEST_BYTES);
      sendJson(ctx.response, 201, await ctx.dependencies.joiAttachments.upload({
        bytes: base64Field(body, "bytes"),
        filename: stringField(body, "filename"),
        mimeType: stringField(body, "mimeType"),
      }));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/joi/attachments/import",
    match: exact("POST", "/api/v1/joi/attachments/import"),
    handle: async (ctx) => {
      if (ctx.dependencies.joiAttachments === undefined) throw new HttpError("joi_attachment_service_unavailable", "joi attachment storage is unavailable.", 503);
      const body = await readJson(ctx.request, MAX_ATTACHMENT_REQUEST_BYTES);
      sendJson(ctx.response, 201, await ctx.dependencies.joiAttachments.importPath({ path: stringField(body, "path") }));
    },
  },
];
