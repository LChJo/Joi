import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ApiHandler } from "./api-handler.js";
import { isRfc1918Address } from "../../application/ports/system-settings.js";

interface ListeningEndpoint {
  address: string;
  port: number;
  status: "listening";
  url: string;
}

interface ListenerError {
  code: "invalid_lan_address" | "lan_bind_failed";
  message: string;
  status: "error";
}

export interface RuntimeListeners {
  close(): Promise<void>;
  lan?: ListeningEndpoint | ListenerError;
  loopback: ListeningEndpoint;
}

function createHttpServer(handler: ApiHandler): Server {
  return createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ code: "internal_error", message: "The request could not be completed." }));
    });
  });
}

function listen(server: Server, address: string, port: number): Promise<ListeningEndpoint> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, address, () => {
      server.off("error", onError);
      const bound = server.address() as AddressInfo;
      resolve({ address, port: bound.port, status: "listening", url: `http://${address}:${String(bound.port)}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

export async function startRuntimeListeners(input: {
  handler: ApiHandler;
  lan?: { address: string; port: number };
  loopbackPort: number;
}): Promise<RuntimeListeners> {
  const servers: Server[] = [];
  const loopbackServer = createHttpServer(input.handler);
  const loopback = await listen(loopbackServer, "127.0.0.1", input.loopbackPort);
  servers.push(loopbackServer);

  let lan: ListeningEndpoint | ListenerError | undefined;
  if (input.lan !== undefined) {
    if (!isRfc1918Address(input.lan.address)) {
      lan = { code: "invalid_lan_address", message: "LAN listener requires an explicit RFC1918 IPv4 address.", status: "error" };
    } else {
      const lanServer = createHttpServer(input.handler);
      try {
        lan = await listen(lanServer, input.lan.address, input.lan.port);
        servers.push(lanServer);
      } catch {
        lan = { code: "lan_bind_failed", message: "LAN listener could not bind to the selected address and port.", status: "error" };
      }
    }
  }

  return {
    async close() {
      await Promise.all(servers.map(async (server) => closeServer(server)));
    },
    ...(lan === undefined ? {} : { lan }),
    loopback,
  };
}
