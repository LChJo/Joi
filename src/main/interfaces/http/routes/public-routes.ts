import {
  artifactDisposition,
  csrfToken,
  expectedOrigin,
  readJson,
  requestAddress,
  requestOrigin,
  sendEmpty,
  sendJson,
  sessionCookie,
  sessionToken,
  stringField,
} from "../http-core.js";
import { artifactService } from "../api-dependencies.js";
import { exact, pattern, type PublicRouteDefinition } from "../route-types.js";

export const PUBLIC_ROUTES: PublicRouteDefinition[] = [
  {
    id: "GET /api/v1/health",
    match: exact("GET", "/api/v1/health"),
    handle: (ctx) => {
      sendJson(ctx.response, 200, { database: "open", status: "ok" });
    },
  },
  {
    id: "GET /api/v1/auth/status",
    match: exact("GET", "/api/v1/auth/status"),
    handle: async (ctx) => {
      sendJson(ctx.response, 200, { configured: await ctx.dependencies.auth.isConfigured() });
    },
  },
  {
    id: "GET /api/v1/lives/:lifeId/artifacts/:artifactId/:mode",
    match: pattern("GET", /^\/api\/v1\/lives\/([^/]+)\/artifacts\/([^/]+)\/(download|preview)$/),
    handle: async (ctx, match) => {
      const groups = match as RegExpExecArray;
      await ctx.dependencies.auth.authenticate(sessionToken(ctx.request));
      const mode = groups[3] === "preview" ? "inline" : "attachment";
      const content = await artifactService(ctx.dependencies).read({
        artifactId: decodeURIComponent(groups[2] ?? ""),
        lifeId: decodeURIComponent(groups[1] ?? ""),
        preview: mode === "inline",
      });
      ctx.response.writeHead(200, {
        "cache-control": "no-store",
        "content-disposition": artifactDisposition(content.filename, mode),
        "content-length": String(content.bytes.byteLength),
        "content-security-policy": "sandbox; default-src 'none'",
        "content-type": content.mimeType,
        "x-content-type-options": "nosniff",
      });
      ctx.response.end(content.bytes);
    },
  },
  {
    id: "POST /api/v1/auth/bootstrap",
    match: exact("POST", "/api/v1/auth/bootstrap"),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      const grant = await ctx.dependencies.auth.exchangeDesktopBootstrap({
        nonce: stringField(body, "nonce"),
        remoteAddress: requestAddress(ctx.request),
      });
      sendJson(ctx.response, 200, { csrfToken: grant.csrfToken, expiresAt: grant.expiresAt }, { "set-cookie": sessionCookie(grant) });
    },
  },
  {
    id: "POST /api/v1/auth/login",
    match: exact("POST", "/api/v1/auth/login"),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      const grant = await ctx.dependencies.auth.login({
        expectedOrigin: expectedOrigin(ctx.request),
        origin: requestOrigin(ctx.request),
        password: stringField(body, "password"),
        remoteAddress: requestAddress(ctx.request),
      });
      sendJson(ctx.response, 200, { csrfToken: grant.csrfToken, expiresAt: grant.expiresAt }, { "set-cookie": sessionCookie(grant) });
    },
  },
  {
    id: "POST /api/v1/auth/setup",
    match: exact("POST", "/api/v1/auth/setup"),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      await ctx.dependencies.auth.setupPassword({
        csrfToken: csrfToken(ctx.request),
        origin: requestOrigin(ctx.request),
        password: stringField(body, "password"),
        remoteAddress: requestAddress(ctx.request),
        sessionToken: sessionToken(ctx.request),
      });
      sendEmpty(ctx.response, 204);
    },
  },
];
