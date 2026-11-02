import { describe, expect, it, vi } from "vitest";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unnecessary-type-assertion */

import { RemoteCommandService } from "../../src/main/application/remote/remote-command-service.js";

describe("RemoteCommandService", () => {
  it("bounds opt-in feed previews while retaining complete on-demand goal results and legacy reads", async () => {
    const summary = "x".repeat(399) + "😀" + "中文".repeat(16_000);
    const artifacts = Array.from({ length: 1_000 }, (_, index) => ({
      artifactId: `artifact-${String(index)}`, kind: "FILE", mimeType: "text/plain", name: `result-${String(index)}.txt`, size: 100,
    }));
    const feed = {
      goals: Array.from({ length: 44 }, (_, index) => ({
        goalId: `goal-${String(index)}`, title: "A goal", status: "COMPLETED",
        ...(index === 43 ? {} : { completionSummary: index === 42 ? "Short 😀" : summary }),
        ...(index < 27 ? { archivedAt: "2026-11-02T00:00:00Z" } : {}), artifacts,
        work: { active: 0, completed: 1, failed: 0, total: 1 }, workbench: { workbenchId: "b", name: "Bench" },
        agentCount: 1, canArchive: true, canDelete: true, updatedAt: "2026-11-02T00:00:00Z",
      })), thinking: [], unassignedActions: [],
    };
    const service = new RemoteCommandService({
      homeFeed: { load: vi.fn().mockResolvedValue(feed) }, inbox: { accept: vi.fn() },
      queries: { goal: vi.fn().mockResolvedValue({ goal: feed.goals[0], text: "Original input" }), catalog: vi.fn(), agents: vi.fn(), conversation: vi.fn() },
    });
    const read = async (command: Record<string, unknown>) => {
      let response = await service.handle(command as never, "phone");
      let body = "";
      let pages = 0;
      while (response.result !== undefined) {
        expect(response.error).toBeUndefined();
        const page = response.result as { chunk: string; nextCursor?: string };
        body += page.chunk;
        pages += 1;
        if (page.nextCursor === undefined) break;
        response = await service.handle({ kind: "read.next", requestId: "next", cursor: page.nextCursor }, "phone");
      }
      expect(response.error).toBeUndefined();
      return { body, pages, value: JSON.parse(body) as typeof feed & { goal: typeof feed.goals[number] } };
    };
    const preview = await read({ kind: "feed.get", requestId: "preview", paged: true, preview: true });
    expect(Buffer.byteLength(preview.body)).toBeLessThan(100_000);
    expect(preview.pages).toBeLessThan(5);
    expect(preview.value.goals).toHaveLength(44);
    expect(preview.value.goals.filter((goal) => goal.archivedAt !== undefined)).toHaveLength(27);
    for (const goal of preview.value.goals) {
      expect(goal.artifacts).toBeUndefined();
      expect((goal.completionSummary ?? "").length).toBeLessThanOrEqual(401);
      if (goal.completionSummary !== undefined) expect(Buffer.from(goal.completionSummary).toString("utf8")).toBe(goal.completionSummary);
    }
    expect(preview.value.goals[42]?.completionSummary).toBe("Short 😀");
    expect(preview.value.goals[43]?.completionSummary).toBeUndefined();
    const detail = await read({ kind: "goal.get", requestId: "detail", goalId: "goal-0" });
    expect(detail.value.goal.completionSummary).toBe(summary);
    expect(detail.value.goal.artifacts).toHaveLength(1_000);
    const legacy = await service.handle({ kind: "feed.get", requestId: "legacy" });
    expect(legacy.result).toEqual(feed);
    const pagedLegacy = await read({ kind: "feed.get", requestId: "paged-legacy", paged: true });
    expect(pagedLegacy.value).toEqual(feed);
    expect(feed.goals[0]?.completionSummary).toBe(summary);
    expect(feed.goals[0]?.artifacts).toHaveLength(1_000);
  });
  it("forwards a versioned creation to the atomic registry without attaching in a second transaction", async () => {
    const create = vi.fn().mockResolvedValue({ profile: { name: "工程工坊", scopeSummary: "工程维护。" }, updatedAt: "2026-10-15", workbenchId: "created" });
    const attachWorkbench = vi.fn();
    const service = new RemoteCommandService({
      homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn(), attachWorkbench }, workbenchRegistry: { create },
    });
    const draft = {
      inputId: "input", bindInputId: "input", questionId: "q1", questionVersion: 1, idempotencyKey: "stable",
      name: "工程工坊", projectLabel: "joi", scopeSummary: "工程维护。", personaSummary: "private draft",
    };
    expect(await service.handle({ ...draft, kind: "workbench.create", requestId: "create" })).toMatchObject({ result: { bound: true, workbenchId: "created" } });
    expect(create).toHaveBeenCalledWith({ bindInputId: draft.bindInputId, questionId: draft.questionId, questionVersion: draft.questionVersion, idempotencyKey: draft.idempotencyKey,
      name: draft.name, projectLabel: draft.projectLabel, scopeSummary: draft.scopeSummary, personaSummary: draft.personaSummary });
    expect(attachWorkbench).not.toHaveBeenCalled();
  });
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
      homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn() }, workbenchRegistry: { create },
    } as never);

    await expect(service.handle({
      inputId: "goal", kind: "workbench.create", requestId: "create-workbench", name: "AI 应用开发工作台",
      personaSummary: "关注 SDK/API 集成、应用开发和可验证交付。", projectLabel: "AI 应用开发",
      scopeSummary: "SDK 与 API 调试",
    } as never)).resolves.toEqual({
      kind: "response", requestId: "create-workbench",
      result: { bound: false, name: "AI 应用开发工作台", scopeSummary: "SDK 与 API 调试", updatedAt: "2026-09-30T00:00:00.000Z", workbenchId: "workbench-new" },
    });
    expect(create).toHaveBeenCalledWith({
      name: "AI 应用开发工作台", personaSummary: "关注 SDK/API 集成、应用开发和可验证交付。",
      projectLabel: "AI 应用开发", scopeSummary: "SDK 与 API 调试",
    });
  });

  it("creates and binds the workbench for the input in the same request", async () => {
    // The phone has no second request to fall back on: if these two are not one operation, a card
    // that moved on between them leaves a workbench nobody is bound to and a user with no way
    // forward. Binding travels with the creation.
    const create = vi.fn().mockResolvedValue({
      profile: { name: "行程规划工坊", scopeSummary: "目的地资料整理、路线与时间安排。" },
      updatedAt: "2026-09-30T00:00:00.000Z", workbenchId: "workbench-new",
    });
    const attachWorkbench = vi.fn().mockResolvedValue({ inputId: "goal", status: "ROUTED" });
    const service = new RemoteCommandService({
      homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn(), attachWorkbench }, workbenchRegistry: { create },
    } as never);

    await expect(service.handle({
      bindInputId: "goal", inputId: "goal", kind: "workbench.create", requestId: "create-workbench",
      name: "行程规划工坊", personaSummary: "先确认约束再比较方案。", projectLabel: "行程规划",
      scopeSummary: "目的地资料整理、路线与时间安排。",
    } as never)).resolves.toMatchObject({ requestId: "create-workbench", result: { bound: true, workbenchId: "workbench-new" } });
    expect(attachWorkbench).toHaveBeenCalledWith({ inputId: "goal", workbenchId: "workbench-new" });
  });

  it("keeps the workbench and reports it unbound when the input no longer awaits a choice", async () => {
    const create = vi.fn().mockResolvedValue({
      profile: { name: "行程规划工坊", scopeSummary: "目的地资料整理。" },
      updatedAt: "2026-09-30T00:00:00.000Z", workbenchId: "workbench-new",
    });
    const attachWorkbench = vi.fn().mockResolvedValue(null);
    const service = new RemoteCommandService({
      homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn(), attachWorkbench }, workbenchRegistry: { create },
    } as never);

    await expect(service.handle({
      bindInputId: "goal", inputId: "goal", kind: "workbench.create", requestId: "create-workbench",
      name: "行程规划工坊", personaSummary: "先确认约束再比较方案。", projectLabel: "行程规划",
      scopeSummary: "目的地资料整理。",
    } as never)).resolves.toMatchObject({ result: { bound: false, workbenchId: "workbench-new" } });
    expect(create).toHaveBeenCalledTimes(1);
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
