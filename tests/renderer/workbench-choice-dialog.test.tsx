// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { JoiHome } from "../../src/renderer/JoiHome.js";
import type { JoiHomeFeedDto, JoiSnapshotDto } from "../../src/shared/joi.js";

function setup() {
  const api = new DigitalLifeApi("");
  const workbench = { workbenchId: "news", name: "资讯调研", scopeSummary: "资讯来源与趋势研究。", updatedAt: "2026-10-15T00:00:00Z" };
  vi.spyOn(api, "joiSnapshot").mockResolvedValue({
    workbenches: [workbench], workbenchChanges: [], partners: [], modelSources: [],
    runtime: { configured: true, status: "READY" }, work: [],
  } satisfies JoiSnapshotDto);
  const feed: JoiHomeFeedDto = { goals: [], thinking: [], unassignedActions: [{
    inputId: "input-choice", acceptedAt: "2026-10-15T00:00:00Z", status: "CLARIFICATION_REQUIRED",
    clarificationReasonCode: "workbench_selection_invalid", questionId: "q1", questionVersion: 1,
    workbenchProposal: { name: "joi 工程维护工坊", projectLabel: "joi", scopeSummary: "joi 源码及文档维护。" },
  }] };
  vi.spyOn(api, "joiHomeFeed").mockResolvedValue(feed);
  return { api, workbench, feed };
}

it("automatically opens a pending choice once, closes without resolving, and reopens from the card", async () => {
  const { api } = setup();
  const clarify = vi.spyOn(api, "clarifyJoiMessage");
  render(<JoiHome api={api} />);
  expect(await screen.findByRole("dialog", { name: "选择工作台" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "稍后选择" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择工作台" })).not.toBeInTheDocument());
  expect(clarify).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "选择工作台" }));
  expect(screen.getByRole("dialog", { name: "选择工作台" })).toBeInTheDocument();
});

it("offers two prepared choices and creates and binds the selected draft in one retryable request", async () => {
  const { api, workbench } = setup();
  const create = vi.spyOn(api, "createWorkbench").mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ...workbench, workbenchId: "code", name: "我的工程工坊" });
  const clarify = vi.spyOn(api, "clarifyJoiMessage");
  render(<JoiHome api={api} />);
  const dialog = await screen.findByRole("dialog", { name: "选择工作台" });
  const prepared = within(dialog).getByRole("group", { name: "选择新工作台方案" });
  expect(within(prepared).getAllByRole("button")).toHaveLength(2);
  expect(within(prepared).getByRole("button", { name: "手动新建" })).toBeInTheDocument();
  expect(screen.queryByLabelText("工作台名称")).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(within(prepared).getByRole("button", { name: "创建 joi 工程维护工坊 并继续" }));
  await screen.findByRole("alert");
  fireEvent.click(within(prepared).getByRole("button", { name: "创建 joi 工程维护工坊 并继续" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择工作台" })).not.toBeInTheDocument());
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "joi 工程维护工坊", projectLabel: "joi", scopeSummary: "joi 源码及文档维护。", bindInputId: "input-choice", questionId: "q1", questionVersion: 1 }));
  expect(create.mock.calls[0]?.[0].idempotencyKey).toBe(create.mock.calls[1]?.[0].idempotencyKey);
  expect(clarify).not.toHaveBeenCalled();
});

it("does not reopen a dismissed question on polling but does offer its next version", async () => {
  vi.useFakeTimers();
  try {
    const { api, feed } = setup();
    render(<JoiHome api={api} />);
    for (let phase = 0; phase < 3; phase += 1) await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole("dialog", { name: "选择工作台" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "稍后选择" }));
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByRole("dialog", { name: "选择工作台" })).not.toBeInTheDocument();
    const first = feed.unassignedActions[0];
    if (first === undefined) throw new Error("missing pending question");
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({ ...feed, unassignedActions: [{ ...first, questionId: "q2", questionVersion: 2 }] });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const dialog = screen.getByRole("dialog", { name: "选择工作台" });
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "稍后选择" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("button", { name: "手动新建" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});

it("keeps the automatic and manual options visible while searching and submits the automatic choice once", async () => {
  const { api, workbench } = setup();
  vi.spyOn(api, "joiSnapshot").mockResolvedValue({
    workbenches: Array.from({ length: 8 }, (_, index) => ({ ...workbench, workbenchId: `w${String(index)}` })),
    workbenchChanges: [], partners: [], modelSources: [], runtime: { configured: true, status: "READY" }, work: [],
  });
  let finish: ((value: typeof workbench) => void) | undefined;
  const create = vi.spyOn(api, "createWorkbench").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<JoiHome api={api} />);
  await screen.findByRole("dialog");
  fireEvent.change(screen.getByLabelText("搜索工作台"), { target: { value: "no matches" } });
  const prepared = screen.getByRole("group", { name: "选择新工作台方案" });
  expect(within(prepared).getAllByRole("button")).toHaveLength(2);
  const choice = within(prepared).getByRole("button", { name: "创建 joi 工程维护工坊 并继续" });
  fireEvent.click(choice);
  fireEvent.click(choice);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "joi 工程维护工坊", projectLabel: "joi", idempotencyKey: "workbench-choice:input-choice:v1:option:0" }));
  expect(within(prepared).getAllByRole("button").every((button) => button.hasAttribute("disabled"))).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await act(() => { finish?.(workbench); return Promise.resolve(); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("opens a blank manual draft without creating, preserves edits across back and retries, and binds once", async () => {
  const { api, workbench } = setup();
  const create = vi.spyOn(api, "createWorkbench").mockRejectedValueOnce(new Error("PRIVATE")).mockResolvedValue(workbench);
  render(<JoiHome api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "手动新建" }));
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByLabelText("工作台名称")).toHaveValue("");
  fireEvent.change(screen.getByLabelText("工作台名称"), { target: { value: "我的项目" } });
  fireEvent.change(screen.getByLabelText("工程名称"), { target: { value: "project" } });
  fireEvent.change(screen.getByLabelText("工作范围"), { target: { value: "代码与测试。" } });
  fireEvent.click(screen.getByRole("button", { name: "返回选择" }));
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "手动新建" }));
  expect(screen.getByLabelText("工作台名称")).toHaveValue("我的项目");
  fireEvent.click(screen.getByRole("button", { name: "创建并继续" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("工作台名称")).toHaveValue("我的项目");
  fireEvent.click(screen.getByRole("button", { name: "创建并继续" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0]?.[0]).toEqual(create.mock.calls[1]?.[0]);
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "我的项目", projectLabel: "project", scopeSummary: "代码与测试。", bindInputId: "input-choice", questionId: "q1", questionVersion: 1, idempotencyKey: "workbench-choice:input-choice:v1:manual" }));
});

it("clears an explicitly selected composer workbench only after a successful send", async () => {
  const { api, workbench } = setup();
  vi.spyOn(api, "joiHomeFeed").mockResolvedValue({ goals: [], thinking: [], unassignedActions: [] });
  const send = vi.spyOn(api, "sendJoiMessage").mockRejectedValueOnce(new Error("offline")).mockResolvedValue({
    inputId: "sent", status: "PENDING", acceptedAt: workbench.updatedAt,
  });
  render(<JoiHome api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "joi 自主分发" }));
  fireEvent.click(screen.getByRole("button", { name: workbench.name }));
  fireEvent.change(screen.getByLabelText("给 joi 输入"), { target: { value: "第一条任务" } });
  fireEvent.click(screen.getByRole("button", { name: "交给 joi" }));
  await waitFor(() => expect(screen.getByLabelText("给 joi 输入")).toHaveValue("第一条任务"));
  expect(screen.getByRole("button", { name: `分发给 ${workbench.name}` })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "交给 joi" }));
  await screen.findByRole("button", { name: "joi 自主分发" });
  fireEvent.change(screen.getByLabelText("给 joi 输入"), { target: { value: "第二条任务" } });
  fireEvent.click(screen.getByRole("button", { name: "交给 joi" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  expect(send.mock.calls[1]?.[1]).toMatchObject({ workbenchId: "news" });
  expect(send.mock.calls[2]?.[1]).toEqual({});
});
