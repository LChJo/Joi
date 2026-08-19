import {
  encodeEventCursor,
  encodeLifeCursor,
  eventCursor,
  HttpError,
  lifeCursor,
  sendJson,
} from "../http-core.js";
import { continuityService, eventService } from "../api-dependencies.js";
import { exact, pattern, type RouteDefinition } from "../route-types.js";

const LEGACY_LIVES_PATH = /^\/api\/v1\/lives(?:\/|$)/u;

export const LEGACY_LIFE_ROUTES: RouteDefinition[] = [
  {
    // Keep the read-only guard first inside this family: any non-GET on legacy
    // Life resources is rejected before resource handling (ADR 0003 / 0011).
    auth: "read",
    id: "ANY /api/v1/lives* (legacy_life_read_only guard)",
    match: (method, pathname) => (method !== "GET" && LEGACY_LIVES_PATH.test(pathname) ? "exact" : null),
    handle: () => {
      throw new HttpError("legacy_life_read_only", "Legacy Life resources are read-only. Use joi and Workbench APIs.", 410);
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/lives",
    match: exact("GET", "/api/v1/lives"),
    handle: async (ctx) => {
      const limitValue = Number(ctx.url.searchParams.get("limit") ?? "20");
      if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100) throw new HttpError("limit_invalid", "limit must be between 1 and 100.", 400);
      const after = lifeCursor(ctx.url.searchParams.get("cursor"));
      const page = await ctx.dependencies.lives.list({
        ...(after === undefined ? {} : { after }),
        limit: limitValue,
      });
      sendJson(ctx.response, 200, { items: page.items, ...(page.next === undefined ? {} : { nextCursor: encodeLifeCursor(page.next) }) });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/lives/:lifeId",
    match: pattern("GET", /^\/api\/v1\/lives\/([^/]+)$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 200, await ctx.dependencies.lives.get(decodeURIComponent((match as RegExpExecArray)[1] ?? "")));
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/lives/:lifeId/deletion-impact",
    match: pattern("GET", /^\/api\/v1\/lives\/([^/]+)\/deletion-impact$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 200, await ctx.dependencies.lives.getDeletionImpact(decodeURIComponent((match as RegExpExecArray)[1] ?? "")));
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/lives/:lifeId/primary-agent",
    match: pattern("GET", /^\/api\/v1\/lives\/([^/]+)\/primary-agent$/),
    handle: async (ctx, match) => {
      sendJson(ctx.response, 200, { items: await ctx.dependencies.lives.getPrimaryAgentHandoffs(decodeURIComponent((match as RegExpExecArray)[1] ?? "")) });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/lives/:lifeId/events",
    match: pattern("GET", /^\/api\/v1\/lives\/([^/]+)\/events$/),
    handle: async (ctx, match) => {
      const lifeId = decodeURIComponent((match as RegExpExecArray)[1] ?? "");
      await ctx.dependencies.lives.get(lifeId);
      const limit = Number(ctx.url.searchParams.get("limit") ?? "100");
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError("limit_invalid", "Event limit must be between 1 and 200.", 400);
      const before = eventCursor(ctx.url.searchParams.get("cursor"));
      const page = await eventService(ctx.dependencies).list(lifeId, { ...(before === undefined ? {} : { before }), limit });
      sendJson(ctx.response, 200, { items: page.items, ...(page.next === undefined ? {} : { nextCursor: encodeEventCursor(page.next) }) });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/lives/:lifeId/activity",
    match: pattern("GET", /^\/api\/v1\/lives\/([^/]+)\/activity$/),
    handle: async (ctx, match) => {
      const lifeId = decodeURIComponent((match as RegExpExecArray)[1] ?? "");
      await ctx.dependencies.lives.get(lifeId);
      sendJson(ctx.response, 200, { items: await eventService(ctx.dependencies).activity(lifeId, 100) });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/lives/:lifeId/(continuity|affairs|todos|alarms|memories|schedules|delegations)",
    match: pattern("GET", /^\/api\/v1\/lives\/([^/]+)\/(continuity|affairs|todos|alarms|memories|schedules|delegations)$/),
    handle: async (ctx, match) => {
      const groups = match as RegExpExecArray;
      const lifeId = decodeURIComponent(groups[1] ?? "");
      const resource = groups[2] ?? "continuity";
      const snapshot = await continuityService(ctx.dependencies).snapshot(lifeId);
      sendJson(ctx.response, 200, resource === "continuity" ? snapshot : { items: snapshot[resource as keyof typeof snapshot] });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/lives/:lifeId/expressions",
    match: pattern("GET", /^\/api\/v1\/lives\/([^/]+)\/expressions$/),
    handle: async (ctx, match) => {
      const lifeId = decodeURIComponent((match as RegExpExecArray)[1] ?? "");
      sendJson(ctx.response, 200, { items: await continuityService(ctx.dependencies).expressions(lifeId) });
    },
  },
];
