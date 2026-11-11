import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { ApiHandler } from "./api-handler.js";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src http: https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function createStaticRendererHandler(api: ApiHandler, rendererDirectory: string): ApiHandler {
  const root = path.resolve(rendererDirectory);
  return async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return api(request, response);
    if (request.method !== "GET" && request.method !== "HEAD") return api(request, response);

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400, SECURITY_HEADERS);
      response.end();
      return;
    }
    const requested = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    const candidate = path.resolve(root, requested);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      response.writeHead(404, SECURITY_HEADERS);
      response.end();
      return;
    }
    const hasExtension = path.extname(candidate) !== "";
    const filePath = hasExtension ? candidate : path.join(root, "index.html");
    try {
      const body = await readFile(filePath);
      const extension = path.extname(filePath).toLowerCase();
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "cache-control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable",
        "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, SECURITY_HEADERS);
      response.end();
    }
  };
}
