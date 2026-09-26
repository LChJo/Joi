// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { DigitalLifeApi } from "../../src/renderer/api";
import { StatisticsPage } from "../../src/renderer/StatisticsPage";
import { JoiHome } from "../../src/renderer/JoiHome";
import type { StatisticsDto, UsageTotals } from "../../src/shared/statistics";

const totals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({
  cacheKnownRecords: 1,
  cacheRead: 120,
  cacheWrite: 20,
  failedRecords: 1,
  input: 1_200,
  knownRecords: 2,
  output: 430,
  reasoning: 80,
  reasoningKnownRecords: 1,
  records: 3,
  total: 1_630,
  unknownRecords: 1,
  ...overrides,
});

function statistics(overrides: Partial<StatisticsDto> = {}): StatisticsDto {
  return {
    collectedSince: "2026-08-01T00:00:00.000Z",
    collectionDegraded: false,
    daily: [
      { ...totals(), date: "2026-09-21" },
      { ...totals({ input: 0, output: 0, total: 0, records: 1, knownRecords: 0, unknownRecords: 1 }), date: "2026-09-22" },
    ],
    filters: {
      models: [{ engine: "codex", modelId: "gpt-5", modelKey: "codex:gpt-5", sourceName: "Codex" }],
      workbenches: [{ archived: false, name: "统计设计", workbenchId: "workbench-stats" }],
    },
    goals: [{ ...totals(), goalId: "goal-statistics", status: "completed", title: "完成统计前端", workbenchId: "workbench-stats", workbenchName: "统计设计" }],
    hourly: [{ ...totals(), hour: 9, weekday: 1 }],
    models: [{ ...totals(), engine: "codex", modelId: "gpt-5", modelKey: "codex:gpt-5", sourceName: "Codex" }],
    overview: { ...totals(), completedGoals: 7 },
    purposes: [{ ...totals(), purpose: "orchestration" }],
    query: { from: "2026-08-24", timeZone: "Asia/Shanghai", to: "2026-09-22" },
    updatedAt: "2026-09-22T08:00:00.000Z",
    workbenches: [{ ...totals(), archived: false, completedGoals: 7, failedGoals: 1, name: "统计设计", waitingGoals: 2, workbenchId: "workbench-stats" }],
    ...overrides,
  };
}

function setup(dto = statistics()) {
  const api = new DigitalLifeApi("");
  const request = vi.spyOn(api, "statistics").mockResolvedValue(dto);
  const openGoal = vi.fn();
  render(<StatisticsPage api={api} onOpenGoal={openGoal} />);
  return { api, openGoal, request };
}

// jsdom reports zero-sized rects; the tooltip skips zero-area triggers, so give it a real box.
const box = (x: number, y: number, width: number, height: number): DOMRect => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) });

describe("statistics page", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-09-22T08:00:00.000Z")));
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("renders all seven calm data panels and preserves unknown usage semantics", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "用量统计" })).toBeInTheDocument();
    for (const name of ["每日趋势", "切换日历与时段", "模型排行", "用途构成", "工作台", "目标 Top 10", "数据完整性"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getAllByText("未知").length).toBeGreaterThan(0);
    expect(screen.getByText("统计设计 · 已完成")).toBeInTheDocument();
    expect(screen.queryByText(/价格|费用|美元|¥|\$/u)).not.toBeInTheDocument();
    expect(document.querySelectorAll(".statistics-bar-input").length).toBe(2);
    fireEvent.click(screen.getByText("查看每日数据表"));
    expect(screen.getByRole("table", { name: "每日 Token 明细" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "时段热图" }));
    fireEvent.click(screen.getByText("查看时段数据表"));
    expect(screen.getByRole("table", { name: "星期小时 Token 明细" })).toBeInTheDocument();
  });

  it("updates the whole-page query from presets and the workbench dropdown", async () => {
    const { request } = setup();
    await screen.findByRole("heading", { name: "用量统计" });
    fireEvent.click(screen.getByRole("button", { name: "最近 7 天" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2026-09-16", to: "2026-09-22" })));

    fireEvent.change(screen.getByRole("combobox", { name: "工作台" }), { target: { value: "workbench-stats" } });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ workbenchId: "workbench-stats" })));
  });

  it("switches the trend to hourly buckets for a single-day range", async () => {
    setup();
    await screen.findByRole("heading", { name: "用量统计" });
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    expect(await screen.findByRole("img", { name: "当日每小时 Token 趋势图" })).toBeInTheDocument();
    expect(screen.getByText("查看每小时数据表")).toBeInTheDocument();
  });

  it("shows calendar day usage as a hover tooltip instead of a click drilldown", async () => {
    setup();
    await screen.findByRole("heading", { name: "用量统计" });
    const day = screen.getByRole("img", { name: /^2026-09-21/u });
    expect(day.tagName).toBe("SPAN");
    expect(day).not.toHaveAttribute("title");
    expect(day).toHaveAttribute("aria-label", expect.stringContaining("Token"));
    expect(screen.queryByRole("region", { name: "当日明细" })).not.toBeInTheDocument();
  });

  it("renders a styled popup tooltip on hover and hides it on leave", async () => {
    setup();
    await screen.findByRole("heading", { name: "用量统计" });
    const day = screen.getByRole("img", { name: /^2026-09-21/u });
    day.getBoundingClientRect = () => box(100, 100, 24, 24);
    fireEvent.mouseOver(day);
    const popup = await screen.findByText(/2026-09-21 · 总/u);
    expect(popup).toHaveClass("app-tooltip");
    fireEvent.mouseOut(day);
    expect(screen.queryByText(/2026-09-21 · 总/u)).not.toBeInTheDocument();
  });

  it("presents model ranking rows as hover info instead of page filters", async () => {
    const { request } = setup();
    await screen.findByRole("heading", { name: "用量统计" });
    expect(screen.queryByRole("button", { name: /筛选模型/u })).not.toBeInTheDocument();
    const row = screen.getByLabelText(/Codex \/ gpt-5/u);
    expect(row.tagName).toBe("DIV");
    expect(row).toHaveAttribute("aria-label", expect.stringContaining("占比"));
    const before = request.mock.calls.length;
    fireEvent.click(row);
    expect(request.mock.calls.length).toBe(before);
  });

  it("presents purpose and workbench rows as hover info instead of page filters", async () => {
    const { request } = setup();
    await screen.findByRole("heading", { name: "用量统计" });
    expect(screen.queryByRole("button", { name: /筛选工作台/u })).not.toBeInTheDocument();
    const purpose = screen.getByLabelText(/^编排/u);
    expect(purpose.tagName).toBe("DIV");
    expect(purpose).toHaveAttribute("aria-label", expect.stringContaining("占比"));
    const before = request.mock.calls.length;
    fireEvent.click(purpose);
    expect(request.mock.calls.length).toBe(before);
  });

  it("adds a hover tooltip to ranked goals while keeping click navigation", async () => {
    const { openGoal } = setup();
    await screen.findByRole("heading", { name: "用量统计" });
    const goal = screen.getByRole("button", { name: "打开目标 完成统计前端" });
    goal.getBoundingClientRect = () => box(50, 200, 100, 40);
    fireEvent.mouseOver(goal);
    expect(await screen.findByText(/完成统计前端 · 统计设计/u)).toHaveClass("app-tooltip");
    fireEvent.click(goal);
    expect(openGoal).toHaveBeenCalledWith("goal-statistics");
  });

  it("marks a fully unknown day with a hatched stub instead of a stray placeholder", async () => {
    setup();
    await screen.findByRole("heading", { name: "用量统计" });
    expect(document.querySelectorAll(".statistics-bar-unknown")).toHaveLength(1);
    expect(screen.queryByText("?")).not.toBeInTheDocument();
  });

  it("opens a ranked goal and keeps prior data visible when refresh fails", async () => {
    const { openGoal, request } = setup();
    await screen.findByText("完成统计前端");
    fireEvent.click(screen.getByRole("button", { name: "打开目标 完成统计前端" }));
    expect(openGoal).toHaveBeenCalledWith("goal-statistics");

    request.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "刷新统计" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保留上次");
    expect(screen.getByText("完成统计前端")).toBeInTheDocument();
  });

  it("uses a rolling past year and aligns calendar weeks with Monday", async () => {
    const { request } = setup();
    await screen.findByRole("heading", { name: "用量统计" });
    fireEvent.click(screen.getByRole("button", { name: "过去一年" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2025-09-23", to: "2026-09-22" })));
    expect(screen.getByRole("group", { name: "日期用量热图" })).toHaveTextContent("周一");
  });

  it("explains when a statistics goal was removed instead of silently returning home", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ workbenchChanges: [], workbenches: [], partners: [], modelSources: [], work: [], runtime: { configured: true, status: "READY" } });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({ goals: [], thinking: [], unassignedActions: [] });
    render(<JoiHome api={api} focusGoalId="removed-goal" />);
    expect(await screen.findByText("目标已移除或不可用，历史用量仍保留。")).toBeInTheDocument();
  });

  it("polls every 15 seconds only while visible and ignores stale responses", async () => {
    vi.useFakeTimers();
    let visible = true;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visible ? "visible" : "hidden");
    const api = new DigitalLifeApi("");
    let resolveFirst: ((value: StatisticsDto) => void) | undefined;
    const first = new Promise<StatisticsDto>((resolve) => { resolveFirst = resolve; });
    const request = vi.spyOn(api, "statistics")
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(statistics({ overview: { ...totals(), completedGoals: 9 } }));
    render(<StatisticsPage api={api} onOpenGoal={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); await Promise.resolve(); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(within(screen.getByLabelText("统计概览")).getByText("9")).toBeInTheDocument();
    await act(async () => { resolveFirst?.(statistics({ overview: { ...totals(), completedGoals: 1 } })); await Promise.resolve(); });
    expect(within(screen.getByLabelText("统计概览")).getByText("9")).toBeInTheDocument();

    visible = false;
    await act(async () => { fireEvent(document, new Event("visibilitychange")); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("handles first-load failure and retry without fabricating zeros", async () => {
    const api = new DigitalLifeApi("");
    const request = vi.spyOn(api, "statistics").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(statistics());
    render(<StatisticsPage api={api} onOpenGoal={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "重新加载统计" }));
    expect(await screen.findByRole("heading", { name: "用量统计" })).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an empty period from a period with unknown usage", async () => {
    const { request } = setup(statistics({ overview: { ...totals({ records: 0, knownRecords: 0, unknownRecords: 0, total: 0, input: 0, output: 0 }), completedGoals: 0 }, daily: [], models: [], goals: [], workbenches: [], hourly: [], purposes: [] }));
    expect(await screen.findByText("这个范围还没有记录")).toBeInTheDocument();
    request.mockResolvedValue(statistics({ collectionDegraded: true, overview: { ...totals({ knownRecords: 0, unknownRecords: 3, total: 0, input: 0, output: 0 }), completedGoals: 0 } }));
    fireEvent.click(screen.getByRole("button", { name: "刷新统计" }));
    expect(await screen.findByText(/曾发生采集失败/u)).toBeInTheDocument();
    expect(within(screen.getByLabelText("统计概览")).getAllByText("未知")).toHaveLength(3);
  });

  it("rejects invalid custom ranges and clears model, purpose and workbench filters", async () => {
    const { request } = setup();
    await screen.findByRole("heading", { name: "用量统计" });
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2020-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("最多 366 天");
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "" } });
    expect(screen.getByRole("alert")).toHaveTextContent("完整");
    fireEvent.click(screen.getByRole("button", { name: "最近 30 天" }));
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2020-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("不能早于");
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    fireEvent.change(screen.getByLabelText("用途"), { target: { value: "evolution" } });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ purpose: "evolution" })));
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(request).toHaveBeenLastCalledWith({ from: "2026-09-22", to: "2026-09-22", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
  });

  it("lets both custom dates move into a historical year without querying an invalid intermediate range", async () => {
    const { request } = setup();
    await screen.findByRole("heading", { name: "用量统计" });
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2024-03-01" } });
    expect(screen.getByLabelText("开始日期")).toHaveValue("2024-03-01");
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2024-03-31" } });
    await waitFor(() => expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ from: "2024-03-01", to: "2024-03-31" })));
  });
});
