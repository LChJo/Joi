import type { IncomingMessage, ServerResponse } from "node:http";

import type { AuthService } from "../../application/auth/auth-service.js";
import { errorDetails, expectedOrigin, HttpError, sendJson, sessionToken } from "./http-core.js";
import { verifyWrite, type ApiDependencies } from "./api-dependencies.js";
import type { RouteContext } from "./route-types.js";
import { AUTHENTICATED_ROUTES, PUBLIC_ROUTES } from "./routes/index.js";

export type { ApiDependencies } from "./api-dependencies.js";
export { HttpError } from "./http-core.js";

export type ApiHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

/**
 * Declarative HTTP surface. Public routes run before the session gate; every
 * authenticated route is a table entry, and "write" entries get CSRF/Origin
 * verification before the handler runs (same order as the legacy if-chain).
 */
export function createApiHandler(dependencies: ApiDependencies): ApiHandler {
  let requestSequence = 0;
  return async (request, response) => {
    const requestId = `req_${Date.now().toString(36)}_${String(++requestSequence)}`;
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", expectedOrigin(request) || "http://127.0.0.1");
      const pathname = url.pathname;
      const ctx: RouteContext = { dependencies, method, request, response, url };

      for (const route of PUBLIC_ROUTES) {
        const match = route.match(method, pathname);
        if (match === null) continue;
        await route.handle(ctx, match);
        return;
      }

      await authenticateSession(dependencies.auth, request);

      for (const route of AUTHENTICATED_ROUTES) {
        const match = route.match(method, pathname);
        if (match === null) continue;
        if (route.auth === "write") await verifyWrite(dependencies, request);
        await route.handle(ctx, match);
        return;
      }

      throw new HttpError("route_not_found", "API route was not found.", 404);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const failure = errorDetails(error, requestId);
      sendJson(response, failure.status, failure.body);
    }
  };
}

async function authenticateSession(auth: AuthService, request: IncomingMessage): Promise<void> {
  await auth.authenticate(sessionToken(request));
}
