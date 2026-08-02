import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import type { PartnerDto, PartnerKnowledgeDocDto } from "../../src/shared/joi";
import { createRuntimeFixture } from "../support/runtime-fixture";

function cookieFrom(response: Response) {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

async function createSession() {
  const fixture = await createRuntimeFixture();
  const listeners = await startRuntimeListeners({ handler: createApiHandler(fixture), loopbackPort: 0 });
  const bootstrap = await fixture.auth.issueDesktopBootstrap();
  const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
    body: JSON.stringify({ nonce: bootstrap.nonce }),
    headers: { "content-type": "application/json", origin: "null" },
    method: "POST",
  });
  const cookie = cookieFrom(authenticated);
  const { csrfToken } = await authenticated.json() as { csrfToken: string };
  return {
    async close() {
      await listeners.close();
      await fixture.close();
    },
    headers: { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": csrfToken },
    url: listeners.loopback.url,
  };
}

describe("partner config HTTP API", () => {
  it("lists per-engine skills and forbids the old absolute-path picker response", async () => {
    const session = await createSession();
    try {
      const skills = await fetch(`${session.url}/api/v1/engines/pi-core/skills`, { headers: session.headers });
      expect(skills.status).toBe(200);
      expect(Array.isArray((await skills.json() as { items: unknown[] }).items)).toBe(true);
      const badEngine = await fetch(`${session.url}/api/v1/engines/bogus/skills`, { headers: session.headers });
      expect(badEngine.status).toBe(400);
      const picked = await fetch(`${session.url}/api/v1/system/pick-directory`, { headers: session.headers });
      expect(picked.status).toBe(410);
      expect(await picked.json()).toMatchObject({ code: "absolute_path_response_forbidden" });
    } finally {
      await session.close();
    }
  });

  it("creates partners with description and engine fields while redacting private bodies", async () => {
    const session = await createSession();
    try {
      const forbidden = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({
          capabilities: ["code"], description: "工程搭档", displayName: "Coder", engine: "pi-core",
          kind: "local-pi", modelIdOverride: "kimi-k2.5", prompt: "只修改任务范围内的文件",
          skills: ["typescript"], tools: ["read"], workspaceRef: "D:\\work",
        }),
        headers: session.headers,
        method: "POST",
      });
      expect(forbidden.status).toBe(400);
      expect(await forbidden.json()).toMatchObject({ code: "partner_workspace_forbidden" });

      const created = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({
          capabilities: ["code"], description: "工程搭档", displayName: "Coder", engine: "pi-core",
          kind: "local-pi", modelIdOverride: "kimi-k2.5", prompt: "只修改任务范围内的文件",
          skills: ["typescript"], tools: ["read"],
        }),
        headers: session.headers,
        method: "POST",
      });
      expect(created.status).toBe(201);
      const partner = await created.json() as PartnerDto;
      expect(partner).toMatchObject({
        createdBy: "user", description: "工程搭档", displayName: "Coder", engine: "pi-core",
        knowledgeDocCount: 0, modelIdOverride: "kimi-k2.5",
      });
      const serialized = JSON.stringify(partner);
      expect(serialized).not.toContain("只修改任务范围内的文件");
      expect(serialized).not.toContain("D:\\work");
      expect(serialized).not.toContain("promptRef");

      const list = await fetch(`${session.url}/api/v1/partners`, { headers: session.headers });
      const { items } = await list.json() as { items: PartnerDto[] };
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ description: "工程搭档", engine: "pi-core" });
    } finally {
      await session.close();
    }
  });

  it("rejects invalid engine combinations with domain error codes", async () => {
    const session = await createSession();
    try {
      const invalidEngine = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({ capabilities: [], displayName: "X", engine: "bogus", kind: "local-pi", skills: [], tools: [] }),
        headers: session.headers,
        method: "POST",
      });
      expect(invalidEngine.status).toBe(400);
      expect(await invalidEngine.json()).toMatchObject({ code: "partner_engine_invalid" });

      // Mana availability is gated before domain validation: while the engine is
      // unavailable every mana request fails with 409 engine_unavailable.
      const missingModel = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({ capabilities: [], displayName: "X", engine: "claude-code", kind: "local-pi", skills: [], tools: [] }),
        headers: session.headers,
        method: "POST",
      });
      expect(missingModel.status).toBe(409);
      expect(await missingModel.json()).toMatchObject({ code: "engine_unavailable" });

      const a2aEngine = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({ capabilities: [], displayName: "X", engine: "claude-code", engineModelId: "m", kind: "a2a", skills: [], tools: [] }),
        headers: session.headers,
        method: "POST",
      });
      expect(a2aEngine.status).toBe(409);
      expect(await a2aEngine.json()).toMatchObject({ code: "engine_unavailable" });
    } finally {
      await session.close();
    }
  });

  it("toggles partners through the unified disabled flag and duplicates them on request", async () => {
    const session = await createSession();
    try {
      const created = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({ capabilities: [], displayName: "Toggle", kind: "local-pi", prompt: "保持专注", skills: [], tools: [] }),
        headers: session.headers,
        method: "POST",
      });
      const partner = await created.json() as PartnerDto;

      const disabled = await fetch(`${session.url}/api/v1/partners/${encodeURIComponent(partner.partnerId)}`, {
        body: JSON.stringify({ disabled: true }), headers: session.headers, method: "PATCH",
      });
      expect((await disabled.json() as PartnerDto).status).toBe("DISABLED");

      const enabled = await fetch(`${session.url}/api/v1/partners/${encodeURIComponent(partner.partnerId)}`, {
        body: JSON.stringify({ disabled: false }), headers: session.headers, method: "PATCH",
      });
      expect((await enabled.json() as PartnerDto).status).toBe("ACTIVE");

      const duplicated = await fetch(`${session.url}/api/v1/partners/${encodeURIComponent(partner.partnerId)}/duplicate`, {
        headers: session.headers, method: "POST",
      });
      expect(duplicated.status).toBe(201);
      const copy = await duplicated.json() as PartnerDto;
      expect(copy.partnerId).not.toBe(partner.partnerId);
      expect(copy.displayName).toBe("Toggle（副本）");
      expect(copy.createdBy).toBe("user");
      expect(JSON.stringify(copy)).not.toContain("保持专注");
    } finally {
      await session.close();
    }
  });

  it("uploads, lists and deletes partner knowledge documents without exposing bodies", async () => {
    const session = await createSession();
    try {
      const created = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({ capabilities: [], displayName: "KB", kind: "local-pi", skills: [], tools: [] }),
        headers: session.headers,
        method: "POST",
      });
      const partner = await created.json() as PartnerDto;
      const knowledgeUrl = `${session.url}/api/v1/partners/${encodeURIComponent(partner.partnerId)}/knowledge`;

      const uploaded = await fetch(knowledgeUrl, {
        body: JSON.stringify({ contentBase64: Buffer.from("# 规范\n先读后写。", "utf8").toString("base64"), filename: "guide.md" }),
        headers: session.headers,
        method: "POST",
      });
      expect(uploaded.status).toBe(201);
      const meta = await uploaded.json() as PartnerKnowledgeDocDto;
      expect(meta).toMatchObject({ bytes: Buffer.from("# 规范\n先读后写。", "utf8").length, filename: "guide.md" });

      const listed = await fetch(knowledgeUrl, { headers: session.headers });
      const { items } = await listed.json() as { items: PartnerKnowledgeDocDto[] };
      expect(items).toHaveLength(1);
      expect(JSON.stringify(items)).not.toContain("先读后写");

      const refreshed = await fetch(`${session.url}/api/v1/partners`, { headers: session.headers });
      expect(((await refreshed.json() as { items: PartnerDto[] }).items)[0]).toMatchObject({ knowledgeDocCount: 1 });

      const deleted = await fetch(`${knowledgeUrl}/${encodeURIComponent(meta.docId)}`, { headers: session.headers, method: "DELETE" });
      expect(deleted.status).toBe(204);
      const missing = await fetch(`${knowledgeUrl}/${encodeURIComponent(meta.docId)}`, { headers: session.headers, method: "DELETE" });
      expect(missing.status).toBe(404);
    } finally {
      await session.close();
    }
  });

  it("lists partner engines and rejects mana partners with 409 while the engine is unavailable", async () => {
    const session = await createSession();
    try {
      const engines = await fetch(`${session.url}/api/v1/engines`, { headers: session.headers });
      expect(engines.status).toBe(200);
      expect((await engines.json() as { items: unknown[] }).items).toEqual([]);

      const rejected = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({ capabilities: [], displayName: "Mana writer", engine: "claude-code", engineModelId: "claude-sonnet", kind: "local-pi", skills: [], tools: [], workspaceRef: "workspace" }),
        headers: session.headers,
        method: "POST",
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ code: "partner_workspace_forbidden" });

      const created = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({ capabilities: [], displayName: "Local writer", engine: "pi-core", kind: "local-pi", skills: [], tools: [] }),
        headers: session.headers,
        method: "POST",
      });
      expect(created.status).toBe(201);
      const partner = await created.json() as PartnerDto;
      const rejectedUpdate = await fetch(`${session.url}/api/v1/partners/${encodeURIComponent(partner.partnerId)}`, {
        body: JSON.stringify({ capabilities: [], displayName: "Local writer", engine: "claude-code", engineModelId: "claude-sonnet", skills: [], tools: [] }),
        headers: session.headers,
        method: "PATCH",
      });
      expect(rejectedUpdate.status).toBe(409);
    } finally {
      await session.close();
    }
  });

  it("keeps partner memory private and requires Avatar scope for legacy instance views", async () => {
    const session = await createSession();
    try {
      const created = await fetch(`${session.url}/api/v1/partners`, {
        body: JSON.stringify({ capabilities: [], displayName: "Memory holder", kind: "local-pi", skills: [], tools: [] }),
        headers: session.headers,
        method: "POST",
      });
      const partner = await created.json() as PartnerDto;

      const memory = await fetch(`${session.url}/api/v1/partners/${encodeURIComponent(partner.partnerId)}/memory`, { headers: session.headers });
      expect(memory.status).toBe(410);
      expect(await memory.json()).toMatchObject({ code: "partner_memory_private" });

      const instances = await fetch(`${session.url}/api/v1/partners/${encodeURIComponent(partner.partnerId)}/instances`, { headers: session.headers });
      expect(instances.status).toBe(400);
      expect(await instances.json()).toMatchObject({ code: "avatar_id_required" });
    } finally {
      await session.close();
    }
  });
});
