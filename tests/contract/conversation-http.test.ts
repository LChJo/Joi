import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { createRuntimeFixture } from "../support/runtime-fixture";
import type { ConversationDto } from "../../src/shared/conversations";
import { DomainError } from "../../src/main/domain/errors";

it("CHAT-04/45 streams prefixes and releases subscriptions on completion, disconnect and revoked sessions",async () => {
  const f = await createRuntimeFixture();
  const turn: ConversationDto["turns"][number] = { turnId: "turn",text: "Question",createdAt: "2026-11-13T00:00:00Z",status: "RUNNING",
    config: { partnerId: "joi-chat",partnerName: "joi",networkId: "network",networkName: "Network",modelName: "model",skills: [],attachmentIds: [] },
    entries: [{ entryId: "answer",sequence: 1,createdAt: "2026-11-13T00:00:00Z",kind: "MARKDOWN",role: "AGENT",text: "First" }],artifacts: [] };
  const chat: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "Question",updatedAt: turn.createdAt,turns: [turn] };
  interface Update { conversationId: string;turn: ConversationDto["turns"][number]; }
  let publish: ((update: Update) => void) | undefined;
  const unsubscribe = vi.fn();
  const conversations = { list: () => Promise.resolve({ items: [chat] }),get: () => Promise.resolve(chat),send: () => Promise.resolve(chat),
    rename: () => Promise.resolve(chat),archive: () => Promise.resolve(),restore: () => Promise.resolve(),delete: () => Promise.resolve(),stop: () => Promise.resolve(),
    inheritance: () => Promise.resolve({ memoryCount: 0,evolutionRevisionId: null }),
    subscribe: vi.fn((_id: string,listener: (update: Update) => void) => { publish = listener;return unsubscribe; }) };
  const listeners = await startRuntimeListeners({ loopbackPort: 0,handler: createApiHandler({ ...f,conversations }) });
  vi.useFakeTimers({ toFake: ["setInterval","clearInterval"] });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const base = listeners.loopback.url,url = `${base}/api/v1/conversations/chat/stream`;
    expect((await fetch(url)).status).toBe(401);
    const bootstrap = await f.auth.issueDesktopBootstrap();
    const auth = await fetch(`${base}/api/v1/auth/bootstrap`,{ method: "POST",headers: { "content-type": "application/json",origin: "null" },body: JSON.stringify({ nonce: bootstrap.nonce }) });
    const cookie = auth.headers.get("set-cookie")?.split(";")[0] ?? "";
    conversations.subscribe.mockImplementationOnce(() => { throw new DomainError("conversation_identity_invalid","Conversation identity is invalid."); });
    expect((await fetch(`${base}/api/v1/conversations/bad%20id/stream`,{ headers: { cookie } })).status).toBe(400);
    const response = await fetch(url,{ headers: { cookie } });
    expect(response.status).toBe(200);expect(response.headers.get("content-type")).toContain("text/event-stream");
    reader = response.body?.getReader();if (reader === undefined || publish === undefined) throw new Error("Missing stream");
    const decode = new TextDecoder();
    expect(decode.decode((await reader.read()).value)).toContain('"text":"First"');
    const next = { ...turn,entries: turn.entries.map(entry => ({ ...entry,text: "First words" })) };
    publish({ conversationId: "chat",turn: next });
    expect(decode.decode((await reader.read()).value)).toContain('"text":"First words"');
    publish({ conversationId: "chat",turn: { ...next,status: "COMPLETED" } });
    expect(decode.decode((await reader.read()).value)).toContain('"status":"COMPLETED"');
    expect((await reader.read()).done).toBe(true);expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(conversations.subscribe).toHaveBeenCalledWith("chat",expect.any(Function));
    reader = (await fetch(url,{ headers: { cookie } })).body?.getReader();await reader?.read();await reader?.cancel();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(2));
    reader = (await fetch(url,{ headers: { cookie } })).body?.getReader();await reader?.read();
    await f.auth.logout(cookie.slice(cookie.indexOf("=") + 1));
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await reader?.read())?.done).toBe(true);expect(unsubscribe).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers();await reader?.cancel();await listeners.close();await f.close(); }
});

it("CHAT-09/44 protects conversation mutations, rejects model overrides and confines workspace operations to desktop sessions", async () => {
  const f = await createRuntimeFixture();
  const chat: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "Hello",updatedAt: "2026-11-11",turns: [] };
  const send = vi.fn(() => Promise.resolve(chat));
  const execute = vi.fn(() => Promise.resolve());
  const list = vi.fn(() => Promise.resolve({ items: [chat] }));
  const archive = vi.fn(() => Promise.resolve()),restore = vi.fn(() => Promise.resolve()),remove = vi.fn(() => Promise.resolve());
  const rename = vi.fn((_id: string,title: string) => Promise.resolve({ ...chat,title }));
  const listeners = await startRuntimeListeners({ loopbackPort: 0,handler: createApiHandler({ ...f,
    conversations: { list,get: () => Promise.resolve(chat),send,rename,archive,restore,delete: remove,stop: () => Promise.resolve(),inheritance: () => Promise.resolve({ memoryCount: 0,evolutionRevisionId: null }) },
    conversationWorkspace: { status: () => Promise.resolve({ available: false,branch: "",branches: [],ahead: 0,behind: 0,files: [],history: [] }),diff: () => Promise.resolve({ patch: "",truncated: false }),files: () => Promise.resolve({ items: [] }),file: () => Promise.resolve({ text: "",truncated: false }),execute },
  }) });
  const base = listeners.loopback.url;
  try {
    expect((await fetch(`${base}/api/v1/conversations`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/conversations/chat/title`,{ method: "PUT" })).status).toBe(401);
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
    const renameUrl = `${base}/api/v1/conversations/chat/title`,titleBody = JSON.stringify({ title: "项目讨论" });
    expect((await fetch(renameUrl,{ method: "PUT",headers: { cookie },body: titleBody })).status).toBe(403);
    expect((await fetch(renameUrl,{ method: "PUT",headers: { ...headers,origin: "https://foreign.invalid" },body: titleBody })).status).toBe(403);
    expect(rename).not.toHaveBeenCalled();
    const renamed = await fetch(renameUrl,{ method: "PUT",headers,body: titleBody });
    expect(renamed.status).toBe(200);expect(await renamed.json()).toMatchObject({ title: "项目讨论" });expect(rename).toHaveBeenCalledWith("chat","项目讨论");
    for (const body of [{},{ title: 42 }]) expect((await fetch(renameUrl,{ method: "PUT",headers,body: JSON.stringify(body) })).status).toBe(400);
    expect(rename).toHaveBeenCalledTimes(1);
    expect((await fetch(`${base}/api/v1/conversation-workspaces/wb/git`,{ headers })).status).toBe(200);
    expect((await fetch(`${base}/api/v1/auth/setup`,{ method: "POST",headers: { ...headers,origin: "null" },body: JSON.stringify({ password: "conversation fixture password" }) })).status).toBe(204);
    const login = await fetch(`${base}/api/v1/auth/login`,{ method: "POST",headers: { origin: base,"content-type": "application/json" },body: JSON.stringify({ password: "conversation fixture password" }) });
    const lanCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect((await fetch(`${base}/api/v1/conversations`,{ headers: { cookie: lanCookie } })).status).toBe(200);
    for (const view of ["git","diff","files","file"]) expect((await fetch(`${base}/api/v1/conversation-workspaces/wb/${view}`,{ headers: { cookie: lanCookie } })).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  } finally { await listeners.close();await f.close(); }
});
