// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DigitalLifeApi } from "../../src/renderer/api";
import { AutomationPanel } from "../../src/renderer/AutomationPanel";
import type { AutomationDto } from "../../src/shared/automation";

const routine: AutomationDto = {
  createdAt: "2026-01-01T00:00:00.000Z", enabled: true,
  frequency: { kind: "cycle", localTime: "09:00", unit: "week", daysOfWeek: [0, 4] }, lifecycle: "ACTIVE", name: "早间检查",
  nextRunAt: "2026-01-02T09:00:00.000Z", promptConfigured: true, routineId: "routine_1", workbenchId: "workbench_1",
  runs: [{ inputId: "input_1", occurrenceAt: "2026-01-01T09:00:00.000Z", result: "PENDING", runId: "run_1", mergeCount: 1, status: "PENDING", triggeredAt: "2026-01-01T09:00:00.000Z" }],
  target: { kind: "NEW_GOAL" },
};

const continuationRoutine: AutomationDto = {
  ...routine,
  name: "继续登录研究",
  routineId: "routine_continuation",
  runs: [],
  target: { goalId: "goal-running", kind: "GOAL_CONTINUATION" },
};

function mockApi() {
  const api = new DigitalLifeApi("");
  const listAutomations = vi.spyOn(api, "listAutomations").mockResolvedValue({ items: [routine] });
  vi.spyOn(api, "listWorkbenches").mockResolvedValue({ items: [{ name: "产品工作", scopeSummary: "scope", updatedAt: routine.createdAt, workbenchId: "workbench_1" }] });
  vi.spyOn(api, "listPartners").mockResolvedValue({ items: [{
    capabilities: [], createdBy: "user", displayName: "研究搭档", engine: "pi-core", inFlightCount: 0, kind: "a2a", knowledgeDocCount: 0,
    lifecyclePolicy: "DRAIN", partnerId: "partner_1", partnerRevisionId: "revision_1", registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
  }] });
  vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
    goals: [{
      agentCount: 1, canDelete: false, goalId: "goal-running", status: "RUNNING", title: "持续研究登录方案",
      updatedAt: routine.createdAt, work: { active: 1, completed: 0, failed: 0, total: 1 },
      workbench: { name: "产品工作", workbenchId: "workbench_1" },
    }],
    thinking: [], unassignedActions: [],
  });
  const createAutomation = vi.spyOn(api, "createAutomation").mockResolvedValue(routine);
  const updateAutomation = vi.spyOn(api, "updateAutomation").mockResolvedValue(routine);
  const revealAutomationPrompt = vi.spyOn(api, "revealAutomationPrompt").mockResolvedValue({ prompt: "秘密提示词" });
  const runAutomationNow = vi.spyOn(api, "runAutomationNow").mockResolvedValue(routine);
  const deleteAutomation = vi.spyOn(api, "deleteAutomation").mockResolvedValue(undefined);
  return { api, createAutomation, deleteAutomation, listAutomations, revealAutomationPrompt, runAutomationNow, updateAutomation };
}

function formOf(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Expected a form.");
  return form;
}

function inputOf(form: HTMLFormElement, name: string): HTMLInputElement {
  const input = form.querySelector<HTMLInputElement>(`[name=${name}]`);
  if (input === null) throw new Error(`Missing ${name} input.`);
  return input;
}

describe("AutomationPanel", () => {
  it("creates, reveals, edits, toggles, runs and deletes a Routine", async () => {
    const fixture = mockApi();
    const onOpenJoi = vi.fn();
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<AutomationPanel api={fixture.api} onOpenJoi={onOpenJoi} />);
    expect(await screen.findByRole("heading", { name: "定时任务" })).toBeInTheDocument();
    expect(screen.queryByText("秘密提示词")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "新建定时任务" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新的任务" } });
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "每周检查" } });
    fireEvent.submit(formOf(screen.getByRole("button", { name: "保存" })));
    await waitFor(() => expect(fixture.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ name: "新的任务", prompt: "每周检查" })));

    fireEvent.click(screen.getByRole("button", { name: "查看提示词" }));
    const editor = await screen.findByLabelText("提示词");
    expect(editor).toHaveValue("秘密提示词");
    fireEvent.submit(formOf(editor));
    await waitFor(() => expect(fixture.updateAutomation).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(fixture.updateAutomation).toHaveBeenCalledWith("routine_1", { enabled: false }));
    fireEvent.click(screen.getByRole("button", { name: "立即执行" }));
    await waitFor(() => expect(fixture.runAutomationNow).toHaveBeenCalledWith("routine_1"));
    fireEvent.click(screen.getByRole("button", { name: "查看 Joi 目标" }));
    expect(onOpenJoi).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(fixture.deleteAutomation).toHaveBeenCalledWith("routine_1"));
    expect(fixture.listAutomations).toHaveBeenCalled();
  });

  it("shows empty and failure states and lets users cancel the editor", async () => {
    const fixture = mockApi();
    fixture.listAutomations.mockResolvedValueOnce({ items: [] });
    render(<AutomationPanel api={fixture.api} />);
    expect(await screen.findByText("还没有定时任务。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建定时任务" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fixture.listAutomations.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "新建定时任务" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "失败任务" } });
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "检查" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByText("定时任务未保存。")).toBeInTheDocument());
  });

  it("creates a goal continuation from any live card and derives its Workbench", async () => {
    const fixture = mockApi();
    render(<AutomationPanel api={fixture.api} initialGoalId="goal-running" />);

    expect(await screen.findByLabelText("任务类型")).toHaveValue("GOAL_CONTINUATION");
    expect(screen.getByLabelText("关联任务")).toHaveValue("goal-running");
    expect(screen.getByText("运行中的任务会等到收官后再继续，错过的触发会合并一次。")).toBeInTheDocument();
    expect(screen.queryByLabelText("Workbench")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("偏好搭档")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "继续登录研究" } });
    fireEvent.change(screen.getByLabelText("续聊指令"), { target: { value: "继续核对最新证据" } });
    fireEvent.submit(formOf(screen.getByRole("button", { name: "保存" })));
    await waitFor(() => expect(fixture.createAutomation).toHaveBeenCalledWith(expect.objectContaining({
      name: "继续登录研究",
      prompt: "继续核对最新证据",
      target: { goalId: "goal-running", kind: "GOAL_CONTINUATION" },
    })));
    const payload = fixture.createAutomation.mock.calls.at(-1)?.[0];
    expect(payload).not.toHaveProperty("workbenchId");
  });

  it("edits an idle continuation target and locks a waiting target", async () => {
    const fixture = mockApi();
    fixture.listAutomations.mockResolvedValue({ items: [continuationRoutine] });
    const view = render(<AutomationPanel api={fixture.api} />);

    expect(await screen.findByText("继续：持续研究登录方案", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("任务类型")).toHaveValue("GOAL_CONTINUATION");
    expect(screen.getByLabelText("关联任务")).toHaveValue("goal-running");
    fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "NEW_GOAL" } });
    expect(screen.getByLabelText("Workbench")).toBeInTheDocument();
    fireEvent.submit(formOf(screen.getByRole("button", { name: "保存" })));
    await waitFor(() => expect(fixture.updateAutomation).toHaveBeenCalledWith("routine_continuation", expect.objectContaining({
      target: { kind: "NEW_GOAL" },
      workbenchId: "workbench_1",
    })));

    view.unmount();
    fixture.listAutomations.mockResolvedValue({ items: [{
      ...continuationRoutine,
      runs: [{ mergeCount: 1, occurrenceAt: routine.createdAt, reasonCode: "goal_not_finished", result: "BLOCKED", runId: "run-waiting", status: "BLOCKED", triggeredAt: routine.createdAt }],
    }] });
    render(<AutomationPanel api={fixture.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("任务类型")).toBeDisabled();
    expect(screen.getByLabelText("关联任务")).toBeDisabled();
  });

  it("submits interval, once and RRULE forms and reports operation failures", async () => {
    const fixture = mockApi();
    render(<AutomationPanel api={fixture.api} />);
    await screen.findByRole("heading", { name: "定时任务" });

    const submitNew = async (kind: string, extra: (form: HTMLFormElement) => void = () => undefined) => {
      fireEvent.click(screen.getByRole("button", { name: "新建定时任务" }));
      fireEvent.change(screen.getByLabelText("名称"), { target: { value: `${kind} task` } });
      fireEvent.change(screen.getByLabelText("提示词"), { target: { value: `${kind} prompt` } });
      fireEvent.change(screen.getByLabelText("频率"), { target: { value: kind } });
      const form = formOf(screen.getByRole("button", { name: "保存" }));
      extra(form);
      fireEvent.submit(form);
      await waitFor(() => {
        const last = fixture.createAutomation.mock.calls[fixture.createAutomation.mock.calls.length - 1]?.[0];
        expect(last?.frequency.kind).toBe(kind);
      });
    };

    await submitNew("interval");
    await submitNew("once", (form) => fireEvent.change(inputOf(form, "at"), { target: { value: "2026-01-03T09:00" } }));
    await submitNew("rrule", (form) => {
      fireEvent.change(inputOf(form, "rule"), { target: { value: "FREQ=DAILY" } });
      fireEvent.change(inputOf(form, "dtStart"), { target: { value: "2026-01-03T09:00" } });
    });

    fixture.revealAutomationPrompt.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "查看提示词" }));
    await waitFor(() => expect(screen.getByText("提示词未读取。")).toBeInTheDocument());
    fixture.updateAutomation.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    await waitFor(() => expect(screen.getByText("定时任务状态未更新。")).toBeInTheDocument());
    fixture.runAutomationNow.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "立即执行" }));
    await waitFor(() => expect(screen.getByText("定时任务未执行。")).toBeInTheDocument());
    vi.stubGlobal("confirm", vi.fn(() => false));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(fixture.deleteAutomation).not.toHaveBeenCalled();
    vi.stubGlobal("confirm", vi.fn(() => true));
    fixture.deleteAutomation.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getByText("定时任务未删除。")).toBeInTheDocument());
  });

  it("shows only the configuration fields for the selected frequency", async () => {
    const fixture = mockApi();
    render(<AutomationPanel api={fixture.api} />);
    await screen.findByRole("heading", { name: "定时任务" });
    fireEvent.click(screen.getByRole("button", { name: "新建定时任务" }));

    expect(screen.getByLabelText("周期单位")).toBeInTheDocument();
    expect(screen.getByLabelText("本地时间")).toBeInTheDocument();
    expect(screen.queryByText("星期（周一为 0）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("月日")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("间隔小时")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("一次时间")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("RRULE")).not.toBeInTheDocument();

    const frequency = screen.getByLabelText("频率");
    fireEvent.change(frequency, { target: { value: "interval" } });
    expect(screen.getByLabelText("间隔小时")).toBeInTheDocument();
    expect(screen.queryByLabelText("周期单位")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("本地时间")).not.toBeInTheDocument();
    expect(screen.queryByText("星期（周一为 0）")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("月日")).not.toBeInTheDocument();

    fireEvent.change(frequency, { target: { value: "once" } });
    expect(screen.getByLabelText("一次时间")).toBeInTheDocument();
    expect(screen.queryByLabelText("间隔小时")).not.toBeInTheDocument();

    fireEvent.change(frequency, { target: { value: "rrule" } });
    expect(screen.getByLabelText("RRULE")).toBeInTheDocument();
    expect(screen.getByLabelText("RRULE 起点")).toBeInTheDocument();
    expect(screen.queryByLabelText("一次时间")).not.toBeInTheDocument();

    fireEvent.change(frequency, { target: { value: "cycle" } });
    fireEvent.change(screen.getByLabelText("周期单位"), { target: { value: "week" } });
    expect(screen.getByText("星期（周一为 0）")).toBeInTheDocument();
    expect(screen.queryByLabelText("月日")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("周期单位"), { target: { value: "month" } });
    expect(screen.getByLabelText("月日")).toBeInTheDocument();
    expect(screen.queryByText("星期（周一为 0）")).not.toBeInTheDocument();
  });

  it("shows a load error and a saved editor preview without a next run", async () => {
    const fixture = mockApi();
    fixture.listAutomations.mockRejectedValueOnce(new Error("offline"));
    render(<AutomationPanel api={fixture.api} />);
    expect(await screen.findByText("没能读取定时任务。")).toBeInTheDocument();

    const { nextRunAt: omittedNextRunAt, ...routineWithoutNextRun } = routine;
    void omittedNextRunAt;
    const noNextRun: AutomationDto = { ...routineWithoutNextRun, runs: [] };
    fixture.listAutomations.mockResolvedValue({ items: [noNextRun] });
    fireEvent.click(screen.getByRole("button", { name: "新建定时任务" }));
    expect(screen.getByLabelText("下次执行预览")).toHaveTextContent("保存后显示下次执行时间");
  });
});
