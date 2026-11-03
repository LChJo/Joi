import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ApiHandler } from "./api-handler.js";
import { isRfc1918Address } from "../../application/ports/system-settings.js";
import type { LanRuntimeState } from "../../../shared/system-settings.js";

export interface ListeningEndpoint {
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

export interface RuntimeLanTarget {
  address: string;
  port: number;
}

export interface RuntimeListeners {
  close(): Promise<void>;
  lan?: ListeningEndpoint | ListenerError | undefined;
  lanState(): LanRuntimeState;
  reconfigureLan(target: RuntimeLanTarget | undefined): Promise<LanRuntimeState>;
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
  createServer?: (handler: ApiHandler) => Server;
  handler: ApiHandler;
  lan?: { address: string; port: number };
  listen?: (server: Server, address: string, port: number) => Promise<ListeningEndpoint>;
  loopbackPort: number;
}): Promise<RuntimeListeners> {
  const servers: Server[] = [];
  const serverFactory = input.createServer ?? createHttpServer;
  const listenServer = input.listen ?? listen;
  const loopbackServer = serverFactory(input.handler);
  const loopback = await listenServer(loopbackServer, "127.0.0.1", input.loopbackPort);
  servers.push(loopbackServer);

  let lan: ListeningEndpoint | ListenerError | undefined;
  let lanServer: Server | undefined;
  let state: LanRuntimeState = { status: "disabled" };
  let closed = false;
  let operation = Promise.resolve();

  const applyLan = async (target: RuntimeLanTarget | undefined): Promise<LanRuntimeState> => {
    if (closed) return state;
    if (target === undefined) {
      const previous = lanServer;
      lanServer = undefined;
      lan = undefined;
      state = { status: "disabled" };
      if (previous !== undefined) await closeServer(previous).catch(() => undefined);
      return state;
    }
    if (!isRfc1918Address(target.address)) {
      const error: ListenerError = { code: "invalid_lan_address", message: "LAN listener requires an explicit RFC1918 IPv4 address.", status: "error" };
      const previous = lanServer !== undefined && lan !== undefined && "address" in lan ? lan : undefined;
      lan = previous ?? error;
      state = previous === undefined
        ? { status: "blocked", reasonCode: "lan_address_invalid", message: error.message }
        : {
            address: previous.address,
            message: error.message,
            pending: { address: target.address, port: target.port, reasonCode: "lan_address_invalid" },
            port: previous.port,
            status: "listening",
            url: previous.url,
          };
      return state;
    }
    if (lan !== undefined && "address" in lan && lan.address === target.address && lan.port === target.port && lanServer !== undefined) {
      return state;
    }

    const candidate = serverFactory(input.handler);
    let endpoint: ListeningEndpoint;
    try {
      endpoint = await listenServer(candidate, target.address, target.port);
    } catch {
      await closeServer(candidate).catch(() => undefined);
      const message = "LAN listener could not bind to the selected address and port.";
      const previous = lan !== undefined && "address" in lan && lanServer !== undefined ? lan : undefined;
      if (previous === undefined) {
        lan = { code: "lan_bind_failed", message, status: "error" };
        state = { status: "blocked", reasonCode: "lan_bind_failed", message };
      } else {
        state = {
          address: previous.address,
          message,
          pending: { address: target.address, port: target.port, reasonCode: "lan_bind_failed" },
          port: previous.port,
          status: "listening",
          url: previous.url,
        };
      }
      return state;
    }

    const previous = lanServer;
    lanServer = candidate;
    lan = endpoint;
    state = { address: endpoint.address, port: endpoint.port, status: "listening", url: endpoint.url };
    if (previous !== undefined) await closeServer(previous).catch(() => undefined);
    if (!servers.includes(candidate)) servers.push(candidate);
    return state;
  };

  const reconfigureLan = (target: RuntimeLanTarget | undefined): Promise<LanRuntimeState> => {
    const next = operation.then(() => applyLan(target));
    operation = next.then(() => undefined, () => undefined);
    return next;
  };

  if (input.lan !== undefined) await reconfigureLan(input.lan);

  return {
    async close() {
      closed = true;
      await operation;
      await Promise.all(servers.map(async (server) => closeServer(server).catch(() => undefined)));
    },
    get lan() { return lan; },
    lanState: () => state,
    loopback,
    reconfigureLan,
  };
}
