// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GoalMap, GoalTitle } from "../../src/renderer/GoalDetailPresentation.js";
import type { JoiGoalMapDetailDto } from "../../src/shared/joi.js";
import { configureLocale } from "../../src/renderer/i18n.js";

beforeEach(() => configureLocale({ preference: "zh-CN", systemLanguages: ["zh-CN"] }));
afterEach(() => vi.restoreAllMocks());

function layout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.matches(".joi-full-title-preview") ? new DOMRect(0, 0, 300, 180)
      : this.matches(".joi-title-menu") ? new DOMRect(0, 0, 180, 52) : new DOMRect(80, 50, 700, 60);
  });
}

it("positions the full-title preview by the pointer and follows movement over the title", async () => {
  layout();
  render(<GoalTitle title="目标" fullTitle="完整目标" />);
  const title = screen.getByRole("button", { name: "目标" });
  fireEvent.mouseEnter(title, { clientX: 200, clientY: 80 });
  const preview = screen.getByRole("tooltip");
  await waitFor(() => expect(parseFloat(preview.style.left)).toBeGreaterThanOrEqual(200));
  const first = parseFloat(preview.style.left);
  fireEvent.mouseMove(title, { clientX: 350, clientY: 90 });
  await waitFor(() => expect(parseFloat(preview.style.left)).toBeGreaterThan(first));
});

it("opens the context menu at the click, keeps it fixed and avoids viewport edges", async () => {
  layout();
  render(<GoalTitle title="目标" fullTitle="完整目标" />);
  const title = screen.getByRole("button", { name: "目标" });
  fireEvent.contextMenu(title, { clientX: 450, clientY: 140, button: 2 });
  const menu = screen.getByRole("menu");
  await waitFor(() => expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(450));
  const first = menu.style.left;
  fireEvent.mouseMove(title, { clientX: 600, clientY: 150 });
  expect(menu.style.left).toBe(first);
  fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
  fireEvent.contextMenu(title, { clientX: 1018, clientY: 760, button: 2 });
  await waitFor(() => {
    const edgeMenu = screen.getByRole("menu");
    expect(parseFloat(edgeMenu.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(edgeMenu.style.left) + 180).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(parseFloat(edgeMenu.style.top) + 52).toBeLessThanOrEqual(window.innerHeight - 8);
  });
});

it("dismisses title overlays on outside scrolling but allows scrolling the full text", () => {
  layout();
  render(<GoalTitle title="目标" fullTitle="完整目标" />);
  fireEvent.mouseEnter(screen.getByRole("button", { name: "目标" }), { clientX: 200, clientY: 80 });
  fireEvent.scroll(screen.getByRole("tooltip"));
  expect(screen.getByRole("tooltip")).toBeInTheDocument();
  fireEvent.scroll(document.body);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

function longMap(): JoiGoalMapDetailDto {
  return { destination: "归因并回传结论", mapStatus: "CLEARED", currentLayer: 32, revision: 9,
    pathCount: 167, decisionCount: 32, fogCount: 1,
    paths: Array.from({ length: 50 }, (_, i) => ({ pathId: `p-${String(i)}`, layer: 32 - Math.floor(i / 6), title: `路径 ${String(i)}`, status: "CLOSED" })),
    decisions: [], fog: [] };
}

it("starts a long map as a compact overview with authoritative counts and opens details explicitly", () => {
  render(<GoalMap harness={longMap()} />);
  expect(screen.getByText("167 条路径 · 32 项决策 · 1 项雾区")).toBeInTheDocument();
  const expand = screen.getByRole("button", { name: "展开路线图" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: /路径 0/u })).not.toBeInTheDocument();
  fireEvent.click(expand);
  expect(screen.getByRole("button", { name: "收起路线图" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("button", { name: /路径 0/u })).toBeInTheDocument();
});

it("retains path selection, notes and layer state across folding and polling", () => {
  const harness = longMap();
  const view = render(<GoalMap harness={harness} />);
  fireEvent.click(screen.getByRole("button", { name: "展开路线图" }));
  fireEvent.click(screen.getByRole("button", { name: /路径 0/u }));
  fireEvent.click(screen.getByRole("button", { name: /雾区/u }));
  fireEvent.click(screen.getByRole("button", { name: "收起路线图" }));
  view.rerender(<GoalMap harness={{ ...harness, revision: 10, pathCount: 168 }} />);
  expect(screen.getByRole("button", { name: "展开路线图" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(screen.getByRole("button", { name: "展开路线图" }));
  expect(screen.getByRole("button", { name: /雾区/u })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /^路径/u }));
  expect(screen.getByRole("button", { name: /路径 0/u })).toHaveAttribute("aria-pressed", "true");
});

it("keeps retry reachable when collapsed and contains paging and accurate partial-data notices in details", () => {
  const load = vi.fn();
  const retry = vi.fn();
  const harness = { ...longMap(), paths: [], decisions: [], fog: [] };
  const view = render(<GoalMap harness={harness} hasMore failed onLoadMore={load} onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /加载更多路径/u })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "展开路线图" }));
  expect(screen.getByText("已加载 0 / 共 167 项")).toBeInTheDocument();
  expect(screen.getAllByText("关联内容尚未加载，请加载更多后查看。")[0]).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /加载更多路径/u }));
  expect(load).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /^决策/u }));
  expect(screen.getByText("已加载 0 / 共 32 项")).toBeInTheDocument();
  expect(screen.queryByText("尚未记录决策。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^雾区/u }));
  expect(screen.getByText("已加载 0 / 共 1 项")).toBeInTheDocument();
  view.rerender(<GoalMap harness={harness} hasMore failed busy onLoadMore={load} onRetry={retry} />);
  expect(screen.getByRole("button", { name: "重试" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /加载更多路径/u })).toBeDisabled();
});

it("pins a clicked title for touch reading and dismisses it on resize", async () => {
  layout();
  render(<GoalTitle title="目标" fullTitle="完整目标" />);
  const title = screen.getByRole("button", { name: "目标" });
  fireEvent.click(title, { detail: 1, clientX: 200, clientY: 80 });
  const preview = screen.getByRole("tooltip");
  const initial = preview.style.left;
  fireEvent.mouseMove(title, { clientX: 400, clientY: 120 });
  expect(preview.style.left).toBe(initial);
  fireEvent.mouseLeave(title.closest(".joi-full-title") ?? title);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(preview).toBeInTheDocument();
  fireEvent.resize(window);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("anchors keyboard actions to the title and explains a decision that is not loaded", () => {
  layout();
  const view = render(<GoalTitle title="目标" fullTitle="完整目标" />);
  const title = screen.getByRole("button", { name: "目标" });
  fireEvent.focus(title);
  expect(screen.getByRole("tooltip").style.left).toBe("88px");
  fireEvent.keyDown(title, { key: "ContextMenu" });
  expect(screen.getByRole("menu").style.top).toBe("118px");
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  const harness = longMap();
  const path = harness.paths[0];
  if (path === undefined) throw new Error("missing fixture path");
  view.rerender(<GoalMap harness={{ ...harness, paths: [{ ...path, resolvedDecisionId: "unloaded" }] }} />);
  fireEvent.click(screen.getByRole("button", { name: "展开路线图" }));
  fireEvent.click(screen.getByRole("button", { name: /路径 0/u }));
  expect(screen.getByRole("region", { name: "路径详情" })).toHaveTextContent("关联内容尚未加载");
});

it("restores a separate reading position for each route section", () => {
  render(<GoalMap harness={longMap()} />);
  fireEvent.click(screen.getByRole("button", { name: "展开路线图" }));
  const content = screen.getByRole("region", { name: "路线图详情" });
  content.scrollTop = 120;
  fireEvent.scroll(content);
  fireEvent.click(screen.getByRole("button", { name: /^决策/u }));
  expect(content.scrollTop).toBe(0);
  content.scrollTop = 40;
  fireEvent.scroll(content);
  fireEvent.click(screen.getByRole("button", { name: /^路径/u }));
  expect(content.scrollTop).toBe(120);
  fireEvent.click(screen.getByRole("button", { name: /^决策/u }));
  expect(content.scrollTop).toBe(40);
});

it("reveals the selected path description instead of leaving it below a long layer", async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  render(<GoalMap harness={longMap()} />);
  fireEvent.click(screen.getByRole("button", { name: "展开路线图" }));
  fireEvent.click(screen.getByRole("button", { name: /路径 0/u }));
  await waitFor(() => expect(scroll).toHaveBeenCalled());
  expect(scroll.mock.contexts).toContain(screen.getByRole("region", { name: "路径详情" }));
});

it("keeps the full text open while a selection is dragged outside its box", async () => {
  render(<GoalTitle title="目标" fullTitle="完整目标" />);
  const title = screen.getByRole("button", { name: "目标" });
  fireEvent.mouseEnter(title, { clientX: 200, clientY: 80 });
  const preview = screen.getByRole("tooltip");
  fireEvent.pointerDown(preview);
  fireEvent.mouseLeave(title.closest(".joi-full-title") ?? title);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
  expect(preview).toBeInTheDocument();
});
