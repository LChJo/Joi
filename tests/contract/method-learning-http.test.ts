import { MethodLearningService } from "../../src/main/application/evolution/method-learning-service";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { SqliteMethodLearningStore } from "../../src/main/infrastructure/persistence/sqlite-method-learning-store";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import type { EvolutionLearningDto } from "../../src/shared/evolution";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("production method learning HTTP settings", () => {
  let fixture: RuntimeFixture;
  let store: SqliteMethodLearningStore;
  let service: MethodLearningService;
  let listeners: Awaited<ReturnType<typeof startRuntimeListeners>>;
  let headers: Record<string, string>;
  const call = vi.fn();
  const pin = vi.fn();
  const routes = [
    { path: "/api/v1/evolution", method: "PATCH", body: { enabled: true, dailyCallLimit: 150 } },
    { path: "/api/v1/evolution/resume", method: "POST" },
    { path: "/api/v1/workbenches/a/evolution", method: "PATCH", body: { enabled: true } },
    { path: "/api/v1/workbenches/a/evolution/resume", method: "POST" },
  ];
  beforeEach(async () => {
    fixture = await createRuntimeFixture();
    fixture.database.transaction(db => {
      db.prepare(`INSERT INTO workbenches
        (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES ('a','A','persona','private-persona-sentinel','','','memory','ACTIVE','2026-10-23','2026-10-23')`).run();
      db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES ('goal','goal','private-message-sentinel','CONSUMED','a','2026-10-23','2026-10-23')`).run();
    });
    store = new SqliteMethodLearningStore(fixture.database);
    store.configureGlobal({ enabled: true, dailyCallLimit: 150, paused: true });
    store.configureParticipant("a", { enabled: true, dailyCallLimit: 50, paused: true });
    call.mockReset();
    pin.mockReset();
    service = new MethodLearningService({ store, legacyStore: new SqliteEvolutionStore(fixture.database), model: { call, pin },
      now: () => "2026-10-23T01:00:00.000Z", id: () => "method-http" });
    listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, evolution: service }), loopbackPort: 0 });
    const bootstrap = await fixture.auth.issueDesktopBootstrap();
    const response = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const grant = await response.json() as { csrfToken: string };
    headers = { cookie, origin: listeners.loopback.url, "content-type": "application/json", "x-csrf-token": grant.csrfToken };
  });
  afterEach(async () => { await listeners.close(); await fixture.close(); });
  const request = (path: string, method = "GET", body?: unknown, requestHeaders = headers) => fetch(`${listeners.loopback.url}${path}`, {
    method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  async function safeLearning(response: Response): Promise<EvolutionLearningDto> {
    expect(response.status).toBe(200);
    const dto = await response.json() as { learning: EvolutionLearningDto };
    expect(Object.keys(dto.learning).sort()).toEqual([
      "appliedGoals", "blockers", "cases", "evaluatorVersion", "experiment", "globalBudget", "methods", "participation", "stage", "version",
    ]);
    expect(dto.learning.version).toBe(2);
    expect(JSON.stringify(dto)).not.toContain("private-persona-sentinel");
    expect(JSON.stringify(dto)).not.toContain("private-message-sentinel");
    return dto.learning;
  }
  it("requires a session for reads and session plus CSRF and origin for every mutation", async () => {
    for (const path of ["/api/v1/evolution", "/api/v1/workbenches/a/evolution"]) {
      expect((await request(path, "GET", undefined, {})).status).toBe(401);
      await safeLearning(await request(path));
    }
    for (const route of routes) {
      expect((await request(route.path, route.method, route.body, {})).status).toBe(401);
      expect((await request(route.path, route.method, route.body, { cookie: headers.cookie ?? "", "content-type": "application/json" })).status).toBe(403);
      expect((await request(route.path, route.method, route.body, { ...headers, origin: "https://untrusted.invalid" })).status).toBe(403);
    }
  });
  it("validates global controls, accepts zero, and never resumes implicitly", async () => {
    for (const body of [{}, { enabled: "true" }, { enabled: true, unexpected: true }, { dailyCallLimit: -1 },
      { dailyCallLimit: "150" }, { dailyCallLimit: 1.5 }, { dailyCallLimit: 10_001 }, { paused: false }]) {
      expect((await request("/api/v1/evolution", "PATCH", body)).status).toBe(400);
    }
    const changed = await safeLearning(await request("/api/v1/evolution", "PATCH", { enabled: false, dailyCallLimit: 400 }));
    expect(changed.globalBudget).toMatchObject({ enabled: false, paused: true, dailyCallLimit: 400 });
    expect(store.participant("a")).toMatchObject({ enabled: true, paused: true, dailyCallLimit: 50 });
    expect((await request("/api/v1/evolution/resume", "POST")).status).toBe(400);
    const zero = await safeLearning(await request("/api/v1/evolution", "PATCH", { enabled: true, dailyCallLimit: 0 }));
    expect(zero.globalBudget).toMatchObject({ paused: true, dailyCallLimit: 0 });
    expect(zero.blockers).toContain("disabled");
    expect(store.control().paused).toBe(true);
    expect(service.pending()).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });
  it("changes participation separately and explicitly resumes only the requested scope", async () => {
    const changed = await safeLearning(await request("/api/v1/workbenches/a/evolution", "PATCH", { enabled: false }));
    expect(changed.participation).toEqual({ enabled: false, paused: true });
    expect(store.control().paused).toBe(true);
    expect((await request("/api/v1/workbenches/a/evolution/resume", "POST")).status).toBe(400);
    await safeLearning(await request("/api/v1/workbenches/a/evolution", "PATCH", { enabled: true }));
    expect(store.participant("a").paused).toBe(true);
    const local = await safeLearning(await request("/api/v1/workbenches/a/evolution/resume", "POST"));
    expect(local.participation).toEqual({ enabled: true, paused: false });
    expect(store.control().paused).toBe(true);
    expect(store.participant("a").dailyCallLimit).toBe(50);
    store.configureParticipant("a", { paused: true });
    const global = await safeLearning(await request("/api/v1/evolution/resume", "POST"));
    expect(global.globalBudget).toMatchObject({ enabled: true, paused: false, dailyCallLimit: 150 });
    expect(store.participant("a").paused).toBe(true);
    for (const body of [{ enabled: "false" }, { enabled: true, unexpected: 1 }, { enabled: true, paused: false }]) {
      expect((await request("/api/v1/workbenches/a/evolution", "PATCH", body)).status).toBe(400);
    }
    expect((await request("/api/v1/workbenches/missing/evolution", "PATCH", { enabled: true })).status).toBe(404);
    expect((await request("/api/v1/workbenches/missing/evolution/resume", "POST")).status).toBe(404);
  });
  it("reports missing reproducible cases and does not spend calls after both scopes resume", async () => {
    await safeLearning(await request("/api/v1/evolution/resume", "POST"));
    await safeLearning(await request("/api/v1/workbenches/a/evolution/resume", "POST"));
    const state = await safeLearning(await request("/api/v1/workbenches/a/evolution/run-now", "POST"));
    expect(state.blockers).toContain("no_reproducible_case");
    expect(state.experiment).toBeNull();
    expect(state.globalBudget.callsUsedToday).toBe(0);
    service.scan();
    expect(service.pending()).toEqual([]);
    expect(call).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
    expect(store.usage("2026-10-23").calls).toBe(0);
  });
});
