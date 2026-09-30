import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion */

import { RemoteCommandService } from "../../src/main/application/remote/remote-command-service.js";

describe("RemoteCommandService", () => {
  it("abbreviates private paths in action receipts and legacy feed projections", async () => {
    const unsafe = { textPreview: "C:\\private\\a\\b\\report.md", token: "token=private-value" };
    const service = new RemoteCommandService({ homeFeed: { load: vi.fn().mockResolvedValue(unsafe) }, inbox: { accept: vi.fn().mockResolvedValue(unsafe) } });
    for (const command of [{ kind: "feed.get", requestId: "feed" }, { kind: "message.send", requestId: "send", text: "hello", idempotencyKey: "key" }] as const) {
      const response = await service.handle(command);
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain("private-value");
      expect(serialized).toContain(String.raw`C:\\…\\a\\b\\report.md`);
    }
  });
  it("preserves an explicitly selected workbench when sending", async () => {
    const accept = vi.fn().mockResolvedValue({ inputId: "input-1", status: "PENDING" });
    const service = new RemoteCommandService({ homeFeed: { load: vi.fn() }, inbox: { accept } });
    await service.handle({ kind: "message.send", requestId: "send", idempotencyKey: "same-key", text: "hello", workbenchId: "bench-1" } as never);
    expect(accept).toHaveBeenCalledWith({ text: "hello", idempotencyKey: "same-key", workbenchId: "bench-1" });
  });

  it("creates a workbench through the narrow remote command and returns only its safe summary", async () => {
    const create = vi.fn().mockResolvedValue({
      createdAt: "2026-09-30T00:00:00.000Z",
      memory: { namespaceId: "private-memory" },
      profile: { name: "AI 应用开发工作台", personaRevisionId: "private-persona", personaSummary: "private persona", scopeSummary: "SDK 与 API 调试" },
      project: { label: "AI 应用开发" },
      taskContext: { activeWorkIds: [], summary: "private task context" },
      updatedAt: "2026-09-30T00:00:00.000Z",
      workbenchId: "workbench-new",
    });
    const service = new RemoteCommandService({
      homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn(), list: vi.fn().mockResolvedValue([{
        acceptedAt: "2026-09-30T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid",
        inputId: "goal", status: "CLARIFICATION_REQUIRED",
      }]) }, workbenchRegistry: { create },
    } as never);

    await expect(service.handle({
      inputId: "goal", kind: "workbench.create", requestId: "create-workbench", name: "AI 应用开发工作台",
      personaSummary: "关注 SDK/API 集成、应用开发和可验证交付。", projectLabel: "AI 应用开发",
      scopeSummary: "SDK 与 API 调试",
    } as never)).resolves.toEqual({
      kind: "response", requestId: "create-workbench",
      result: { name: "AI 应用开发工作台", scopeSummary: "SDK 与 API 调试", updatedAt: "2026-09-30T00:00:00.000Z", workbenchId: "workbench-new" },
    });
    expect(create).toHaveBeenCalledWith({
      name: "AI 应用开发工作台", personaSummary: "关注 SDK/API 集成、应用开发和可验证交付。",
      projectLabel: "AI 应用开发", scopeSummary: "SDK 与 API 调试",
    });
  });

  it("refuses remote workbench creation outside an active workbench clarification", async () => {
    const create = vi.fn();
    const service = new RemoteCommandService({
      homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn(), list: vi.fn().mockResolvedValue([{
        acceptedAt: "2026-09-30T00:00:00.000Z", inputId: "goal", status: "PENDING",
      }]) }, workbenchRegistry: { create },
    } as never);

    await expect(service.handle({
      inputId: "goal", kind: "workbench.create", requestId: "create-workbench", name: "越界工作台",
      personaSummary: "不应创建。", projectLabel: "越界", scopeSummary: "不应创建。",
    } as never)).resolves.toMatchObject({ error: { code: "joi_clarification_unavailable" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("pages long read results without splitting Unicode and binds cursors to the connection", async () => {
    const feed = { goals: [], thinking: [], unassignedActions: [], text: "中文😀\n".repeat(30_000) };
    const service = new RemoteCommandService({ homeFeed: { load: vi.fn().mockResolvedValue(feed) }, inbox: { accept: vi.fn() } });
    const handle = service.handle.bind(service) as (command: unknown, scope: string) => Promise<{ result?: { chunk: string; nextCursor?: string }; error?: unknown }>;
    let response = await handle({ kind: "feed.get", requestId: "a", paged: true }, "phone-a");
    let body = "";
    expect(response.result?.chunk).toBeTypeOf("string");
    while (response.result !== undefined) {
      expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThan(96 * 1024);
      body += response.result.chunk;
      const cursor = response.result.nextCursor;
      if (cursor === undefined) break;
      expect((await handle({ kind: "read.next", requestId: "other", cursor }, "phone-b")).error).toBeDefined();
      response = await handle({ kind: "read.next", requestId: "a", cursor }, "phone-a");
    }
    expect(JSON.parse(body)).toEqual(feed);
  });

  it("routes goal mutations and returns domain failures without throwing out of the session", async () => {
    const retry = vi.fn().mockResolvedValue({ inputId: "goal", status: "PENDING" });
    const dismiss = vi.fn().mockRejectedValue(new Error("private failure"));
    const service = new RemoteCommandService({ homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn(), retry, dismiss } } as never);
    await expect(service.handle({ kind: "message.retry", requestId: "retry", inputId: "goal", text: "more" } as never)).resolves.toMatchObject({ result: { inputId: "goal" } });
    expect(retry).toHaveBeenCalledWith({ inputId: "goal", text: "more" });
    await expect(service.handle({ kind: "message.dismiss", requestId: "dismiss", inputId: "goal" } as never)).resolves.toMatchObject({ error: { code: "remote_command_failed" } });
  });

  it("carries the question a gate-backed clarification card advertised through to the inbox", async () => {
    // The repository matches these against the gate's own question and refuses anything that
    // disagrees, so a phone answering a card while this layer dropped them could only ever come
    // back unavailable — the card rendered, the button dead, on every gate-backed goal.
    const clarify = vi.fn().mockResolvedValue({ inputId: "goal", status: "PENDING" });
    const service = new RemoteCommandService({ homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn(), clarify } } as never);
    await expect(service.handle({
      actionChoice: "CONTINUE", inputId: "goal",
      kind: "message.clarify", questionId: "joi_action:goal_continuation:goal:r5:s1", questionVersion: 3,
      requestId: "clarify",
    } as never)).resolves.toMatchObject({ result: { inputId: "goal" } });
    expect(clarify).toHaveBeenCalledWith({
      actionChoice: "CONTINUE", inputId: "goal",
      questionId: "joi_action:goal_continuation:goal:r5:s1", questionVersion: 3,
    });
  });

  it("exposes only the home feed and idempotent text submission", async () => {
    const feed = { goals: [], thinking: [], unassignedActions: [] };
    const load = vi.fn().mockResolvedValue(feed);
    const accept = vi.fn().mockResolvedValue({ acceptedAt: "2026-08-26T00:00:00.000Z", inputId: "input-1", status: "PENDING" });
    const service = new RemoteCommandService({ homeFeed: { load }, inbox: { accept } });

    await expect(service.handle({ kind: "feed.get", requestId: "request-feed" })).resolves.toEqual({
      kind: "response", requestId: "request-feed", result: feed,
    });
    await expect(service.handle({ idempotencyKey: "remote:device-1:message-1", kind: "message.send", requestId: "request-send", text: "  帮我整理今天的任务  " })).resolves.toEqual({
      kind: "response", requestId: "request-send", result: expect.objectContaining({ inputId: "input-1" }),
    });
    expect(accept).toHaveBeenCalledWith({ idempotencyKey: "remote:device-1:message-1", text: "帮我整理今天的任务" });
    await expect(service.handle({ kind: "settings.get", requestId: "request-nope" } as never)).resolves.toEqual({
      error: { code: "remote_operation_forbidden", message: "This remote operation is not available." },
      kind: "response", requestId: "request-nope",
    });
  });
});
