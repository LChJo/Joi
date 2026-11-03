import { normalizeAgentConversationEntries } from "../../src/main/application/partners/agent-conversation-presentation.js";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import type { AgentConversationPageDto, WorkbenchAgentCardDto, WorkbenchToolTraceDto, JoiHomeFeedDto } from "../../src/shared/joi.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

describe("Workbench Agent HTTP API", () => {
  it("lists the home projection and safe Agent conversations with terminal delete guards", async () => {
    const fixture = await createRuntimeFixture();
    const workbench = await fixture.workbenchRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "首页" });
    const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
    const resident = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
    const ephemeral = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
    fixture.database.transaction((connection) => connection.prepare(
      "UPDATE partner_instances SET status = 'DISPOSED', disposed_at = ?, disposal_reason = 'ephemeral_completed' WHERE instance_id = ?",
    ).run(fixture.clock.now().toISOString(), ephemeral.instanceId));
    const repository = new SqliteWorkbenchAgentRepository(fixture.database);
    await repository.append(ephemeral.instanceId, normalizeAgentConversationEntries({
      agentId: ephemeral.instanceId, runId: "run-http", startedAt: fixture.clock.now().toISOString(),
    }, [{ kind: "MARKDOWN", role: "AGENT", text: "完成 /home/private/nested/deep/result.md Bearer abcdefghijklmnop" }]));
    const openArtifact = vi.fn(() => Promise.resolve({ opened: true as const }));
    const workbenchAgents = {
      conversation: fixture.workbenchAgents.conversation.bind(fixture.workbenchAgents),
      dismiss: fixture.workbenchAgents.dismiss.bind(fixture.workbenchAgents),
      list: fixture.workbenchAgents.list.bind(fixture.workbenchAgents),
      openArtifact,
      revealToolTrace: fixture.workbenchAgents.revealToolTrace.bind(fixture.workbenchAgents),
    };
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, workbenchAgents }), loopbackPort: 0 });
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }), headers: { "content-type": "application/json", origin: "null" }, method: "POST",
      });
      const { csrfToken } = await authenticated.json() as { csrfToken: string };
      const headers = { cookie: cookieFrom(authenticated), origin: "null" };
      const writeHeaders = { ...headers, "content-type": "application/json", "x-csrf-token": csrfToken };

      const feed = await fetch(`${listeners.loopback.url}/api/v1/joi/home-feed`, { headers });
      expect(feed.status).toBe(200);
      expect(await feed.json() as JoiHomeFeedDto).toMatchObject({ goals: [], thinking: [], unassignedActions: [] });

      const agents = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/agents`, { headers });
      expect(agents.status).toBe(200);
      expect((await agents.json() as { items: WorkbenchAgentCardDto[] }).items).toHaveLength(2);

      const conversation = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/agents/${encodeURIComponent(ephemeral.instanceId)}/conversation`, { headers });
      expect(conversation.status).toBe(200);
      const page = await conversation.json() as AgentConversationPageDto;
      expect(page.items[0]?.text).toContain("/…/nested/deep/result.md");
      expect(JSON.stringify(page)).not.toMatch(/\/home\/private|abcdefghijklmnop/u);

      await repository.append(ephemeral.instanceId, normalizeAgentConversationEntries({
        agentId: ephemeral.instanceId, runId: "run-newer", startedAt: fixture.clock.now().toISOString(),
      }, [{ kind: "MARKDOWN", role: "AGENT", text: "newest" }]));
      const endpoint = `${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/agents/${encodeURIComponent(ephemeral.instanceId)}/conversation`;
      const latest = await (await fetch(`${endpoint}?latest=true&limit=1`, { headers })).json() as AgentConversationPageDto;
      expect(latest.items.map(item => item.text)).toEqual(["newest"]);
      const older = await (await fetch(`${endpoint}?latest=true&limit=1&cursor=${encodeURIComponent(latest.nextCursor ?? "")}`, { headers })).json() as AgentConversationPageDto;
      expect(older.items[0]?.entryId).toBe(page.items[0]?.entryId);
      expect(older.nextCursor).toBeUndefined();
      expect((await fetch(`${endpoint}?latest=true&cursor=invalid`, { headers })).status).toBe(400);
      expect((await fetch(`${endpoint}?latest=true&goalId=unrelated`, { headers })).status).toBe(404);

      const opened = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/artifacts/${encodeURIComponent("entry-artifact")}/open`, {
        body: JSON.stringify({ mode: "OPEN", source: "AGENT", sourceId: ephemeral.instanceId }), headers: writeHeaders, method: "POST",
      });
      expect(opened.status).toBe(200);
      expect(await opened.json()).toEqual({ opened: true });
      expect(openArtifact).toHaveBeenCalledWith({
        artifactId: "entry-artifact", mode: "OPEN", source: "AGENT", sourceId: ephemeral.instanceId, workbenchId: workbench.workbenchId,
      });
      const folderOpened = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/artifacts/${encodeURIComponent("entry-artifact")}/open`, {
        body: JSON.stringify({ mode: "OPEN_FOLDER", source: "AGENT", sourceId: ephemeral.instanceId }), headers: writeHeaders, method: "POST",
      });
      expect(folderOpened.status).toBe(200);
      expect(openArtifact).toHaveBeenLastCalledWith({
        artifactId: "entry-artifact", mode: "OPEN_FOLDER", source: "AGENT", sourceId: ephemeral.instanceId, workbenchId: workbench.workbenchId,
      });

      const invalidMode = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/artifacts/${encodeURIComponent("entry-artifact")}/open`, {
        body: JSON.stringify({ mode: "DELETE", source: "AGENT", sourceId: ephemeral.instanceId }), headers: writeHeaders, method: "POST",
      });
      expect(invalidMode.status).toBe(400);

      await fetch(`${listeners.loopback.url}/api/v1/auth/setup`, {
        body: JSON.stringify({ password: "correct horse battery staple" }), headers: writeHeaders, method: "POST",
      });
      const login = await fetch(`${listeners.loopback.url}/api/v1/auth/login`, {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: { "content-type": "application/json", origin: listeners.loopback.url }, method: "POST",
      });
      const lanGrant = await login.json() as { csrfToken: string };
      const lanHeaders = {
        "content-type": "application/json", cookie: cookieFrom(login), origin: listeners.loopback.url, "x-csrf-token": lanGrant.csrfToken,
      };
      const lanDenied = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/artifacts/${encodeURIComponent("entry-artifact")}/open`, {
        body: JSON.stringify({ mode: "OPEN", source: "AGENT", sourceId: ephemeral.instanceId }), headers: lanHeaders, method: "POST",
      });
      expect(lanDenied.status).toBe(403);
      expect(await lanDenied.json()).toMatchObject({ code: "desktop_required" });
      const callsBeforeFolderAttempt = openArtifact.mock.calls.length;
      const lanFolderDenied = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/artifacts/${encodeURIComponent("entry-artifact")}/open`, {
        body: JSON.stringify({ mode: "OPEN_FOLDER", source: "AGENT", sourceId: ephemeral.instanceId }), headers: lanHeaders, method: "POST",
      });
      expect(lanFolderDenied.status).toBe(403);
      expect(openArtifact.mock.calls).toHaveLength(callsBeforeFolderAttempt);

      const denied = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/agents/${encodeURIComponent(resident.instanceId)}`, { headers: writeHeaders, method: "DELETE" });
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ code: "workbench_agent_resident_delete_forbidden" });

      const removed = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/agents/${encodeURIComponent(ephemeral.instanceId)}`, { headers: writeHeaders, method: "DELETE" });
      expect(removed.status).toBe(204);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("keeps tool bodies off the conversation and returns them only through the desktop reveal", async () => {
    const fixture = await createRuntimeFixture();
    const workbench = await fixture.workbenchRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "调试" });
    const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
    const instance = await fixture.instances.ensure({ workbenchId: workbench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
    const repository = new SqliteWorkbenchAgentRepository(fixture.database);
    const runId = "run-trace-http";
    await repository.replaceRun(instance.instanceId, runId, normalizeAgentConversationEntries({
      agentId: instance.instanceId, runId, startedAt: fixture.clock.now().toISOString(),
    }, [
      { kind: "TOOL_CALL", role: "TOOL", text: "npm test", toolCallId: "toolu_http", toolName: "bash" },
      { kind: "TOOL_RESULT", role: "TOOL", text: "执行完成", toolCallId: "toolu_http", toolName: "bash" },
    ]));
    await repository.appendToolTrace({
      agentId: instance.instanceId, createdAt: fixture.clock.now().toISOString(), runId,
      trace: { command: "cd /home/private/repo && npm test", isError: false, result: "42 passing", toolCallId: "toolu_http", toolName: "bash", truncated: false },
    });
    const workbenchAgents = {
      conversation: fixture.workbenchAgents.conversation.bind(fixture.workbenchAgents),
      dismiss: fixture.workbenchAgents.dismiss.bind(fixture.workbenchAgents),
      list: fixture.workbenchAgents.list.bind(fixture.workbenchAgents),
      openArtifact: vi.fn(() => Promise.resolve({ opened: true as const })),
      revealToolTrace: fixture.workbenchAgents.revealToolTrace.bind(fixture.workbenchAgents),
    };
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, workbenchAgents }), loopbackPort: 0 });
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }), headers: { "content-type": "application/json", origin: "null" }, method: "POST",
      });
      const { csrfToken } = await authenticated.json() as { csrfToken: string };
      const headers = { cookie: cookieFrom(authenticated), origin: "null" };
      const writeHeaders = { ...headers, "content-type": "application/json", "x-csrf-token": csrfToken };
      const base = `${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent(workbench.workbenchId)}/agents/${encodeURIComponent(instance.instanceId)}`;

      // The shared projection carries the summary and the opaque id, never the body.
      const page = await (await fetch(`${base}/conversation`, { headers })).json() as AgentConversationPageDto;
      expect(page.items[0]).toMatchObject({ kind: "TOOL_CALL", text: "npm test", toolCallId: "toolu_http" });
      expect(JSON.stringify(page)).not.toMatch(/\/home\/private|42 passing/u);

      const reveal = await fetch(`${base}/tool-traces/toolu_http/reveal`, { headers: writeHeaders, method: "POST" });
      expect(reveal.status).toBe(200);
      expect(reveal.headers.get("cache-control")).toBe("no-store");
      const revealed = await reveal.json() as WorkbenchToolTraceDto;
      expect(revealed.command).toContain("/home/private/repo");
      expect(revealed).toMatchObject({ isError: false, result: "42 passing", toolCallId: "toolu_http", toolName: "bash", truncated: false });

      expect((await fetch(`${base}/tool-traces/toolu_missing/reveal`, { headers: writeHeaders, method: "POST" })).status).toBe(404);
      const foreign = await fetch(`${listeners.loopback.url}/api/v1/workbenches/${encodeURIComponent("workbench_elsewhere")}/agents/${encodeURIComponent(instance.instanceId)}/tool-traces/toolu_http/reveal`, { headers: writeHeaders, method: "POST" });
      expect(foreign.status).toBe(404);

      await fetch(`${listeners.loopback.url}/api/v1/auth/setup`, {
        body: JSON.stringify({ password: "correct horse battery staple" }), headers: writeHeaders, method: "POST",
      });
      const login = await fetch(`${listeners.loopback.url}/api/v1/auth/login`, {
        body: JSON.stringify({ password: "correct horse battery staple" }),
        headers: { "content-type": "application/json", origin: listeners.loopback.url }, method: "POST",
      });
      const lanGrant = await login.json() as { csrfToken: string };
      const lanDenied = await fetch(`${base}/tool-traces/toolu_http/reveal`, {
        headers: { "content-type": "application/json", cookie: cookieFrom(login), origin: listeners.loopback.url, "x-csrf-token": lanGrant.csrfToken },
        method: "POST",
      });
      expect(lanDenied.status).toBe(403);
      expect(await lanDenied.json()).toMatchObject({ code: "desktop_required" });
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
