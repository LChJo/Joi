// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { useGoalDetail } from "../../src/renderer/useGoalDetail.js";
import type { JoiGoalDetailDto, JoiGoalProgressDto } from "../../src/shared/joi.js";

function page(offset = 0): JoiGoalDetailDto {
  return {
    goalId: "g", fullTitle: "Full title",
    ...(offset === 0 ? { nextOffset: 50 } : {}),
    harness: { revision: 2, mapStatus: "ACTIVE", currentLayer: 2, pathCount: 51, decisionCount: 0, fogCount: 0,
      paths: [{ pathId: `path-${String(offset)}`, title: "Fixture path", layer: offset === 0 ? 2 : 1, status: "OPEN" }], decisions: [], fog: [] },
  };
}

it("polls the summary and leaves loaded map pages alone until their revision changes", async () => {
  vi.useFakeTimers();
  try {
    const api = new DigitalLifeApi("");
    let revision = 2;
    const load = vi.spyOn(api, "joiGoalDetail").mockImplementation((_id, options) => {
      const result = page(options?.offset);
      if (result.harness !== undefined) {
        result.harness.revision = revision;
        if (options?.view === "summary") result.harness.paths = [];
      }
      return Promise.resolve(result);
    });
    const { result, unmount } = renderHook(() => useGoalDetail(api, "g"));
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(async () => { result.current.loadMore(); await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.detail?.harness?.paths).toHaveLength(2);
    load.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(1600));
    expect(load.mock.calls).toEqual([["g", { view: "summary" }]]);
    expect(result.current.detail?.harness?.paths).toHaveLength(2);
    revision++;
    await act(() => vi.advanceTimersByTimeAsync(8000));
    expect(result.current.detail?.harness?.revision).toBe(revision);
    expect(result.current.detail?.harness?.paths).toHaveLength(2);
    unmount();
  } finally { vi.useRealTimers(); }
});

it("loads further pages and retains the last complete map on a failed refresh until retry succeeds", async () => {
  const api = new DigitalLifeApi("");
  let unavailable = false;
  const load = vi.spyOn(api, "joiGoalDetail").mockImplementation((_goalId, options) => unavailable
    ? Promise.reject(new Error("offline")) : Promise.resolve(page(options?.offset)));
  const { result, unmount } = renderHook(() => useGoalDetail(api, "g"));
  await waitFor(() => expect(result.current.detail?.harness?.paths).toHaveLength(1));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.detail?.harness?.paths).toHaveLength(2));
  expect(load).toHaveBeenCalledWith("g", { offset: 50, view: "map" });
  expect(result.current.detail?.nextOffset).toBeUndefined();
  unavailable = true;
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.detail?.harness?.paths).toHaveLength(2);
  unavailable = false;
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.failed).toBe(false));
  expect(result.current.detail?.harness?.paths).toHaveLength(2);
  unmount();
});

it.each(["revision", "pathCount"] as const)("discards a mixed-%s page set and recovers without publishing partial data", async (field) => {
  const api = new DigitalLifeApi("");
  let changed = false;
  vi.spyOn(api, "joiGoalDetail").mockImplementation((_goalId, options) => {
    const response = page(options?.offset);
    if (changed && options?.offset !== undefined && response.harness !== undefined) response.harness[field]++;
    return Promise.resolve(response);
  });
  const { result, unmount } = renderHook(() => useGoalDetail(api, "g"));
  await waitFor(() => expect(result.current.detail).toBeDefined());
  changed = true;
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.detail?.harness?.paths).toHaveLength(1);
  changed = false;
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.detail?.harness?.paths).toHaveLength(2));
  unmount();
});

it("loads older map pages while linked Work statuses are changing", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "joiGoalDetail").mockImplementation((_id, options) => {
    const result = page(options?.offset);
    Object.assign(result.harness ?? {}, { pathOrderRevision: 1, detailRevision: options?.offset === undefined ? 1 : 2 });
    return Promise.resolve(result);
  });
  const { result, unmount } = renderHook(() => useGoalDetail(api, "g"));
  await waitFor(() => expect(result.current.detail?.harness?.paths).toHaveLength(1));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.detail?.harness?.paths).toHaveLength(2));
  expect(result.current.failed).toBe(false);
  unmount();
});

it("ignores late requests after a goal change or unmount", async () => {
  const api = new DigitalLifeApi("");
  let resolveOld!: (value: JoiGoalDetailDto) => void;
  vi.spyOn(api, "joiGoalDetail").mockImplementation((id) => id === "old" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ goalId: "new", fullTitle: "New goal" }));
  const { result, rerender, unmount } = renderHook(({ id }) => useGoalDetail(api, id), { initialProps: { id: "old" } });
  await waitFor(() => expect(resolveOld).toBeDefined());
  rerender({ id: "new" });
  await waitFor(() => expect(result.current.detail?.goalId).toBe("new"));
  await act(async () => { resolveOld(page()); await Promise.resolve(); });
  expect(result.current.detail?.goalId).toBe("new");
  unmount();
});

it("pauses hidden reads and queues a manual retry behind the current request", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const api = new DigitalLifeApi("");
  const first = Promise.withResolvers<JoiGoalDetailDto>();
  const latest = { ...page(), fullTitle: "Latest title" };
  const load = vi.spyOn(api, "joiGoalDetail").mockReturnValueOnce(first.promise).mockResolvedValue(latest);
  const { result, unmount } = renderHook(() => useGoalDetail(api, "g"));
  try {
    act(() => result.current.retry());
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(load).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(result.current.busy).toBe(true);
    act(() => result.current.retry());
    document.dispatchEvent(new Event("visibilitychange"));
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(load).toHaveBeenCalledOnce();
    await act(async () => { first.resolve(page()); await first.promise; });
    expect(load).toHaveBeenCalledTimes(2);
    expect(result.current.detail?.fullTitle).toBe("Latest title");
    expect(result.current).toMatchObject({ busy: false, failed: false });
  } finally {
    unmount();
    visibility.mockRestore();
    vi.useRealTimers();
  }
});

it("keeps an intermediate map cursor and projects summary updates without dropping loaded paths", async () => {
  vi.useFakeTimers();
  const api = new DigitalLifeApi("");
  const progress: JoiGoalProgressDto = {
    state: "RUNNING", startedAt: "2026-11-19", updatedAt: "2026-11-20", turnCount: 1, reviewCount: 0,
    work: { active: 1, completed: 1, failed: 0, total: 2 }, recentTurns: [],
  };
  const first = page();
  const load = vi.spyOn(api, "joiGoalDetail").mockImplementation((_id, options) => {
    if (options?.view === "summary" && first.harness !== undefined) {
      return Promise.resolve({ goalId: "g", fullTitle: "Updated title", harness: { ...first.harness, paths: [], progress } });
    }
    if (options?.offset === 50) return Promise.resolve({ ...page(50), nextOffset: 100 });
    return Promise.resolve(page(options?.offset));
  });
  const { result, unmount } = renderHook(() => useGoalDetail(api, "g"));
  try {
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(async () => { result.current.loadMore(); await Promise.resolve(); });
    expect(result.current.detail?.nextOffset).toBe(100);
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(load).toHaveBeenLastCalledWith("g", { view: "summary" });
    expect(result.current.detail).toMatchObject({ fullTitle: "Updated title", nextOffset: 100, harness: { progress } });
    expect(result.current.detail?.harness?.paths.map(path => path.pathId)).toEqual(["path-0", "path-50"]);
    await act(async () => { result.current.loadMore(); await Promise.resolve(); });
    expect(result.current.detail?.harness?.paths).toHaveLength(3);
    expect(result.current.detail?.nextOffset).toBeUndefined();
    act(() => result.current.loadMore());
    expect(load).toHaveBeenCalledTimes(4);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

it.each(["map", "summary", "failed refresh"] as const)("ignores a stale %s response after navigation", async phase => {
  vi.useFakeTimers();
  const api = new DigitalLifeApi("");
  const late = Promise.withResolvers<JoiGoalDetailDto>();
  const newGoal = { goalId: "new", fullTitle: "New title" };
  const load = vi.spyOn(api, "joiGoalDetail").mockResolvedValueOnce(page()).mockReturnValueOnce(late.promise).mockResolvedValue(newGoal);
  const { result, rerender, unmount } = renderHook(({ id }) => useGoalDetail(api, id), { initialProps: { id: "g" } });
  try {
    await act(() => vi.advanceTimersByTimeAsync(1));
    if (phase === "map") act(() => result.current.loadMore());
    else await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(load).toHaveBeenCalledTimes(2);
    rerender({ id: "new" });
    await act(() => vi.advanceTimersByTimeAsync(1));
    await act(async () => {
      if (phase === "failed refresh") late.reject(new Error("offline"));
      else late.resolve(page(50));
      await late.promise.catch(() => undefined);
    });
    expect(result.current).toMatchObject({ detail: newGoal, failed: false, busy: false });
    load.mockResolvedValue({ ...newGoal, fullTitle: "Renamed" });
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(result.current.detail?.fullTitle).toBe("Renamed");
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
