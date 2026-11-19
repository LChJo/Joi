// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { useWorkbenchAgentPage } from "../../src/renderer/useWorkbenchAgentPage.js";
import { GOAL_RECENT_AGENT_LIMIT, type WorkbenchAgentCardDto } from "../../src/shared/joi.js";

type Page = Awaited<ReturnType<DigitalLifeApi["listWorkbenchAgents"]>>;
const agent = (agentId: string, status: WorkbenchAgentCardDto["status"] = "COMPLETED"): WorkbenchAgentCardDto => ({
  agentId, status, workbenchId: "bench", canDelete: true, engine: "codex", transport: "LOCAL",
  createdAt: "2026-11-19T00:00:00Z", lastActivityAt: "2026-11-19T00:00:00Z",
  partnerId: "partner", partnerName: "Partner", sessionPolicy: "EPHEMERAL",
});
const tick = (milliseconds = 1) => act(() => vi.advanceTimersByTimeAsync(milliseconds));
const visibilityChanged = () => document.dispatchEvent(new Event("visibilitychange"));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("pauses while hidden and serializes a queued refresh with cursor navigation", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const api = new DigitalLifeApi("");
  const initial = Promise.withResolvers<Page>();
  const first = { items: [agent("first", "WAITING")], nextCursor: "cursor" };
  const second = { items: [agent("second")] };
  const load = vi.spyOn(api, "listWorkbenchAgents").mockReturnValueOnce(initial.promise)
    .mockImplementation((_id, options) => Promise.resolve(options?.cursor === undefined ? first : second));
  const { result, unmount } = renderHook(() => useWorkbenchAgentPage(api, { workbenchId: "bench", enabled: true }));
  act(() => { result.current.next(); result.current.refresh(); });
  await tick(10_000);
  expect(load).not.toHaveBeenCalled();

  visibility.mockReturnValue("visible");
  visibilityChanged();
  await tick();
  expect(result.current.busy).toBe(true);
  act(() => result.current.refresh());
  expect(load).toHaveBeenCalledOnce();
  await act(async () => { initial.resolve(first); await initial.promise; });
  expect(load).toHaveBeenCalledTimes(2);
  expect(result.current.items).toEqual(first.items);

  await act(async () => { result.current.next(); await Promise.resolve(); });
  expect(load).toHaveBeenLastCalledWith("bench", { limit: 100, cursor: "cursor" });
  expect(result.current).toMatchObject({ items: second.items, hasNext: false, hasPrevious: true });
  act(() => result.current.next());
  expect(load).toHaveBeenCalledTimes(3);
  await act(async () => { result.current.previous(); await Promise.resolve(); });
  expect(result.current).toMatchObject({ items: first.items, hasNext: true, hasPrevious: false });
  expect(load).toHaveBeenLastCalledWith("bench", { limit: 100 });
  unmount();
});

it("reuses an in-flight request for the same scope and ignores stale replies after a scope change", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const api = new DigitalLifeApi("");
  const original = Promise.withResolvers<Page>();
  const changed = Promise.withResolvers<Page>();
  const stale = Promise.withResolvers<Page>();
  const fresh = { items: [agent("fresh")] };
  const load = vi.spyOn(api, "listWorkbenchAgents").mockReturnValueOnce(original.promise)
    .mockReturnValueOnce(changed.promise).mockReturnValueOnce(stale.promise).mockResolvedValue(fresh);
  const { result, rerender, unmount } = renderHook(({ goalId, enabled }) =>
    useWorkbenchAgentPage(api, { workbenchId: "bench", goalId, enabled }), { initialProps: { goalId: "old", enabled: true } });
  await tick();
  rerender({ goalId: "old", enabled: false });
  rerender({ goalId: "old", enabled: true });
  await tick();
  expect(load).toHaveBeenCalledOnce();

  rerender({ goalId: "new", enabled: true });
  await tick();
  expect(load).toHaveBeenLastCalledWith("bench", { goalId: "new", limit: GOAL_RECENT_AGENT_LIMIT });
  await act(async () => { original.resolve({ items: [agent("stale")] }); await original.promise; });
  expect(result.current.items).toEqual([]);
  expect(result.current.busy).toBe(true);
  const overLimit = Array.from({ length: GOAL_RECENT_AGENT_LIMIT + 1 }, (_, index) => agent(String(index)));
  await act(async () => { changed.resolve({ items: overLimit, nextCursor: "ignored" }); await changed.promise; });
  expect(result.current.items).toEqual(overLimit.slice(0, GOAL_RECENT_AGENT_LIMIT));
  expect(result.current.hasNext).toBe(false);

  act(() => result.current.refresh());
  rerender({ goalId: "current", enabled: true });
  await tick();
  await act(async () => { stale.reject(new Error("offline")); await stale.promise.catch(() => undefined); });
  expect(result.current).toMatchObject({ items: fresh.items, busy: false, failed: false });
  unmount();
});

it("keeps the last successful page when a refresh is malformed and recovers after backoff", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const api = new DigitalLifeApi("");
  const first = { items: [agent("working", "RUNNING")] };
  const recovered = { items: [agent("done")] };
  const load = vi.spyOn(api, "listWorkbenchAgents")
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce({} as Page)
    .mockResolvedValue(recovered);
  const onPage = vi.fn();
  const { result, unmount } = renderHook(() => useWorkbenchAgentPage(api, { workbenchId: "bench", enabled: true, onPage }));
  await tick();
  await tick(1_500);
  expect(result.current).toMatchObject({ items: first.items, failed: true, busy: false });
  await tick(7_400);
  expect(load).toHaveBeenCalledTimes(2);
  await tick(100);
  expect(result.current).toMatchObject({ items: recovered.items, failed: false });
  expect(onPage.mock.calls).toEqual([[first.items], [recovered.items]]);
  unmount();
});
