import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { EvolutionService } from "../../src/main/application/evolution/evolution-service";
import { EvolutionDryRun } from "../../src/main/application/evolution/evolution-dry-run";
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
    const overview = await fetch(`${listeners.loopback.url}/api/v1/evolution`, { headers });
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ workbenches: 1, enabled: 0, active: 0, batches: [] });
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

it("dry-runs a batch over HTTP without reaching a provider or the live service", async () => {
  const fixture = await createRuntimeFixture();
  fixture.database.transaction((db) => db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('a','A','p','private persona','','','m','ACTIVE','2026-09-22','2026-09-22')`).run());
  const pin = vi.fn();
  const call = vi.fn();
  const evolution = new EvolutionService({ store: new SqliteEvolutionStore(fixture.database), model: { pin, call }, now: () => "2026-09-22T00:00:00Z", id: () => "id" });
  const evolutionDryRun = new EvolutionDryRun({ now: () => "2026-09-24T00:00:00.000Z", id: () => "dry-run" });
  const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, evolution, evolutionDryRun }), loopbackPort: 0 });
  try {
    const url = `${listeners.loopback.url}/api/v1/workbenches/a/evolution/dry-run`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    const bootstrap = await fixture.auth.issueDesktopBootstrap();
    const auth = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }) });
    const cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrfToken } = await auth.json() as { csrfToken: string };
    const headers = { cookie, origin: listeners.loopback.url, "content-type": "application/json", "x-csrf-token": csrfToken };
    // A dry run mutates nothing but still has to be as hard to trigger cross-site as any other write.
    expect((await fetch(url, { method: "POST", headers: { cookie, "content-type": "application/json" } })).status).toBe(403);
    expect((await fetch(`${listeners.loopback.url}/api/v1/workbenches/missing/evolution/dry-run`, { method: "POST", headers })).status).toBe(404);
    const response = await fetch(url, { method: "POST", headers });
    expect(response.status).toBe(200);
    const report = await response.json() as unknown;
    expect(report).toMatchObject({ outcome: "promoted", promoted: true, steps: 721, truncated: false, selfCheck: { matched: true } });
    expect(JSON.stringify(report)).not.toContain("private");
    expect(JSON.stringify(report)).not.toContain("record-");
    // The point of routing this through the real service is that it tells us nothing about the live
    // one: it never received a call, and the workbench state it reports on is untouched.
    expect(pin).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(new SqliteEvolutionStore(fixture.database).read("a")).toMatchObject({ callSequence: 0, batch: null, usage: {} });
  } finally { await listeners.close(); await fixture.close(); }
});

it("queues a run-now request through the same auth surface as every other write", async () => {
  const fixture = await createRuntimeFixture();
  fixture.database.transaction((db) => db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('a','A','p','private persona','','','m','ACTIVE','2026-09-22','2026-09-22')`).run());
  const evolution = new EvolutionService({ store: new SqliteEvolutionStore(fixture.database), model: { pin: vi.fn(), call: vi.fn() }, now: () => "2026-09-22T00:00:00Z", id: () => "id" });
  const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, evolution }), loopbackPort: 0 });
  try {
    const url = `${listeners.loopback.url}/api/v1/workbenches/a/evolution/run-now`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    const bootstrap = await fixture.auth.issueDesktopBootstrap();
    const auth = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, { method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }) });
    const cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
    const { csrfToken } = await auth.json() as { csrfToken: string };
    const headers = { cookie, origin: listeners.loopback.url, "content-type": "application/json", "x-csrf-token": csrfToken };
    expect((await fetch(url, { method: "POST", headers: { cookie, "content-type": "application/json" } })).status).toBe(403);
    expect((await fetch(`${listeners.loopback.url}/api/v1/workbenches/missing/evolution/run-now`, { method: "POST", headers })).status).toBe(404);
    await fetch(`${listeners.loopback.url}/api/v1/workbenches/a/evolution`, { method: "PATCH", headers, body: JSON.stringify({ dailyCallLimit: 50 }) });
    const response = await fetch(url, { method: "POST", headers });
    expect(response.status).toBe(200);
    const state: unknown = await response.json();
    expect(state).toMatchObject({ runRequestedAt: "2026-09-22T00:00:00Z" });
    expect(JSON.stringify(state)).not.toContain("private");
    // A disabled workbench refuses the request with a domain error instead of queueing a dead one.
    await fetch(`${listeners.loopback.url}/api/v1/workbenches/a/evolution`, { method: "PATCH", headers, body: JSON.stringify({ dailyCallLimit: 0 }) });
    expect((await fetch(url, { method: "POST", headers })).status).toBe(400);
  } finally { await listeners.close(); await fixture.close(); }
});
