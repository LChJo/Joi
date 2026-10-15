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

it("edits the persistent draft and creates and binds in one retryable request", async () => {
  const { api, workbench } = setup();
  const create = vi.spyOn(api, "createWorkbench").mockRejectedValueOnce(new Error("network")).mockResolvedValue({ ...workbench, workbenchId: "code", name: "我的工程工坊" });
  const clarify = vi.spyOn(api, "clarifyJoiMessage");
  render(<JoiHome api={api} />);
  await screen.findByRole("dialog", { name: "选择工作台" });
  fireEvent.click(screen.getByRole("button", { name: "新建工作台" }));
  expect(screen.getByLabelText("工作台名称")).toHaveValue("joi 工程维护工坊");
  fireEvent.change(screen.getByLabelText("工作台名称"), { target: { value: "我的工程工坊" } });
  fireEvent.click(screen.getByRole("button", { name: "创建并继续" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("工作台名称")).toHaveValue("我的工程工坊");
  fireEvent.click(screen.getByRole("button", { name: "创建并继续" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择工作台" })).not.toBeInTheDocument());
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "我的工程工坊", bindInputId: "input-choice", questionId: "q1", questionVersion: 1 }));
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
    expect(within(dialog).getByRole("button", { name: "新建工作台" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  } finally { vi.useRealTimers(); }
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
