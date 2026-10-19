import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

it("requires a session and returns only the original goal's safe detail, with paging validation and 404s", async () => {
  const fixture = await createRuntimeFixture();
  const listeners = await startRuntimeListeners({ handler: createApiHandler(fixture), loopbackPort: 0 });
  try {
    const now = fixture.clock.now().toISOString();
    fixture.database.transaction((db) => {
      const insert = db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,goal_input_id,created_at,updated_at) VALUES (?,?,?,'PENDING',?,?,?)`);
      insert.run("goal with space", "original", `${"Long fixture title ".repeat(15)}last requirement api_key=synthetic-private`, null, now, now);
      insert.run("child", "child", "child private message", "goal with space", now, now);
    });
    const url = `${listeners.loopback.url}/api/v1/joi/goals/goal%20with%20space/detail`;
    expect((await fetch(url)).status).toBe(401);
    const bootstrap = await fixture.auth.issueDesktopBootstrap();
    const session = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }),
    });
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const headers = { cookie };
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("last requirement api_key=[redacted]");
    expect(body).not.toContain("synthetic-private");
    expect(body).not.toContain("child private message");
    for (const query of ["offset=-1", "offset=0.5", "offset=NaN", "limit=101", "limit=0"]) {
      expect((await fetch(`${url}?${query}`, { headers })).status).toBe(400);
    }
    for (const id of ["missing", "child"]) expect((await fetch(`${listeners.loopback.url}/api/v1/joi/goals/${id}/detail`, { headers })).status).toBe(404);
  } finally { await listeners.close(); await fixture.close(); }
});
