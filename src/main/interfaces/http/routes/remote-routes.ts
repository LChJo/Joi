import { AuthError } from "../../../application/auth/auth-service.js";
import type { RemoteAccessControl } from "../../../application/ports/remote-access.js";
import { readJson, sendJson, sessionToken } from "../http-core.js";
import { exact, pattern, type RouteDefinition } from "../route-types.js";

function remoteAccess(dependencies: { remoteAccess?: RemoteAccessControl }): RemoteAccessControl {
  if (dependencies.remoteAccess === undefined) throw new AuthError("remote_access_unavailable", "Browser remote access is unavailable.", 503);
  return dependencies.remoteAccess;
}

async function requireDesktop(ctx: Parameters<RouteDefinition["handle"]>[0]): Promise<void> {
  const session = await ctx.dependencies.auth.authenticate(sessionToken(ctx.request));
  if (session.kind !== "desktop") throw new AuthError("desktop_required", "Browser remote access can only be managed from this computer.", 403);
}

export const REMOTE_ROUTES: RouteDefinition[] = [
  {
    auth: "read",
    id: "GET /api/v1/remote",
    match: exact("GET", "/api/v1/remote"),
    handle: async (ctx) => {
      await requireDesktop(ctx);
      sendJson(ctx.response, 200, await remoteAccess(ctx.dependencies).status());
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/remote",
    match: exact("POST", "/api/v1/remote"),
    handle: async (ctx) => {
      await requireDesktop(ctx);
      const body = await readJson(ctx.request);
      sendJson(ctx.response, 200, await remoteAccess(ctx.dependencies).update({
        ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
        ...(typeof body.relayAuthentication === "string" || body.relayAuthentication === null ? { relayAuthentication: body.relayAuthentication } : {}),
        ...(typeof body.relayUrl === "string" ? { relayUrl: body.relayUrl } : {}),
      }));
    },
  },
  {
    auth: "write",
    id: "POST /api/v1/remote/pairings",
    match: exact("POST", "/api/v1/remote/pairings"),
    handle: async (ctx) => {
      await requireDesktop(ctx);
      const access = remoteAccess(ctx.dependencies);
      await access.createPairing();
      sendJson(ctx.response, 201, await access.status());
    },
  },
  {
    auth: "write",
    id: "DELETE /api/v1/remote/devices/:deviceId",
    match: pattern("DELETE", /^\/api\/v1\/remote\/devices\/([^/]+)$/),
    handle: async (ctx, match) => {
      await requireDesktop(ctx);
      const access = remoteAccess(ctx.dependencies);
      await access.revokeDevice(decodeURIComponent((match as RegExpExecArray)[1] ?? ""));
      sendJson(ctx.response, 200, await access.status());
    },
  },
];
