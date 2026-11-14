import { expect, it, vi } from "vitest";
import { RemoteCommandService } from "../../src/main/application/remote/remote-command-service.js";
import { isRemoteCommand } from "../../src/main/infrastructure/remote/remote-access-host.js";
import type { RemoteCommand,RemoteReadPage } from "../../src/shared/remote.js";

const input = { conversationId: "chat",workbenchId: "wb",requestId: "stable",text: "Hello",partnerId: "joi-chat",networkId: "network",skills: [],attachmentIds: [] };
const commands: RemoteCommand[] = [
  { kind: "conversation.catalog",requestId: "catalog" },
  { kind: "conversation.skills",requestId: "skills",engine: "pi-core" },
  { kind: "conversation.list",requestId: "list",archived: true },
  { kind: "conversation.inheritance",requestId: "inheritance",workbenchId: "wb",partnerId: "joi-chat",networkId: "" },
  { kind: "conversation.send",requestId: "send",input },
  { kind: "conversation.get",requestId: "get",conversationId: "chat" },
  { kind: "conversation.history",requestId: "history",conversationId: "chat",cursor: "older" },
  { kind: "conversation.events",requestId: "events",conversationId: "chat",cursor: "newer" },
  { kind: "conversation.rename",requestId: "rename",conversationId: "chat",title: "Renamed" },
  { kind: "conversation.stop",requestId: "stop",conversationId: "chat" },
  { kind: "conversation.archive",requestId: "archive",conversationId: "chat" },
  { kind: "conversation.restore",requestId: "restore",conversationId: "chat" },
  { kind: "conversation.delete",requestId: "delete",conversationId: "chat" },
  { kind: "conversation.cancelChild",requestId: "cancel",conversationId: "chat",childId: "child" },
];

it.each(commands)("admits and maps the remote operation $kind", async command => {
  const operation = vi.fn().mockResolvedValue({ ok: true });
  const source = { list: operation,get: operation,send: operation,inheritance: operation,page: operation,events: operation,rename: operation,stop: operation,archive: operation,restore: operation,delete: operation,cancelChild: operation };
  const service = new RemoteCommandService({ homeFeed: { load: vi.fn() },inbox: { accept: vi.fn() },conversations: { service: source,catalog: operation,skills: operation } });
  expect(isRemoteCommand(command)).toBe(true);
  const response = await service.handle(command,"phone");
  expect(response.error).toBeUndefined();
  expect(operation).toHaveBeenCalledTimes(1);
  expect(JSON.parse((response.result as RemoteReadPage).chunk)).toBeDefined();
  if (command.kind === "conversation.send") expect(operation).toHaveBeenCalledWith(input);
  if (command.kind === "conversation.rename") expect(operation).toHaveBeenCalledWith("chat","Renamed");
});

it.each([
  null,[],{}, { kind: "conversation.catalog",requestId: "" },
  { kind: "conversation.skills",requestId: "x",engine: "unknown" },
  { kind: "conversation.list",requestId: "x",archived: "yes" },
  { kind: "conversation.get",requestId: "x",conversationId: "" },
  { kind: "conversation.history",requestId: "x",conversationId: "chat",cursor: "x".repeat(241) },
  { kind: "conversation.rename",requestId: "x",conversationId: "chat",title: "x".repeat(81) },
  { kind: "conversation.cancelChild",requestId: "x",conversationId: "chat",childId: null },
  ...[null,[],{}, { ...input,cwd: "/private" }, { ...input,requestId: "" }, { ...input,text: " " }, { ...input,text: "x".repeat(64_001) },
    { ...input,networkId: 4 }, { ...input,skills: "all" }, { ...input,skills: Array(65).fill("skill") }, { ...input,attachmentIds: Array(17).fill("attachment") },
    { ...input,skills: ["x".repeat(241)] }, { ...input,attachmentIds: [7] }, { ...input,subagentsEnabled: "yes" }, { ...input,piExtensions: ["unknown"] },
  ].map(input => ({ kind: "conversation.send",requestId: "send",input })),
])("refuses malformed remote conversation input %#", value => {
  expect(isRemoteCommand(value)).toBe(false);
});

it("preserves application refusals and leaves unavailable remote capabilities closed", async () => {
  const send = vi.fn().mockRejectedValue(new (await import("../../src/main/domain/errors.js")).DomainError("conversation_busy","Busy"));
  const dependencies = { homeFeed: { load: vi.fn() },inbox: { accept: vi.fn() } };
  const unavailable = new RemoteCommandService(dependencies);
  expect((await unavailable.handle(commands[0] ?? { kind: "conversation.catalog",requestId: "catalog" })).error?.code).toBe("remote_operation_forbidden");
  const service = new RemoteCommandService({ ...dependencies,conversations: { service: { send } } } as never);
  expect((await service.handle({ kind: "conversation.send",requestId: "send",input })).error?.code).toBe("conversation_busy");
  expect((await service.handle({ kind: "conversation.send",requestId: "send",input: { ...input,cwd: "/private" } } as never)).error?.code).toBe("remote_operation_forbidden");
});

it("admits conversation commands at the encrypted host boundary and refuses local workspace overrides", () => {
  expect(isRemoteCommand({ kind: "conversation.get", requestId: "get", conversationId: "chat" })).toBe(true);
  expect(isRemoteCommand({ kind: "conversation.catalog", requestId: "catalog" })).toBe(true);
  expect(isRemoteCommand({ kind: "conversation.workspace", requestId: "files", conversationId: "chat" })).toBe(false);
  expect(isRemoteCommand({ kind: "conversation.send", requestId: "send", input: { conversationId: "chat", workbenchId: "wb", requestId: "stable", text: "Hello", partnerId: "joi-chat", networkId: "network", skills: [], attachmentIds: [], cwd: "/private" } })).toBe(false);
});

it("serves normal conversation history through bounded device-scoped remote pages", async () => {
  const get = vi.fn().mockResolvedValue({ conversationId: "chat", turns: [{ text: "中文".repeat(20_000) }] });
  const service = new RemoteCommandService({
    homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn() },
    conversations: { service: { get } },
  } as never);
  let response = await service.handle({ kind: "conversation.get", requestId: "get", conversationId: "chat" } as never, "phone");
  expect(response.error).toBeUndefined();
  let body = "";
  let pages = 0;
  while (response.result !== undefined) {
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(100_000);
    const page = response.result as { chunk: string; nextCursor?: string };
    body += page.chunk;
    pages += 1;
    if (page.nextCursor === undefined) break;
    expect((await service.handle({ kind: "read.next", requestId: "other", cursor: page.nextCursor }, "other")).error?.code).toBe("remote_cursor_expired");
    response = await service.handle({ kind: "read.next", requestId: "next", cursor: page.nextCursor }, "phone");
  }
  expect(pages).toBeGreaterThan(1);
  expect(JSON.parse(body)).toEqual({ conversationId: "chat", turns: [{ text: "中文".repeat(20_000) }] });
  expect(get).toHaveBeenCalledWith("chat");
});
