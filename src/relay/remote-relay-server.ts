import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { WebSocket, WebSocketServer } from "ws";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface RunningRemoteRelayServer {
  close(): Promise<void>;
  httpOrigin: string;
  webSocketOrigin: string;
}

export interface RemoteRelayServer {
  listen(port: number, address: string): Promise<RunningRemoteRelayServer>;
}

function bearer(request: IncomingMessage): string {
  const authorization = request.headers.authorization ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parseMessage(data: WebSocket.RawData): unknown {
  return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8")) as unknown;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, staticDirectory?: string): Promise<void> {
  const url = new URL(request.url ?? "/", "http://relay.invalid");
  if (url.pathname === "/health") {
    response.writeHead(200, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (staticDirectory === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
    response.writeHead(404).end();
    return;
  }
  const root = path.resolve(staticDirectory);
  const requested = decodeURIComponent(url.pathname).replace(/^\/remote(?:\/|$)/u, "").replace(/^\/+/, "");
  const candidate = path.resolve(root, requested === "" || !path.extname(requested) ? "index.html" : requested);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(candidate);
    response.writeHead(200, {
      "cache-control": path.extname(candidate) === ".html" ? "no-store" : "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      "content-type": CONTENT_TYPES[path.extname(candidate)] ?? "application/octet-stream",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
}

export function createRemoteRelayServer(input: {
  hostToken: string;
  maxFrameBytes: number;
  staticDirectory?: string;
}): RemoteRelayServer {
  if (input.hostToken.length < 16) throw new Error("remote_relay_host_token_too_short");
  const http = createServer((request, response) => {
    void serveStatic(request, response, input.staticDirectory).catch(() => response.writeHead(500).end());
  });
  const sockets = new WebSocketServer({ maxPayload: input.maxFrameBytes, noServer: true });
  const hosts = new Map<string, WebSocket>();
  const browsers = new Map<string, { hostId: string; socket: WebSocket }>();

  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    if (url.pathname !== "/host" && url.pathname !== "/connect") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      sockets.emit("connection", webSocket, request);
    });
  });

  sockets.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://relay.invalid");
    if (url.pathname === "/host") {
      if (!tokenMatches(bearer(request), input.hostToken)) {
        socket.close(4401, "unauthorized");
        return;
      }
      let registeredHostId: string | undefined;
      socket.on("message", (data) => {
        let message: unknown;
        try { message = parseMessage(data); } catch { socket.close(4400, "invalid_message"); return; }
        if (message === null || typeof message !== "object") return;
        const record = message as Record<string, unknown>;
        if (registeredHostId === undefined) {
          if (record.kind !== "host.register" || typeof record.hostId !== "string" || record.hostId.length < 8 || record.hostId.length > 160) {
            socket.close(4400, "invalid_registration");
            return;
          }
          registeredHostId = record.hostId;
          const previous = hosts.get(registeredHostId);
          if (previous !== undefined && previous !== socket) previous.close(4409, "host_replaced");
          hosts.set(registeredHostId, socket);
          send(socket, { hostId: registeredHostId, kind: "host.registered" });
          return;
        }
        if (record.kind === "host.frame" && typeof record.connectionId === "string") {
          const browser = browsers.get(record.connectionId);
          if (browser?.hostId === registeredHostId) send(browser.socket, record.frame);
        }
        if (record.kind === "host.close" && typeof record.connectionId === "string") {
          const browser = browsers.get(record.connectionId);
          if (browser?.hostId === registeredHostId) browser.socket.close(4403, "host_rejected");
        }
      });
      socket.on("close", () => {
        if (registeredHostId !== undefined && hosts.get(registeredHostId) === socket) hosts.delete(registeredHostId);
        for (const [connectionId, browser] of browsers) {
          if (browser.hostId === registeredHostId) browser.socket.close(4410, "host_offline");
          if (browser.hostId === registeredHostId) browsers.delete(connectionId);
        }
      });
      return;
    }

    const hostId = url.searchParams.get("host") ?? "";
    const host = hosts.get(hostId);
    if (host?.readyState !== WebSocket.OPEN) {
      socket.close(4404, "host_offline");
      return;
    }
    const connectionId = randomUUID();
    browsers.set(connectionId, { hostId, socket });
    send(socket, { connectionId, kind: "relay.connected" });
    send(host, { connectionId, kind: "browser.open" });
    socket.on("message", (data) => {
      let frame: unknown;
      try { frame = parseMessage(data); } catch { socket.close(4400, "invalid_message"); return; }
      send(host, { connectionId, frame, kind: "browser.frame" });
    });
    socket.on("close", () => {
      if (browsers.get(connectionId)?.socket === socket) browsers.delete(connectionId);
      send(host, { connectionId, kind: "browser.close" });
    });
  });

  return {
    listen(port, address) {
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, address, () => {
          http.off("error", reject);
          const bound = http.address();
          if (bound === null || typeof bound === "string") return reject(new Error("remote_relay_bind_failed"));
          const httpOrigin = `http://${address}:${String(bound.port)}`;
          resolve({
            close: () => closeRelay(http, sockets),
            httpOrigin,
            webSocketOrigin: httpOrigin.replace(/^http/u, "ws"),
          });
        });
      });
    },
  };
}

function closeRelay(server: Server, sockets: WebSocketServer): Promise<void> {
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}
