import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { createRuntimeFixture } from "../support/runtime-fixture";

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

describe("HTTP API v1", () => {
  it("keeps legacy Life HTTP resources read-only", async () => {
    const fixture = await createRuntimeFixture();
    const listeners = await startRuntimeListeners({ handler: createApiHandler(fixture), loopbackPort: 0 });
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const cookie = cookieFrom(authenticated);
      const { csrfToken } = await authenticated.json() as { csrfToken: string };
      const write = await fetch(`${listeners.loopback.url}/api/v1/lives`, {
        body: JSON.stringify({ name: "legacy write" }),
        headers: { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": csrfToken },
        method: "POST",
      });
      expect(write.status).toBe(410);
      expect(await write.json()).toMatchObject({ code: "legacy_life_read_only" });
      expect((await fetch(`${listeners.loopback.url}/api/v1/lives`, { headers: { cookie } })).status).toBe(200);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("retires the SSE stream endpoint with 404 (ADR 0009)", async () => {
    const fixture = await createRuntimeFixture();
    const handler = createApiHandler(fixture);
    const listeners = await startRuntimeListeners({ handler, loopbackPort: 0 });

    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const sessionResponse = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const cookie = cookieFrom(sessionResponse);
      const missing = await fetch(`${listeners.loopback.url}/api/v1/stream`, { headers: { cookie } });
      expect(missing.status).toBe(404);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
