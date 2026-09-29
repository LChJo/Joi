// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { JoiHome } from "../../src/renderer/JoiHome.js";
import type { JoiHomeFeedDto, JoiSnapshotDto } from "../../src/shared/joi.js";

const snapshot: JoiSnapshotDto = {
  workbenchChanges: [], workbenches: [], modelSources: [{
    sourceId: "source", displayName: "Test", kind: "deepseek", accessMode: "api", protocol: "openai",
    order: 0, primary: true, status: "READY", credential: { configured: true, version: 1 },
    activeSourceRevisionId: "revision", activeModel: { capability: "release-tested", id: "model", revisionId: "model-revision" },
  }], partners: [], work: [],
  runtime: { configured: true, status: "READY" },
};
const feed: JoiHomeFeedDto = { goals: [{
  goalId: "running", title: "正在执行的任务", status: "RUNNING", agentCount: 1, canDelete: false,
  updatedAt: "2026-09-19T00:00:00Z", workbench: { workbenchId: "bench", name: "工作台" },
  work: { active: 1, completed: 0, failed: 0, total: 1 },
}], thinking: [], unassignedActions: [] };

describe("home feed failure preserves execution truth", () => {
  it("shows an initial failure and retries without inferring status from inbox messages", async () => {
    const api = new DigitalLifeApi("", true);
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
    const load = vi.spyOn(api, "joiHomeFeed").mockRejectedValue(new Error("private failure"));
    const legacy = vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { inputId: "running", acceptedAt: "2026-09-19T00:00:00Z", status: "CONSUMED" },
    ] });
    render(<JoiHome api={api} />);
    expect(await screen.findByText("任务状态暂时无法刷新，已保留上次成功获取的数据。")).toBeInTheDocument();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
    expect(screen.queryByText(/这里很干净/u)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("private failure");
    expect(legacy).not.toHaveBeenCalled();
    load.mockResolvedValue(feed);
    fireEvent.click(screen.getByRole("button", { name: "重新加载任务状态" }));
    expect(await screen.findByText("执行中")).toBeInTheDocument();
    expect(screen.queryByText(/任务状态暂时无法刷新/u)).not.toBeInTheDocument();
  });

  it("keeps a running card during polling failures and clears the error after recovery", async () => {
    const api = new DigitalLifeApi("", true);
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
    const load = vi.spyOn(api, "joiHomeFeed").mockResolvedValue(feed);
    const legacy = vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    render(<JoiHome api={api} />);
    expect(await screen.findByText("执行中")).toBeInTheDocument();
    load.mockRejectedValue(new Error("offline"));
    await waitFor(() => expect(screen.getByText(/任务状态暂时无法刷新/u)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(legacy).not.toHaveBeenCalled();
    const goal = feed.goals[0];
    if (goal === undefined || goal.status === "NEEDS_ATTENTION") throw new Error("invalid fixture");
    load.mockResolvedValue({ ...feed, goals: [{ ...goal, status: "FINALIZING" }] });
    act(() => { fireEvent.click(screen.getByRole("button", { name: "重新加载任务状态" })); });
    expect(await screen.findByText("正在总结")).toBeInTheDocument();
    expect(screen.queryByText(/任务状态暂时无法刷新/u)).not.toBeInTheDocument();
  });

  it("polls the feed alone instead of repeating the full snapshot round trip", async () => {
    const api = new DigitalLifeApi("", true);
    const snapshots = vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
    const feeds = vi.spyOn(api, "joiHomeFeed").mockResolvedValue(feed);
    render(<JoiHome api={api} />);
    expect(await screen.findByText("执行中")).toBeInTheDocument();
    const snapshotsAfterMount = snapshots.mock.calls.length;
    await waitFor(() => expect(feeds.mock.calls.length).toBeGreaterThan(2), { timeout: 5000 });
    expect(snapshots.mock.calls.length).toBe(snapshotsAfterMount);
  });

  it("backs an idle feed off to 7.5 seconds while keeping active work at 1.5 seconds", async () => {
    vi.useFakeTimers();
    try {
      const api = new DigitalLifeApi("", true);
      vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
      const feeds = vi.spyOn(api, "joiHomeFeed")
        .mockResolvedValueOnce({ goals: [], thinking: [], unassignedActions: [] })
        .mockResolvedValue(feed);
      render(<JoiHome api={api} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(feeds).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(7_499); });
      expect(feeds).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(feeds).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(feeds).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed feed collections without discarding the retry affordance", async () => {
    const api = new DigitalLifeApi("", true);
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
    const feeds = vi.spyOn(api, "joiHomeFeed")
      .mockResolvedValueOnce({ goals: null, thinking: [], unassignedActions: [] } as unknown as JoiHomeFeedDto)
      .mockResolvedValueOnce({ goals: [], thinking: null, unassignedActions: [] } as unknown as JoiHomeFeedDto)
      .mockResolvedValueOnce({ goals: [], thinking: [], unassignedActions: null } as unknown as JoiHomeFeedDto)
      .mockResolvedValue(feed);
    render(<JoiHome api={api} />);

    expect(await screen.findByRole("button", { name: "重新加载任务状态" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新加载任务状态" }));
    await waitFor(() => expect(feeds).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "重新加载任务状态" }));
    await waitFor(() => expect(feeds).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "重新加载任务状态" }));
    expect(await screen.findByText("执行中")).toBeInTheDocument();
  });

  it("coalesces a manual retry with an in-flight idle poll", async () => {
    vi.useFakeTimers();
    try {
      const api = new DigitalLifeApi("", true);
      vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
      let resolveFeed: ((value: JoiHomeFeedDto) => void) | undefined;
      const feeds = vi.spyOn(api, "joiHomeFeed")
        .mockRejectedValueOnce(new Error("offline"))
        .mockImplementation(() => new Promise((resolve) => { resolveFeed = resolve; }));
      render(<JoiHome api={api} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole("button", { name: "重新加载任务状态" })).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(7_500); });
      expect(feeds).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: "重新加载任务状态" }));
      expect(feeds).toHaveBeenCalledTimes(2);
      await act(async () => { resolveFeed?.(feed); await Promise.resolve(); });
      expect(screen.getByText("执行中")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start polling while the document begins hidden", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      const api = new DigitalLifeApi("", true);
      vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
      const feeds = vi.spyOn(api, "joiHomeFeed").mockResolvedValue(feed);
      render(<JoiHome api={api} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(feeds).not.toHaveBeenCalled();
      visibility = "visible";
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(feeds.mock.calls.length).toBeGreaterThan(0);
    } finally {
      if (originalVisibility === undefined) delete (document as unknown as { visibilityState?: DocumentVisibilityState }).visibilityState;
      else Object.defineProperty(document, "visibilityState", originalVisibility);
      vi.useRealTimers();
    }
  });

  it("does not reschedule a pending feed request after unmount", async () => {
    vi.useFakeTimers();
    try {
      const api = new DigitalLifeApi("", true);
      vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
      let resolveFeed: ((value: JoiHomeFeedDto) => void) | undefined;
      const feeds = vi.spyOn(api, "joiHomeFeed").mockImplementation(() => new Promise((resolve) => { resolveFeed = resolve; }));
      const view = render(<JoiHome api={api} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(feeds).toHaveBeenCalledOnce();

      view.unmount();
      await act(async () => { resolveFeed?.(feed); await Promise.resolve(); });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(feeds).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses while hidden, refreshes on visibility, and never overlaps a slow feed request", async () => {
    vi.useFakeTimers();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    try {
      const api = new DigitalLifeApi("", true);
      vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
      let resolveFeed: ((value: JoiHomeFeedDto) => void) | undefined;
      const feeds = vi.spyOn(api, "joiHomeFeed").mockImplementation(() => new Promise((resolve) => { resolveFeed = resolve; }));
      render(<JoiHome api={api} />);

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(feeds).toHaveBeenCalledOnce();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(feeds).toHaveBeenCalledOnce();
      visibility = "hidden";
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { resolveFeed?.(feed); await Promise.resolve(); });
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(feeds).toHaveBeenCalledOnce();

      visibility = "visible";
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { await Promise.resolve(); });
      expect(feeds).toHaveBeenCalledTimes(2);
    } finally {
      if (originalVisibility === undefined) delete (document as unknown as { visibilityState?: DocumentVisibilityState }).visibilityState;
      else Object.defineProperty(document, "visibilityState", originalVisibility);
      vi.useRealTimers();
    }
  });
});
