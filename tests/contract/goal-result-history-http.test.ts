import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import type { GoalResultDto, GoalResultPageDto } from "../../src/shared/goal-results.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

it("authenticates history reads, returns body-free pages and scopes full snapshots to the original visible goal", async () => {
  const fixture = await createRuntimeFixture();
  const listeners = await startRuntimeListeners({ handler: createApiHandler(fixture), loopbackPort: 0 });
  try {
    const workbench = await fixture.workbenchRegistry.create({ name: "History", personaSummary: "Synthetic", projectLabel: "History", scopeSummary: "Synthetic" });
    const inbox = new SqliteJoiInboxRepository(fixture.database, fixture.clock);
    const now = fixture.clock.now().toISOString();
    for (const goalId of ["goal with space", "other-goal"]) {
      await inbox.create({ inputId: goalId, idempotencyKey: goalId, body: "Synthetic goal title", status: "PENDING", createdAt: now, updatedAt: now });
      await inbox.createTurn({ inputId: goalId, turnId: `turn-${goalId}`, sessionId: "synthetic-session", workbenchId: workbench.workbenchId, createdAt: now });
      await inbox.completeInput(goalId, `turn-${goalId}`, { outcome: "DIRECT_ANSWER", completionSummary: `# Synthetic ${goalId} result`, committedByTool: true });
    }
    await inbox.create({ inputId: "empty-goal", idempotencyKey: "empty-goal", body: "No delivery yet", status: "PENDING", createdAt: now, updatedAt: now });
    fixture.database.transaction(db => db.prepare(`INSERT INTO joi_inbox_messages
      (input_id,idempotency_key,body,status,goal_input_id,created_at,updated_at)
      VALUES ('child','child','Synthetic internal message','PENDING','goal with space',?,?)`).run(now, now));
    const url = `${listeners.loopback.url}/api/v1/joi/goals/goal%20with%20space/results`;
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(`${url}/missing`)).status).toBe(401);
    const bootstrap = await fixture.auth.issueDesktopBootstrap();
    const session = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }),
    });
    const headers = { cookie: session.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    const page = await response.json() as GoalResultPageDto;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ status: "COMPLETED", completedAt: now });
    expect(page.items[0]).not.toHaveProperty("body");
    expect(JSON.stringify(page)).not.toContain("Synthetic goal with space result");
    const resultId = page.items[0]?.resultId ?? "missing";
    const snapshotResponse = await fetch(`${url}/${encodeURIComponent(resultId)}`, { headers });
    expect(snapshotResponse.status).toBe(200);
    expect(await snapshotResponse.json() as GoalResultDto).toMatchObject({ resultId, status: "COMPLETED", body: "# Synthetic goal with space result" });
    expect((await fetch(`${listeners.loopback.url}/api/v1/joi/goals/other-goal/results/${encodeURIComponent(resultId)}`, { headers })).status).toBe(404);
    expect((await fetch(`${url}/missing`, { headers })).status).toBe(404);
    for (const goalId of ["missing", "child"]) {
      expect((await fetch(`${listeners.loopback.url}/api/v1/joi/goals/${goalId}/results`, { headers })).status).toBe(404);
    }
    expect(await (await fetch(`${listeners.loopback.url}/api/v1/joi/goals/empty-goal/results`, { headers })).json()).toEqual({ items: [] });
    for (const query of ["limit=0", "limit=51", "limit=1.5", "limit=NaN", "cursor=invalid"]) {
      const invalid = await fetch(`${url}?${query}`, { headers });
      expect(invalid.status).toBe(400);
      expect(await invalid.text()).toContain("goal_result_page_invalid");
    }
    await inbox.archive("goal with space");
    expect((await fetch(url, { headers })).status).toBe(200);
    await inbox.dismiss("goal with space");
    expect((await fetch(url, { headers })).status).toBe(404);
    expect((await fetch(`${url}/${encodeURIComponent(resultId)}`, { headers })).status).toBe(404);
  } finally { await listeners.close(); await fixture.close(); }
});
