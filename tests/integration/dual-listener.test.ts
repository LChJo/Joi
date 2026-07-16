import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { createRuntimeFixture } from "../support/runtime-fixture";

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
});
