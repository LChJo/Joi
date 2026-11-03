// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GoalMap } from "../../src/renderer/GoalDetailPresentation.js";
import { configureLocale } from "../../src/renderer/i18n.js";
import type { JoiGoalMapDetailDto, JoiGoalProgressDto } from "../../src/shared/joi.js";
import { useEffect } from "react";

const startedAt = "2026-11-02T00:00:00.000Z";
const progress: JoiGoalProgressDto = {
  state: "QUEUED", stage: "REVIEWING", startedAt, updatedAt: startedAt, turnCount: 16, reviewCount: 8,
  work: { active: 0, total: 38, completed: 35, failed: 2 },
  recentTurns: [{ turnId: "t", stage: "REVIEWING", status: "COMPLETED", startedAt, updatedAt: startedAt }],
};
const harness: JoiGoalMapDetailDto = { revision: 1, currentLayer: 15, mapStatus: "ACTIVE", pathCount: 47, decisionCount: 16,
  fogCount: 4, paths: [], decisions: [], fog: [], progress };

beforeEach(() => configureLocale({ preference: "zh-CN", systemLanguages: ["zh-CN"] }));

it("opens JOI's own live progress from the collapsed goal map and retains the dialog across polling", async () => {
  const parentEscape = vi.fn();
  window.addEventListener("keydown", parentEscape);
  try {
    const view = render(<GoalMap harness={harness} />);
    const trigger = screen.getByRole("button", { name: "查看 JOI 工作进展" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "JOI 工作进展" });
    expect(within(dialog).getByText("等待调度")).toBeVisible();
    expect(within(dialog).getAllByText("评审结果").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("已运行 16 个回合 · 其中 8 次评审")).toBeVisible();
    expect(within(dialog).getByText("最近更新时间")).toBeVisible();
    view.rerender(<GoalMap harness={{ ...harness, progress: { ...progress, state: "RUNNING" } }} />);
    expect(within(dialog).getByText("正在处理")).toBeVisible();
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "关闭进展窗口" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(parentEscape).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.getByRole("button", { name: "展开路线图" })).toHaveAttribute("aria-expanded", "false");
  } finally { window.removeEventListener("keydown", parentEscape); }
});

it("keeps the last progress on refresh failure, exposes retry and does not claim a finished turn is live", () => {
  const retry = vi.fn();
  render(<GoalMap harness={{ ...harness, progress: { ...progress, state: "IDLE" } }} failed onRetry={retry} />);
  fireEvent.click(screen.getByRole("button", { name: "查看 JOI 工作进展" }));
  const dialog = screen.getByRole("dialog", { name: "JOI 工作进展" });
  expect(within(dialog).getByText("等待下一步处理")).toBeVisible();
  expect(within(dialog).getByText("状态刷新失败，当前显示上次成功获取的进展。")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
  expect(retry).toHaveBeenCalledOnce();
});

it("restores page scrolling when the goal details unmount with the progress window open", () => {
  const previous = document.body.style.overflow;
  function GoalDetails() {
    useEffect(() => {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = previous; };
    }, []);
    return <GoalMap harness={harness} />;
  }
  const view = render(<GoalDetails />);
  fireEvent.click(screen.getByRole("button", { name: "查看 JOI 工作进展" }));
  view.unmount();
  try { expect(document.body.style.overflow).toBe(previous); }
  finally { document.body.style.overflow = previous; }
});

it("keeps keyboard focus in the progress window and makes its scrollable facts reachable", () => {
  render(<GoalMap harness={harness} />);
  fireEvent.click(screen.getByRole("button", { name: "查看 JOI 工作进展" }));
  const dialog = screen.getByRole("dialog", { name: "JOI 工作进展" });
  const close = within(dialog).getByRole("button", { name: "关闭进展窗口" });
  const facts = within(dialog).getByRole("region", { name: "JOI 工作进展" });
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(facts).toHaveFocus();
  fireEvent.keyDown(facts, { key: "Tab" });
  expect(close).toHaveFocus();
});

it("shows a safe unavailable state for older detail responses and supports English", () => {
  configureLocale({ preference: "en", systemLanguages: ["en"] });
  const legacy = { ...harness };
  delete legacy.progress;
  render(<GoalMap harness={legacy} />);
  fireEvent.click(screen.getByRole("button", { name: "View JOI progress" }));
  const dialog = screen.getByRole("dialog", { name: "JOI progress" });
  expect(within(dialog).getByText("JOI progress is currently unavailable.")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close progress window" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it.each(["COMPLETED", "FAILED", "CANCELED"] as const)("freezes elapsed time for a %s goal", (state) => {
  render(<GoalMap harness={{ ...harness, progress: { ...progress, state, updatedAt: "2026-11-02T00:01:00.000Z" } }} />);
  fireEvent.click(screen.getByRole("button", { name: "查看 JOI 工作进展" }));
  const dialog = screen.getByRole("dialog", { name: "JOI 工作进展" });
  expect(within(dialog).getByText("任务已用 1 分钟")).toBeVisible();
  expect(within(dialog).queryByText(/未收到新的进展/u)).not.toBeInTheDocument();
});
