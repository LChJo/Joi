import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners, type ListeningEndpoint } from "../../src/main/interfaces/http/runtime-listeners";
import { createRuntimeFixture } from "../support/runtime-fixture";
import { createServer, type Server } from "node:http";

describe("loopback and optional LAN listeners", () => {
  it.each(["0.0.0.0", "203.0.113.8"])("keeps loopback available when LAN address %s is rejected", async (address) => {
    const fixture = await createRuntimeFixture();
    const listeners = await startRuntimeListeners({
      handler: createApiHandler(fixture),
      lan: { address, port: 0 },
      loopbackPort: 0,
    });

    try {
      expect(listeners.lan).toMatchObject({ code: "invalid_lan_address", status: "error" });
      const response = await fetch(`${listeners.loopback.url}/api/v1/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ database: "open", status: "ok" });
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("hot-reconfigures LAN without replacing loopback and keeps the old endpoint on bind failure", async () => {
    const fixture = await createRuntimeFixture();
    const attempts: string[] = [];
    let shouldFail = false;
    const listeners = await startRuntimeListeners({
      createServer: (_handler) => createServer(),
      handler: createApiHandler(fixture),
      lan: { address: "192.168.1.20", port: 43_130 },
      listen: (server: Server, address: string, port: number): Promise<ListeningEndpoint> => {
        attempts.push(`${address}:${String(port)}`);
        if (shouldFail && address !== "127.0.0.1") throw new Error("EADDRINUSE");
        return Promise.resolve({ address, port, status: "listening", url: `http://${address}:${String(port)}` });
      },
      loopbackPort: 0,
    });

    try {
      expect(listeners.lanState()).toMatchObject({ status: "listening", address: "192.168.1.20" });
      expect(listeners.lan).toMatchObject({ address: "192.168.1.20", port: 43_130 });
      const loopback = listeners.loopback;
      shouldFail = true;
      const failed = await listeners.reconfigureLan({ address: "10.0.0.7", port: 43_131 });
      expect(failed).toMatchObject({ status: "listening", address: "192.168.1.20", pending: { reasonCode: "lan_bind_failed" } });
      expect(listeners.loopback).toEqual(loopback);
      shouldFail = false;
      await expect(listeners.reconfigureLan(undefined)).resolves.toMatchObject({ status: "disabled" });
      expect(listeners.lan).toBeUndefined();
      expect(attempts).toEqual(["127.0.0.1:0", "192.168.1.20:43130", "10.0.0.7:43131"]);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
