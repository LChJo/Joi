// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { useGoalDetail } from "../../src/renderer/useGoalDetail.js";
import type { JoiGoalDetailDto } from "../../src/shared/joi.js";

function page(offset = 0): JoiGoalDetailDto {
  return {
    goalId: "g", fullTitle: "Full title",
    ...(offset === 0 ? { nextOffset: 50 } : {}),
    harness: { revision: 2, mapStatus: "ACTIVE", currentLayer: 2, pathCount: 51, decisionCount: 0, fogCount: 0,
      paths: [{ pathId: `path-${String(offset)}`, title: "Fixture path", layer: offset === 0 ? 2 : 1, status: "OPEN" }], decisions: [], fog: [] },
  };
}

it("loads further pages and retains the last complete map on a failed refresh until retry succeeds", async () => {
  const api = new DigitalLifeApi("");
  let unavailable = false;
  const load = vi.spyOn(api, "joiGoalDetail").mockImplementation((_goalId, options) => unavailable
    ? Promise.reject(new Error("offline")) : Promise.resolve(page(options?.offset)));
  const { result, unmount } = renderHook(() => useGoalDetail(api, "g"));
  await waitFor(() => expect(result.current.detail?.harness?.paths).toHaveLength(1));
  act(() => result.current.loadMore());
  await waitFor(() => expect(result.current.detail?.harness?.paths).toHaveLength(2));
  expect(load).toHaveBeenCalledWith("g", { offset: 50 });
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
