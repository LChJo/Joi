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

  it("opens a fresh SSE stream without a cursor and rejects unauthenticated streams with 401", async () => {
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

      const unauth = await fetch(`${listeners.loopback.url}/api/v1/stream`);
      expect(unauth.status).toBe(401);

      const controller = new AbortController();
      const fresh = await fetch(`${listeners.loopback.url}/api/v1/stream`, { headers: { cookie }, signal: controller.signal });
      expect(fresh.status).toBe(200);
      expect(fresh.headers.get("content-type")).toContain("text/event-stream");
      controller.abort();
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("replays SSE from an opaque cursor", async () => {
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
      await fixture.database.store.appendSseEvent({ entityId: "life_test", payload: { state: "STOPPED" }, type: "life.state.changed" });
      const controller = new AbortController();
      const response = await fetch(`${listeners.loopback.url}/api/v1/stream?cursor=sse_MA`, {
        headers: { cookie },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("missing SSE stream");
      const chunk = await reader.read();
      controller.abort();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("event: life.state.changed");
      expect(text).toMatch(/id: sse_[A-Za-z0-9_-]+/);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("prunes SSE projections older than seven days and resets an expired cursor", async () => {
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
      fixture.database.transaction((database) => {
        database.prepare(`INSERT INTO sse_events (event_type, entity_id, payload_json, created_at) VALUES ('old.1', 'runtime', '{}', '2026-07-01T00:00:00.000Z')`).run();
        database.prepare(`INSERT INTO sse_events (event_type, entity_id, payload_json, created_at) VALUES ('old.2', 'runtime', '{}', '2026-07-02T00:00:00.000Z')`).run();
      });
      await fixture.database.store.appendSseEvent({ entityId: "runtime", payload: {}, type: "current" });

      const controller = new AbortController();
      const response = await fetch(`${listeners.loopback.url}/api/v1/stream?cursor=sse_MQ`, { headers: { cookie }, signal: controller.signal });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("missing SSE stream");
      const chunk = await reader.read();
      controller.abort();
      const text = new TextDecoder().decode(chunk.value);
      expect(text).toContain("event: stream_reset");
      expect(text).toContain('"snapshotRequired":true');
      expect(await fixture.database.store.listSseEvents(0, 100)).toEqual([
        expect.objectContaining({ type: "current" }),
      ]);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
