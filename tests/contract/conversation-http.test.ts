import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { createRuntimeFixture } from "../support/runtime-fixture";
import type { ConversationDto } from "../../src/shared/conversations";

it("CHAT-09 protects conversation mutations, rejects model overrides and confines workspace operations to desktop sessions", async () => {
  const f = await createRuntimeFixture();
  const chat: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "Hello",updatedAt: "2026-11-11",turns: [] };
  const send = vi.fn(() => Promise.resolve(chat));
  const execute = vi.fn(() => Promise.resolve());
  const list = vi.fn(() => Promise.resolve({ items: [chat] }));
  const archive = vi.fn(() => Promise.resolve()),restore = vi.fn(() => Promise.resolve()),remove = vi.fn(() => Promise.resolve());
  const listeners = await startRuntimeListeners({ loopbackPort: 0,handler: createApiHandler({ ...f,
    conversations: { list,get: () => Promise.resolve(chat),send,archive,restore,delete: remove,stop: () => Promise.resolve(),inheritance: () => Promise.resolve({ memoryCount: 0,evolutionRevisionId: null }) },
    conversationWorkspace: { status: () => Promise.resolve({ available: false,branch: "",branches: [],ahead: 0,behind: 0,files: [],history: [] }),diff: () => Promise.resolve({ patch: "",truncated: false }),files: () => Promise.resolve({ items: [] }),file: () => Promise.resolve({ text: "",truncated: false }),execute },
  }) });
  const base = listeners.loopback.url;
  try {
    expect((await fetch(`${base}/api/v1/conversations`)).status).toBe(401);
    const bootstrap = await f.auth.issueDesktopBootstrap();
    const auth = await fetch(`${base}/api/v1/auth/bootstrap`,{ method: "POST",headers: { "content-type": "application/json",origin: "null" },body: JSON.stringify({ nonce: bootstrap.nonce }) });
    const cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
    const grant = await auth.json() as { csrfToken: string };
    const headers = { cookie,origin: base,"x-csrf-token": grant.csrfToken,"content-type": "application/json" };
    const body = { conversationId: "chat",workbenchId: "wb",requestId: "request",text: "Hello",partnerId: "joi-chat",networkId: "network",skills: [],attachmentIds: [] };
    expect((await fetch(`${base}/api/v1/conversations`,{ method: "POST",headers: { cookie,"content-type": "application/json" },body: JSON.stringify(body) })).status).toBe(403);
    expect((await fetch(`${base}/api/v1/conversations`,{ method: "POST",headers,body: JSON.stringify({ ...body,modelId: "override" }) })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect((await fetch(`${base}/api/v1/conversations`,{ method: "POST",headers,body: JSON.stringify(body) })).status).toBe(202);
    expect(send).toHaveBeenCalledWith(body);
    const withExtensions = { ...body,piExtensions: ["agent-browser","cc-safety-net"] };
    expect((await fetch(`${base}/api/v1/conversations`,{ method: "POST",headers,body: JSON.stringify(withExtensions) })).status).toBe(202);
    expect(send).toHaveBeenLastCalledWith(withExtensions);
    for (const piExtensions of [["arbitrary-package"],["browser-loop"],["openwiki"],"agent-browser",["agent-browser","agent-browser"],null]) {
      expect((await fetch(`${base}/api/v1/conversations`,{ method: "POST",headers,body: JSON.stringify({ ...body,piExtensions }) })).status).toBe(400);
    }
    expect(send).toHaveBeenCalledTimes(2);
    expect((await fetch(`${base}/api/v1/conversations?archived=true`,{ headers })).status).toBe(200);
    expect(list).toHaveBeenLastCalledWith(true);
    for (const [method,path,action] of [["POST","archive",archive],["POST","restore",restore],["DELETE","",remove]] as const) {
      const url = `${base}/api/v1/conversations/chat${path ? `/${path}` : ""}`;
      expect((await fetch(url,{ method,headers: { cookie } })).status).toBe(403);expect(action).not.toHaveBeenCalled();
      expect((await fetch(url,{ method,headers })).status).toBe(200);expect(action).toHaveBeenCalledWith("chat");
    }
    expect((await fetch(`${base}/api/v1/conversation-workspaces/wb/git`,{ headers })).status).toBe(200);
    expect((await fetch(`${base}/api/v1/auth/setup`,{ method: "POST",headers: { ...headers,origin: "null" },body: JSON.stringify({ password: "conversation fixture password" }) })).status).toBe(204);
    const login = await fetch(`${base}/api/v1/auth/login`,{ method: "POST",headers: { origin: base,"content-type": "application/json" },body: JSON.stringify({ password: "conversation fixture password" }) });
    const lanCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await fetch(`${base}/api/v1/conversations`,{ headers: { cookie: lanCookie } })).status).toBe(200);
    for (const view of ["git","diff","files","file"]) expect((await fetch(`${base}/api/v1/conversation-workspaces/wb/${view}`,{ headers: { cookie: lanCookie } })).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  } finally { await listeners.close();await f.close(); }
});
