import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";
import type { GoalArtifactPageDto } from "../../src/shared/goal-artifacts.js";

it("authenticates bounded artifact reads and rejects invalid, cross-goal and dismissed cursors", async () => {
  const fixture = await createGoalEvidenceFixture([{}]);
  fixture.database.transaction(db => db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(JSON.stringify(
    Array.from({ length: 25 }, (_, i) => ({ artifactRef: `workspace:out/part-${String(i).padStart(2, "0")}/file.md`, name: `file-${String(i)}.md`, mimeType: "text/markdown", size: 100 })),
  )));
  const listeners = await startRuntimeListeners({ handler: createApiHandler(fixture), loopbackPort: 0 });
  try {
    const url = `${listeners.loopback.url}/api/v1/joi/goals/goal/artifacts`;
    expect((await fetch(url)).status).toBe(401);
    const nonce = await fixture.auth.issueDesktopBootstrap();
    const session = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: nonce.nonce }),
    });
    const headers = { cookie: session.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
    const page = await (await fetch(url, { headers })).json() as GoalArtifactPageDto;
    expect(page.items).toHaveLength(20);
    expect(JSON.stringify(page)).not.toContain("workspace:");
    const more = await (await fetch(`${url}?cursor=${encodeURIComponent(page.nextCursor ?? "")}`, { headers })).json() as GoalArtifactPageDto;
    expect(more.items).toHaveLength(5);
    expect(more.nextCursor).toBeUndefined();
    expect((await fetch(`${url}?limit=101`, { headers })).status).toBe(400);
    expect((await fetch(`${url}?cursor=work_result_artifact:other:0`, { headers })).status).toBe(400);
    expect((await fetch(url.replace("/goal/", "/missing/"), { headers })).status).toBe(404);
    fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET archived_at=? WHERE input_id='goal'").run(fixture.clock.now().toISOString()));
    expect((await fetch(url, { headers })).status).toBe(200);
    fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET dismissed_at=? WHERE input_id='goal'").run(fixture.clock.now().toISOString()));
    expect((await fetch(url, { headers })).status).toBe(404);
  } finally { await listeners.close(); await fixture.close(); }
});
