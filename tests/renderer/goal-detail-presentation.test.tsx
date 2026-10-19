// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GoalTitle, GoalMap } from "../../src/renderer/GoalDetailPresentation.js";
import type { JoiGoalMapDetailDto } from "../../src/shared/joi.js";
import { configureLocale } from "../../src/renderer/i18n.js";

function titleRoot(trigger: HTMLElement): HTMLElement {
  const root = trigger.closest(".joi-full-title");
  if (!(root instanceof HTMLElement)) throw new Error("Title container is missing");
  return root;
}

it("shows the full safe title on hover and keyboard focus and copies that exact text", async () => {
  const fullTitle = `${"完整目标".repeat(60)}\n最后一条要求`;
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  render(<GoalTitle title="完整目标…" fullTitle={fullTitle} />);
  const title = screen.getByRole("button", { name: "完整目标…" });
  fireEvent.mouseEnter(title);
  expect(screen.getByRole("tooltip")).toHaveTextContent("最后一条要求");
  fireEvent.mouseLeave(titleRoot(title));
  fireEvent.focus(title);
  expect(screen.getByRole("tooltip")).toHaveTextContent("最后一条要求");
  fireEvent.keyDown(title, { key: "F10", shiftKey: true });
  fireEvent.click(screen.getByRole("menuitem", { name: "复制全文" }));
  await waitFor(() => expect(copy).toHaveBeenCalledExactlyOnceWith(fullTitle));
  expect(await screen.findByRole("status")).toHaveTextContent("已复制全文");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("does not copy an abbreviated title and reports clipboard failures", async () => {
  const copy = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  const view = render(<GoalTitle title="目标…" />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "目标…" }));
  expect(screen.getByRole("menuitem", { name: "复制全文" })).toBeDisabled();
  expect(copy).not.toHaveBeenCalled();
  view.rerender(<GoalTitle title="目标…" fullTitle="完整目标" />);
  fireEvent.click(screen.getByRole("menuitem", { name: "复制全文" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("复制失败");
  expect(screen.getByRole("tooltip")).toHaveTextContent("完整目标");
});

it("renders real layers, separates closed paths from failed work and exposes decisions and graduated fog", () => {
  const harness = {
    mapStatus: "ACTIVE" as const, currentLayer: 2, revision: 4, destination: "交付文档",
    pathCount: 2, decisionCount: 1, fogCount: 1,
    paths: [
      { pathId: "p1", layer: 1, title: "资料核对", status: "CLOSED" as const },
      { pathId: "p2", layer: 2, title: "独立验收", status: "CLOSED" as const, workId: "w", workStatus: "FAILED" as const, resolvedDecisionId: "d" },
    ],
    decisions: [{ decisionId: "d", kind: "APPROACH" as const, summary: "采用双语方案", detail: "保留英文和中文", createdAt: "2026-10-19" }],
    fog: [{ fogId: "f", note: "截图是否可行", status: "GRADUATED" as const, graduatedPathId: "p2" }],
  };
  render(<GoalMap harness={harness} />);
  expect(screen.getByRole("region", { name: "目标路线图" })).toBeInTheDocument();
  expect(screen.getByText("第 1 层").closest("details")).not.toHaveAttribute("open");
  expect(screen.getByText("第 2 层").closest("details")).toHaveAttribute("open");
  const path = screen.getByRole("button", { name: /独立验收/u });
  expect(within(path).getByText("已关闭")).toBeInTheDocument();
  expect(within(path).getByText("任务失败")).toBeInTheDocument();
  fireEvent.click(path);
  expect(within(screen.getByRole("region", { name: "路径详情" })).getByText("保留英文和中文")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /雾区/u }));
  expect(screen.getByText("截图是否可行")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看晋升路径" }));
  expect(path).toHaveAttribute("aria-pressed", "true");
});

it("keeps title previews reachable by pointer and closes menus with Escape or an outside click", async () => {
  render(<GoalTitle title="Goal" fullTitle="Full goal text" />);
  const trigger = screen.getByRole("button", { name: "Goal" });
  fireEvent.click(trigger);
  const preview = screen.getByRole("tooltip");
  fireEvent.mouseLeave(titleRoot(trigger));
  fireEvent.mouseEnter(preview);
  expect(preview).toBeInTheDocument();
  fireEvent.keyDown(preview, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.contextMenu(trigger);
  const item = screen.getByRole("menuitem");
  fireEvent.keyDown(item, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.keyDown(trigger, { key: "ContextMenu" });
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.focus(trigger);
  fireEvent.mouseLeave(titleRoot(trigger));
  await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  fireEvent.focus(trigger);
  fireEvent.blur(trigger, { relatedTarget: document.body });
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("renders empty and completed maps and switches localized labels without discarding selection", () => {
  const empty: JoiGoalMapDetailDto = { currentLayer: 0, revision: 0, mapStatus: "CLEARED", pathCount: 0, decisionCount: 0, fogCount: 0, paths: [], decisions: [], fog: [] };
  const view = render(<GoalMap harness={empty} />);
  expect(screen.getByText("地图已收官")).toBeInTheDocument();
  expect(screen.getByText("尚未建立路径。")).toBeInTheDocument();
  expect(screen.getByText("尚未记录决策。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /雾区/u }));
  expect(screen.getByText("尚未记录雾区。")).toBeInTheDocument();
  const harness: JoiGoalMapDetailDto = { ...empty, currentLayer: 1, pathCount: 7, paths: ["PLANNED", "READY", "RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELED"].map((status, index) => ({ pathId: `p${String(index)}`, title: `Path ${String(index)}`, layer: 1,
    status: index === 6 ? "OUT_OF_SCOPE" : "OPEN", workStatus: status as NonNullable<JoiGoalMapDetailDto["paths"][number]["workStatus"]> })), fogCount: 2,
    fog: [{ fogId: "active", note: "还需验证", status: "ACTIVE" }, { fogId: "unloaded", note: "历史探索", status: "GRADUATED", graduatedPathId: "unloaded-path" }] };
  view.rerender(<GoalMap harness={harness} />);
  expect(screen.getByText("待探索")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看晋升路径" })).toBeDisabled();
  const selected = screen.getByRole("button", { name: /Path 2/u });
  fireEvent.click(selected);
  expect(selected).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("范围外")).toBeInTheDocument();
  act(() => configureLocale({ preference: "en", systemLanguages: ["en"] }));
  expect(screen.getByRole("region", { name: "Goal route map" })).toBeInTheDocument();
  expect(selected).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(selected);
  expect(screen.queryByRole("region", { name: "Path details" })).not.toBeInTheDocument();
});
