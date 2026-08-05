import { normalizeAgentConversationEntries } from "../../src/main/application/partners/agent-conversation-presentation.js";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import { SqliteAvatarAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-avatar-agent-repository.js";
import type { AgentConversationPageDto, AvatarAgentCardDto, JoiHomeFeedDto } from "../../src/shared/joi.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

describe("Avatar Agent HTTP API", () => {
  it("lists the home projection and safe Agent conversations with terminal delete guards", async () => {
    const fixture = await createRuntimeFixture();
    const avatar = await fixture.avatarRegistry.create({ name: "工程", personaSummary: "persona", projectLabel: "joi", scopeSummary: "首页" });
    const partner = await fixture.partners.add({ capabilities: [], displayName: "实现搭档", kind: "local-pi", skills: [], tools: [] });
    const resident = await fixture.instances.ensure({ avatarId: avatar.avatarId, partnerId: partner.partnerId, sessionPolicy: "RESIDENT" });
    const ephemeral = await fixture.instances.ensure({ avatarId: avatar.avatarId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
    fixture.database.transaction((connection) => connection.prepare(
      "UPDATE partner_instances SET status = 'DISPOSED', disposed_at = ?, disposal_reason = 'ephemeral_completed' WHERE instance_id = ?",
    ).run(fixture.clock.now().toISOString(), ephemeral.instanceId));
    const repository = new SqliteAvatarAgentRepository(fixture.database);
    await repository.append(ephemeral.instanceId, normalizeAgentConversationEntries({
      agentId: ephemeral.instanceId, runId: "run-http", startedAt: fixture.clock.now().toISOString(),
    }, [{ kind: "MARKDOWN", role: "AGENT", text: "完成 /home/private/result.md Bearer abcdefghijklmnop" }]));
    const listeners = await startRuntimeListeners({ handler: createApiHandler(fixture), loopbackPort: 0 });
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

      const agents = await fetch(`${listeners.loopback.url}/api/v1/avatars/${encodeURIComponent(avatar.avatarId)}/agents`, { headers });
      expect(agents.status).toBe(200);
      expect((await agents.json() as { items: AvatarAgentCardDto[] }).items).toHaveLength(2);

      const conversation = await fetch(`${listeners.loopback.url}/api/v1/avatars/${encodeURIComponent(avatar.avatarId)}/agents/${encodeURIComponent(ephemeral.instanceId)}/conversation`, { headers });
      expect(conversation.status).toBe(200);
      const page = await conversation.json() as AgentConversationPageDto;
      expect(page.items[0]?.text).toContain("[redacted-path]");
      expect(JSON.stringify(page)).not.toMatch(/\/home\/private|abcdefghijklmnop/u);

      const denied = await fetch(`${listeners.loopback.url}/api/v1/avatars/${encodeURIComponent(avatar.avatarId)}/agents/${encodeURIComponent(resident.instanceId)}`, { headers: writeHeaders, method: "DELETE" });
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({ code: "avatar_agent_resident_delete_forbidden" });

      const removed = await fetch(`${listeners.loopback.url}/api/v1/avatars/${encodeURIComponent(avatar.avatarId)}/agents/${encodeURIComponent(ephemeral.instanceId)}`, { headers: writeHeaders, method: "DELETE" });
      expect(removed.status).toBe(204);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
