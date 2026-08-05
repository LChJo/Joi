import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import type { AvatarDetailDto, AvatarWorkspaceDto } from "../../src/shared/joi.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

describe("Avatar context HTTP API", () => {
  it("returns only safe context metadata and scopes workspace management to the Avatar", async () => {
    const fixture = await createRuntimeFixture();
    const avatar = await fixture.avatarRegistry.create({
      name: "文档 Avatar",
      personaSummary: "PRIVATE_PERSONA_BODY",
      projectLabel: "文档工程",
      scopeSummary: "维护发布文档",
    });
    const partner = await fixture.partners.add({ capabilities: [], displayName: "写作者", kind: "local-pi", skills: [], tools: [] });
    await fixture.instances.ensure({ avatarId: avatar.avatarId, partnerId: partner.partnerId });
    const listeners = await startRuntimeListeners({ handler: createApiHandler(fixture), loopbackPort: 0 });
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const { csrfToken } = await authenticated.json() as { csrfToken: string };
      const headers = { "content-type": "application/json", cookie: cookieFrom(authenticated), origin: "null", "x-csrf-token": csrfToken };
      const detailUrl = `${listeners.loopback.url}/api/v1/avatars/${encodeURIComponent(avatar.avatarId)}`;

      const initial = await fetch(detailUrl, { headers });
      expect(initial.status).toBe(200);
      const initialDetail = await initial.json() as AvatarDetailDto;
      expect(initialDetail).toMatchObject({
        avatarId: avatar.avatarId,
        instances: [expect.objectContaining({ partnerId: partner.partnerId })],
        workspace: { kind: "MANAGED", status: "PROVISIONING" },
      });
      expect(JSON.stringify(initialDetail)).not.toContain("PRIVATE_PERSONA_BODY");
      expect(initialDetail.workspace).not.toHaveProperty("workspaceRef");

      const updated = await fetch(detailUrl, {
        body: JSON.stringify({ name: "发布 Avatar", persona: "NEW_PRIVATE_PERSONA", projectLabel: "发布工程", responsibility: "维护发布流水线" }),
        headers,
        method: "PATCH",
      });
      expect(updated.status).toBe(200);
      const updatedDetail = await updated.json() as AvatarDetailDto;
      expect(updatedDetail).toMatchObject({ name: "发布 Avatar", projectLabel: "发布工程", responsibility: "维护发布流水线" });
      expect(updatedDetail.personaRevisionId).not.toBe(initialDetail.personaRevisionId);
      expect(JSON.stringify(updatedDetail)).not.toContain("NEW_PRIVATE_PERSONA");

      const bound = await fetch(`${detailUrl}/workspace/bind`, { headers, method: "POST" });
      expect(bound.status).toBe(200);
      const workspace = await bound.json() as AvatarWorkspaceDto;
      expect(workspace).toEqual({ displayName: "workdir", kind: "BOUND", status: "READY" });
      expect(JSON.stringify(workspace)).not.toContain("/stub/workdir");
      expect(workspace).not.toHaveProperty("workspaceRef");
      expect(fixture.database.transaction((connection) => connection.prepare(
        "SELECT root_path FROM avatar_workspace_roots WHERE workspace_ref = ?",
      ).get(`avatar_workspace:${avatar.avatarId}`))).toEqual({ root_path: "/stub/workdir" });

      fixture.database.transaction((connection) => {
        const now = fixture.clock.now().toISOString();
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, avatar_id, created_at, updated_at)
          VALUES ('input-busy', 'key-busy', '正在写文件', 'ROUTED', ?, ?, ?)`).run(avatar.avatarId, now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, avatar_id, session_id, status, created_at, updated_at)
          VALUES ('turn-busy', 'input-busy', ?, 'session-busy', 'RUNNING', ?, ?)`).run(avatar.avatarId, now, now);
        connection.prepare(`INSERT INTO work_items
          (work_id, avatar_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('work-busy', ?, 'input-busy', '正在写文件', '{}', 'READ', 'RUNNING', ?, ?)`).run(avatar.avatarId, now, now);
        connection.prepare("INSERT INTO work_access_policies (work_id, access_mode) VALUES ('work-busy', 'READ')").run();
      });
      const rejected = await fetch(`${detailUrl}/workspace/rebuild`, { headers, method: "POST" });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: "avatar_workspace_busy" });
      const refreshed = await fetch(detailUrl, { headers });
      expect((await refreshed.json() as AvatarDetailDto).activeWork).toEqual([
        expect.objectContaining({ status: "RUNNING", workId: "work-busy" }),
      ]);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
