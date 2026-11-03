import {
  clearSessionCookie,
  csrfToken,
  expectedOrigin,
  readJson,
  requestAddress,
  requestOrigin,
  sendEmpty,
  sendJson,
  sessionToken,
  stringField,
} from "../http-core.js";
import { exact, type RouteDefinition } from "../route-types.js";

export const AUTH_SESSION_ROUTES: RouteDefinition[] = [
  {
    auth: "read",
    id: "GET /api/v1/auth/session",
    match: exact("GET", "/api/v1/auth/session"),
    handle: (ctx) => {
      sendJson(ctx.response, 200, { authenticated: true });
    },
  },
  {
    auth: "read",
    id: "GET /api/v1/auth/sessions",
    match: exact("GET", "/api/v1/auth/sessions"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { items: await ctx.dependencies.auth.listSessions(sessionToken(ctx.request)) });
    },
  },
];

export const AUTH_MUTATION_ROUTES: RouteDefinition[] = [
  {
    auth: "write",
    id: "POST /api/v1/auth/logout",
    match: exact("POST", "/api/v1/auth/logout"),
    handle: async (ctx) => {
      await ctx.dependencies.auth.logout(sessionToken(ctx.request));
      sendEmpty(ctx.response, 204, { "set-cookie": clearSessionCookie() });
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/auth/logout-all",
    match: exact("POST", "/api/v1/auth/logout-all"),
    handle: async (ctx) => {
      await ctx.dependencies.auth.revokeAllLanSessions();
      sendEmpty(ctx.response, 204);
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/auth/password",
    match: exact("POST", "/api/v1/auth/password"),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      await ctx.dependencies.auth.changePassword({
        csrfToken: csrfToken(ctx.request),
        currentPassword: stringField(body, "currentPassword"),
        expectedOrigin: expectedOrigin(ctx.request),
        newPassword: stringField(body, "newPassword"),
        origin: requestOrigin(ctx.request),
        remoteAddress: requestAddress(ctx.request),
        sessionToken: sessionToken(ctx.request),
      });
      sendEmpty(ctx.response, 204);
    },
  },
];
