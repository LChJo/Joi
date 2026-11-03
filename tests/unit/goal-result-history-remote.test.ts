import { RemoteCommandService } from "../../src/main/application/remote/remote-command-service.js";
import { RemoteHomeQueryService } from "../../src/main/application/remote/remote-home-queries.js";
import { isRemoteCommand } from "../../src/main/infrastructure/remote/remote-access-host.js";

describe("AC-37/48/57 remote result history", () => {
  it("reads artifact pages directly and validates the additive command", async () => {
    expect(isRemoteCommand({ kind: "goal.artifacts", requestId: "files", goalId: "g", cursor: "page" })).toBe(true);
    expect(isRemoteCommand({ kind: "goal.artifacts", requestId: "files", goalId: "" })).toBe(false);
    const listGoalArtifacts = vi.fn().mockResolvedValue({ items: [], nextCursor: "next" });
    const load = vi.fn();
    const queries = new RemoteHomeQueryService({ homeFeed: { load, listGoalArtifacts }, inputs: { readDisplayText: vi.fn() },
      agents: { list: vi.fn(), conversation: vi.fn() }, workbenches: { listSummaries: vi.fn() }, partners: { list: vi.fn() } });
    const remote = new RemoteCommandService({ homeFeed: { load }, inbox: { accept: vi.fn() }, queries });
    const response = await remote.handle({ kind: "goal.artifacts", requestId: "files", goalId: "g", cursor: "page" }, "phone");
    expect(JSON.parse((response.result as { chunk: string }).chunk)).toEqual({ items: [], nextCursor: "next" });
    expect(listGoalArtifacts).toHaveBeenCalledWith("g", { cursor: "page" });
    expect(load).not.toHaveBeenCalled();
    listGoalArtifacts.mockResolvedValue(null);
    await expect(queries.artifacts("missing")).rejects.toMatchObject({ code: "remote_goal_unavailable" });
  });
  it("validates the narrow history commands and requires the selected record", () => {
    expect(isRemoteCommand({ kind: "goal.results", requestId: "list", goalId: "g" })).toBe(true);
    expect(isRemoteCommand({ kind: "goal.results", requestId: "list", goalId: "g", cursor: "page" })).toBe(true);
    expect(isRemoteCommand({ kind: "goal.result", requestId: "read", goalId: "g", resultId: "snapshot" })).toBe(true);
    expect(isRemoteCommand({ kind: "goal.result", requestId: "read", goalId: "g" })).toBe(false);
    expect(isRemoteCommand({ kind: "goal.results", requestId: "list", goalId: "" })).toBe(false);
  });

  it("uses scoped snapshot queries without loading the whole home feed", async () => {
    const listGoalResults = vi.fn().mockResolvedValue({ items: [{ resultId: "old", completedAt: "2026-11-01T00:00:00Z", status: "COMPLETED" }] });
    const getGoalResult = vi.fn().mockResolvedValue({ goalId: "g", resultId: "old", body: "# Earlier answer", completedAt: "2026-11-01T00:00:00Z", status: "COMPLETED" });
    const load = vi.fn();
    const service = new RemoteHomeQueryService({ homeFeed: { load, listGoalResults, getGoalResult }, inputs: { readDisplayText: vi.fn() },
      agents: { list: vi.fn(), conversation: vi.fn() }, workbenches: { listSummaries: vi.fn() }, partners: { list: vi.fn() } });
    expect(await service.results("g", "page")).toMatchObject({ items: [{ resultId: "old" }] });
    expect(await service.result("g", "old")).toMatchObject({ body: "# Earlier answer" });
    expect(listGoalResults).toHaveBeenCalledWith("g", { cursor: "page" });
    expect(getGoalResult).toHaveBeenCalledWith("g", "old");
    expect(load).not.toHaveBeenCalled();
    getGoalResult.mockResolvedValue(null);
    await expect(service.result("other", "old")).rejects.toMatchObject({ code: "remote_goal_unavailable" });
    listGoalResults.mockResolvedValue(null);
    await expect(service.results("removed")).rejects.toMatchObject({ code: "remote_goal_unavailable" });
  });

  it("pages the selected immutable body and binds continuation to its connection", async () => {
    const body = "中文😀".repeat(9_000);
    const results = vi.fn().mockResolvedValue({ items: [], nextCursor: "older" });
    const result = vi.fn().mockResolvedValue({ goalId: "g", resultId: "old", body });
    const service = new RemoteCommandService({ homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn() },
      queries: { catalog: vi.fn(), goal: vi.fn(), agents: vi.fn(), conversation: vi.fn(), results, result } });
    const list = await service.handle({ kind: "goal.results", requestId: "list", goalId: "g", cursor: "page" } as never, "phone");
    expect(list.error).toBeUndefined();
    expect(JSON.parse((list.result as { chunk: string }).chunk)).toEqual({ items: [], nextCursor: "older" });
    expect(results).toHaveBeenCalledWith("g", "page");
    let response = await service.handle({ kind: "goal.result", requestId: "read", goalId: "g", resultId: "old" } as never, "phone");
    let text = "";
    while (response.result !== undefined) {
      const page = response.result as { chunk: string; nextCursor?: string };
      text += page.chunk;
      if (page.nextCursor === undefined) break;
      expect((await service.handle({ kind: "read.next", requestId: "wrong", cursor: page.nextCursor }, "other")).error?.code).toBe("remote_cursor_expired");
      response = await service.handle({ kind: "read.next", requestId: "next", cursor: page.nextCursor }, "phone");
    }
    expect(response.error).toBeUndefined();
    expect(JSON.parse(text)).toEqual({ goalId: "g", resultId: "old", body });
    expect(result).toHaveBeenCalledWith("g", "old");
    const legacy = new RemoteCommandService({ homeFeed: { load: vi.fn() }, inbox: { accept: vi.fn() } });
    expect((await legacy.handle({ kind: "goal.results", requestId: "old", goalId: "g" } as never)).error?.code).toBe("remote_operation_forbidden");
  });
});
