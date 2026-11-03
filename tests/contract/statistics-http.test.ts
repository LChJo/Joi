import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { StatisticsService } from "../../src/main/application/statistics/statistics-service";
import { SqliteUsageStore } from "../../src/main/infrastructure/persistence/sqlite-usage-store";
import { createRuntimeFixture } from "../support/runtime-fixture";

it("requires authentication and returns bounded numeric statistics without private execution fields", async () => {
  const fixture = await createRuntimeFixture();
  const now = () => "2026-09-22T00:00:00.000Z";
  const statistics = new StatisticsService({ store: new SqliteUsageStore(fixture.database, now), now, id: () => "invocation" });
  const session = statistics.begin({ engine: "pi", purpose: "orchestration", modelId: "model" });
  session.record({ key: "response", tokens: { input: 10, output: 5, cacheRead: null, cacheWrite: null, reasoning: null } }); session.finish("completed");
  const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, statistics }), loopbackPort: 0 });
  try {
    const url = `${listeners.loopback.url}/api/v1/statistics?from=2026-09-22&to=2026-09-22&timeZone=UTC`;
    expect((await fetch(url)).status).toBe(401);
    const bootstrap = await fixture.auth.issueDesktopBootstrap();
    const auth = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }) });
    const headers = { cookie: auth.headers.get("set-cookie")?.split(";")[0] ?? "" };
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    const result = await response.json() as { overview: { total: number } };
    expect(result.overview.total).toBe(15);
    expect(JSON.stringify(result)).not.toContain("invocation");
    for (const suffix of ["&from=2020-01-01", "&purpose=bad", "&secret=value"]) expect((await fetch(url + suffix, { headers })).status).toBe(400);
    expect((await fetch(`${listeners.loopback.url}/api/v1/statistics`, { headers })).status).toBe(400);
  } finally { await listeners.close(); await fixture.close(); }
});
