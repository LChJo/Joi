import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { EvolutionService } from "../../src/main/application/evolution/evolution-service";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { createRuntimeFixture } from "../support/runtime-fixture";

it("authenticates evolution settings, validates limits and exposes only safe state", async () => {
  const fixture = await createRuntimeFixture();
  fixture.database.transaction((db) => db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('a','A','p','private persona','','','m','ACTIVE','2026-09-22','2026-09-22')`).run());
  const evolution = new EvolutionService({ store: new SqliteEvolutionStore(fixture.database), model: { pin: vi.fn(), call: vi.fn() }, now: () => "2026-09-22T00:00:00Z", id: () => "id" });
  const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, evolution }), loopbackPort: 0 });
  try {
    const url = `${listeners.loopback.url}/api/v1/workbenches/a/evolution`;
    expect((await fetch(url)).status).toBe(401);
    const bootstrap = await fixture.auth.issueDesktopBootstrap();
    const auth = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }) });
    const cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrfToken } = await auth.json() as { csrfToken: string };
    const headers = { cookie, origin: listeners.loopback.url, "content-type": "application/json", "x-csrf-token": csrfToken };
    expect((await fetch(url, { headers })).status).toBe(200);
    expect((await fetch(url, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ dailyCallLimit: 3 }) })).status).toBe(403);
    expect((await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ dailyCallLimit: -1 }) })).status).toBe(400);
    expect((await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ dailyCallLimit: "3" }) })).status).toBe(400);
    const saved = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ dailyCallLimit: 3 }) });
    expect(saved.status).toBe(200);
    const state: unknown = await saved.json();
    expect(state).toMatchObject({ dailyCallLimit: 3, callsUsedToday: 0, versions: [] });
    expect(JSON.stringify(state)).not.toContain("private");
  } finally { await listeners.close(); await fixture.close(); }
});
