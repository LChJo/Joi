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
