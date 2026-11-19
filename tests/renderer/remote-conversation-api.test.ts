// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { RemoteConversationApi } from "../../src/renderer/RemoteConversationApi";
import type { RequestOptions } from "../../src/renderer/api";
import type { RemoteCommand } from "../../src/shared/remote";

it.each([
  ["/api/v1/conversations", {}, { kind: "conversation.list", archived: false }],
  ["/api/v1/conversations?archived=true", {}, { kind: "conversation.list", archived: true }],
  ["/api/v1/conversations/c", {}, { kind: "conversation.get", conversationId: "c" }],
  ["/api/v1/conversations/c", { method: "DELETE" }, { kind: "conversation.delete", conversationId: "c" }],
  ["/api/v1/conversations/c/title", { method: "PUT", body: { title: "New" } }, { kind: "conversation.rename", title: "New" }],
  ["/api/v1/conversations/c/history?cursor=older", {}, { kind: "conversation.history", cursor: "older" }],
  ["/api/v1/conversations/c/events", {}, { kind: "conversation.events" }],
  ["/api/v1/conversations/c/stop", { method: "POST" }, { kind: "conversation.stop" }],
  ["/api/v1/conversations/c/archive", { method: "POST" }, { kind: "conversation.archive" }],
  ["/api/v1/conversations/c/restore", { method: "POST" }, { kind: "conversation.restore" }],
  ["/api/v1/conversations/c/children/child/cancel", { method: "POST" }, { kind: "conversation.cancelChild", childId: "child" }],
  ["/api/v1/conversation-inheritance/w?partnerId=p&networkId=n", {}, { kind: "conversation.inheritance", workbenchId: "w", partnerId: "p", networkId: "n" }],
  ["/api/v1/conversation-inheritance/w", {}, { kind: "conversation.inheritance", partnerId: "joi-chat", networkId: "" }],
  ["/api/v1/engines/pi-core/skills", {}, { kind: "conversation.skills", engine: "pi-core" }],
] as [string, RequestOptions, Partial<RemoteCommand>][]) ("maps the paired conversation operation %s", async (path, options, expected) => {
  const command = vi.fn().mockResolvedValue({ result: true });
  const api = new RemoteConversationApi({ command: <T>(input: RemoteCommand,signal?: AbortSignal) => command(input,signal) as Promise<T> });
  const controller = new AbortController();
  await expect(api.request(path,{ ...options,signal: controller.signal })).resolves.toEqual({ result: true });
  expect(command).toHaveBeenCalledWith(expect.objectContaining(expected),controller.signal);
});

it.each([
  ["/api/v1/conversations/chat%201/questions/q%201/answer", { kind: "conversation.answerQuestion", conversationId: "chat 1", questionId: "q 1" }],
  ["/api/v1/joi/goals/goal%201/questions/q%202/answer", { kind: "question.answer", scopeKind: "GOAL", scopeId: "goal 1", questionId: "q 2" }],
])("maps question answer route %s only for negotiated hosts", async (path, expected) => {
  const command = vi.fn().mockResolvedValue({ status: "ANSWERED" });
  const api = new RemoteConversationApi({ capabilities: () => ["questions.v1"], command: <T>(input: RemoteCommand) => command(input) as Promise<T> });
  const input = { version: 4, useDefault: true };
  await expect(api.request(path, { method: "POST", body: input })).resolves.toEqual({ status: "ANSWERED" });
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ ...expected as object, input }));
  const oldApi = new RemoteConversationApi({ command: <T>(input: RemoteCommand) => command(input) as Promise<T> });
  await expect(oldApi.request(path, { method: "POST", body: input })).rejects.toMatchObject({ code: "remote_upgrade_required" });
  expect(command).toHaveBeenCalledTimes(1);
});

it("maps explicit interrupted-question resume without resending an answer", async () => {
  const command = vi.fn().mockResolvedValue({ conversationId: "chat" });
  const api = new RemoteConversationApi({ capabilities: () => ["questions.v1"], command: <T>(input: RemoteCommand) => command(input) as Promise<T> });
  await api.request("/api/v1/conversations/chat/questions/q1/resume", { method: "POST" });
  expect(command).toHaveBeenCalledWith(expect.objectContaining({ kind: "conversation.resumeQuestion", conversationId: "chat", questionId: "q1" }));
  expect(command.mock.calls[0]?.[0]).not.toHaveProperty("input");
});

it("uses only paired catalog metadata, preserves send identity and has no local workspace or attachment transport", async () => {
  const command = vi.fn().mockResolvedValue({ workbenches: [{ workbenchId: "w" }],networks: [{ sourceId: "n" }],partners: [{ partnerId: "p" }] });
  const api = new RemoteConversationApi({ command: <T>(input: RemoteCommand) => command(input) as Promise<T> });
  await expect(api.listWorkbenches()).resolves.toEqual({ items: [{ workbenchId: "w" }] });
  await expect(api.listModelSources()).resolves.toEqual({ items: [{ sourceId: "n" }] });
  await expect(api.listPartners()).resolves.toEqual({ items: [{ partnerId: "p" }] });
  const input = { conversationId: "c",workbenchId: "w",requestId: "stable",text: "Hello",partnerId: "joi-chat",networkId: "n",skills: [],attachmentIds: [] };
  await api.sendConversation(input);
  expect(command).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "conversation.send",input }));
  expect(api.desktop).toBe(false);
  expect(api.conversationAttachments).toBe(false);
  expect(api.watchConversation()).toBeUndefined();
  for (const path of ["/api/v1/conversation-workspaces/w/files","/api/v1/settings","/api/v1/conversations/c/unknown"]) {
    await expect(api.request(path)).rejects.toMatchObject({ code: "remote_operation_forbidden" });
  }
});
