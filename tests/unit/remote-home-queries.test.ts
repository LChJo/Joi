import { describe, expect, it, vi } from "vitest";
import { RemoteHomeQueryService } from "../../src/main/application/remote/remote-home-queries.js";
import { RemoteCommandService } from "../../src/main/application/remote/remote-command-service.js";
import { isRemoteCommand } from "../../src/main/infrastructure/remote/remote-access-host.js";

function fixture() {
  const dependencies = {
    homeFeed: { load: vi.fn().mockResolvedValue({ goals: [{ goalId: "g", workbench: { workbenchId: "b" } }], unassignedActions: [{ inputId: "q" }] }) },
    inputs: { readDisplayText: vi.fn().mockResolvedValue("whole user text") },
    agents: { list: vi.fn().mockResolvedValue({ items: [] }), conversation: vi.fn().mockResolvedValue({ items: [] }) },
    workbenches: { listSummaries: vi.fn().mockResolvedValue([{ workbenchId: "b", name: "Research" }]) },
    partners: { list: vi.fn().mockResolvedValue([
      { partnerId: "p", displayName: "Researcher", status: "ACTIVE", promptRef: "private" },
      { partnerId: "off", status: "DISABLED" }, { partnerId: "bad", status: "ACTIVE", configuration: {} },
    ]) },
  };
  return { dependencies, queries: new RemoteHomeQueryService(dependencies) };
}

describe("remote home queries", () => {
  it("returns only selectable catalog metadata and resolves goal scope before reading records", async () => {
    const { queries, dependencies } = fixture();
    expect(await queries.catalog()).toEqual({ workbenches: [{ workbenchId: "b", name: "Research" }], partners: [{ partnerId: "p", displayName: "Researcher" }] });
    expect(await queries.goal("q")).toMatchObject({ action: { inputId: "q" }, text: "whole user text" });
    expect(await queries.agents("q")).toEqual({ items: [] });
    await queries.agents("g", "cursor");
    expect(dependencies.agents.list).toHaveBeenCalledWith({ goalId: "g", workbenchId: "b", limit: 25, cursor: "cursor" });
    await queries.conversation("g", "a");
    expect(dependencies.agents.conversation).toHaveBeenCalledWith({ goalId: "g", workbenchId: "b", agentId: "a", limit: 20 });
    await expect(queries.goal("missing")).rejects.toMatchObject({ code: "remote_goal_unavailable" });
    await expect(queries.conversation("q", "a")).rejects.toMatchObject({ code: "remote_goal_unavailable" });
    dependencies.inputs.readDisplayText.mockResolvedValue(null);
    await expect(queries.goal("g")).rejects.toMatchObject({ code: "remote_goal_unavailable" });
  });

  it("routes all supported reads and mutations, sanitizes reads and expires pages", async () => {
    let now = 0;
    const { queries } = fixture();
    const accepted = { inputId: "g", status: "PENDING" };
    const inbox = { accept: vi.fn(), clarify: vi.fn().mockResolvedValue(accepted), retry: vi.fn().mockResolvedValue(accepted),
      cancel: vi.fn().mockResolvedValue(accepted), dismiss: vi.fn().mockResolvedValue(accepted), closeHistoricalReview: vi.fn().mockResolvedValue(accepted) };
    const service = new RemoteCommandService({ queries, inbox, now: () => now,
      homeFeed: { load: vi.fn().mockResolvedValue({ goals: [], text: "x".repeat(40_000) + " token=secret C:\\private\\file" }) } });
    for (const kind of ["catalog.get", "goal.get", "goal.agents", "agent.conversation"]) {
      const response = await service.handle({ kind, goalId: "g", agentId: "a", requestId: kind } as never);
      expect(response.result).toHaveProperty("encoding", "json");
    }
    for (const kind of ["message.clarify", "message.retry", "message.cancel", "message.dismiss", "message.closeHistoricalReview"]) {
      expect((await service.handle({ kind, inputId: "g", requestId: kind } as never)).result).toEqual(accepted);
    }
    const first = await service.handle({ kind: "feed.get", paged: true, requestId: "f" }, "phone");
    const cursor = (first.result as { nextCursor: string }).nextCursor;
    now = 60_001;
    expect((await service.handle({ kind: "read.next", cursor, requestId: "next" }, "phone")).error?.code).toBe("remote_cursor_expired");
    service.release("phone");
    expect((await service.handle({ kind: "read.next", cursor, requestId: "next" }, "phone")).error?.code).toBe("remote_cursor_expired");
  });

  it("validates the extended command allowlist", () => {
    expect(isRemoteCommand(null)).toBe(false);
    for (const kind of ["catalog.get", "goal.get", "goal.agents", "agent.conversation", "read.next", "message.clarify", "message.retry", "message.cancel", "message.dismiss", "message.closeHistoricalReview"]) {
      expect(isRemoteCommand({ kind, requestId: "r", goalId: "g", agentId: "a", inputId: "g", cursor: "c" })).toBe(true);
    }
    expect(isRemoteCommand({ kind: "feed.get", requestId: "r", paged: "yes" })).toBe(false);
    expect(isRemoteCommand({ kind: "message.send", requestId: "r", text: "t", idempotencyKey: "k", workbenchId: 42 })).toBe(false);
    expect(isRemoteCommand({ kind: "message.retry", requestId: "r", inputId: "g", text: "x".repeat(8001) })).toBe(false);
    expect(isRemoteCommand({ kind: "message.clarify", requestId: "r", inputId: "g", actionChoice: "DELETE" })).toBe(false);
    // The question a card advertises is what a gate-backed clarification is matched against, so it
    // has to survive the allowlist. Optional, because a clarification raised by something other
    // than a gate has no question to name.
    expect(isRemoteCommand({ kind: "message.clarify", requestId: "r", inputId: "g", actionChoice: "CONTINUE", questionId: "q-1", questionVersion: 3 })).toBe(true);
    expect(isRemoteCommand({ kind: "message.clarify", requestId: "r", inputId: "g", questionId: "", questionVersion: 1 })).toBe(false);
    expect(isRemoteCommand({ kind: "message.clarify", requestId: "r", inputId: "g", questionId: "q-1", questionVersion: 0 })).toBe(false);
    expect(isRemoteCommand({ kind: "file.read", requestId: "r", inputId: "g" })).toBe(false);
  });
});
