// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkbenchEvolutionPanel } from "../../src/renderer/EvolutionSettings";
import { DigitalLifeApi } from "../../src/renderer/api";
import type { EvolutionLearningDto, EvolutionOverviewDto, EvolutionReason, EvolutionStatusDto } from "../../src/shared/evolution";
import { DEFAULT_EVOLUTION_DAILY_CALL_LIMIT } from "../../src/shared/evolution";

const status: EvolutionStatusDto = { workbenchId: "a", dailyCallLimit: DEFAULT_EVOLUTION_DAILY_CALL_LIMIT, callsUsedToday: 0, evidenceCount: 4, evaluableCount: 2, poolEvaluable: 7, poolVerificationFailed: 2, activeRevisionId: null, reason: "collecting", runRequestedAt: null, lastVerdict: null, versions: [] };
it("shows a retryable notice when the evolution status cannot be read", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockRejectedValue(new Error("private"));
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("没能读取进化状态，请稍后重试。")).toBeInTheDocument();
});

const learning: EvolutionLearningDto = {
  version: 2, evaluatorVersion: "method-evaluator-v2", stage: "OBSERVING", blockers: ["no_reproducible_case"],
  globalBudget: { enabled: false, paused: true, dailyCallLimit: 150, callsUsedToday: 12, tokensToday: null },
  participation: { enabled: false, paused: true }, cases: { development: 2, sealed: 1, defects: 1 },
  experiment: null, appliedGoals: 0, methods: [],
};
function learningApi(value: EvolutionLearningDto = learning) {
  const api = new DigitalLifeApi("");
  const overview = { workbenches: 3, enabled: 1, evaluating: 0, canary: 0, active: 0,
    revalidationRequired: 0, poolEvaluable: 7, poolVerificationFailed: 2, batches: [], learning: value };
  const loadStatus = vi.spyOn(api, "evolutionStatus").mockResolvedValue({ ...status, learning: value });
  const loadOverview = vi.spyOn(api, "evolutionOverview").mockResolvedValue(overview);
  return { api, overview, loadStatus, loadOverview };
}
it("changes the shared global cap without enabling or resuming a disabled participant", async () => {
  const { api, overview } = learningApi();
  const global = vi.spyOn(api, "configureGlobalEvolution").mockResolvedValue({ ...overview, learning: { ...learning,
    globalBudget: { ...learning.globalBudget, dailyCallLimit: 50 } } });
  const local = vi.spyOn(api, "configureEvolution");
  const resume = vi.spyOn(api, "resumeEvolution");
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  fireEvent.click(await screen.findByRole("radio", { name: "低（每日 50 次）" }));
  await waitFor(() => expect(global).toHaveBeenCalledWith(false, 50));
  expect(local).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "本工作台参与方法学习" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "立即评测一次" })).toBeDisabled();
});
it("explicitly resumes global and workbench learning without changing the cap or participation", async () => {
  const { api, overview } = learningApi();
  const global = vi.spyOn(api, "resumeGlobalEvolution").mockResolvedValue(overview);
  const local = vi.spyOn(api, "resumeEvolution").mockResolvedValue({ ...status, learning });
  const configure = vi.spyOn(api, "configureGlobalEvolution");
  const participate = vi.spyOn(api, "setEvolutionParticipation");
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  fireEvent.click(await screen.findByRole("button", { name: "恢复全局方法学习" }));
  await waitFor(() => expect(global).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "恢复本工作台方法学习" }));
  await waitFor(() => expect(local).toHaveBeenCalledWith("a"));
  expect(configure).not.toHaveBeenCalled();
  expect(participate).not.toHaveBeenCalled();
});
it("enables shared learning independently while preserving an explicit pause", async () => {
  const { api, overview } = learningApi();
  const global = vi.spyOn(api, "configureGlobalEvolution").mockResolvedValue({ ...overview, learning: {
    ...learning, globalBudget: { ...learning.globalBudget, enabled: true } } });
  const resume = vi.spyOn(api, "resumeGlobalEvolution");
  const participate = vi.spyOn(api, "setEvolutionParticipation");
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "启用全局方法学习" }));
  await waitFor(() => expect(global).toHaveBeenCalledWith(true, 150));
  expect(resume).not.toHaveBeenCalled();
  expect(participate).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "立即评测一次" })).toBeDisabled();
});
it("changes participation independently and shows production methods and exposure", async () => {
  const value: EvolutionLearningDto = { ...learning, stage: "CANARY", methods: [{ revisionId: "method1", scope: "GLOBAL",
    module: "planning", status: "CANARY", createdAt: "2026-10-23", benefit: "efficiency", baselineSuccesses: 15,
    candidateSuccesses: 15, evaluatedRuns: 15, candidateGoals: 2, controlGoals: 8 }], appliedGoals: 2 };
  const { api } = learningApi(value);
  const participate = vi.spyOn(api, "setEvolutionParticipation").mockResolvedValue({ ...status, learning: {
    ...value, participation: { enabled: true, paused: true } } });
  const run = vi.spyOn(api, "runEvolutionNow");
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("效率收益")).toBeInTheDocument();
  expect(screen.getByText(/候选目标 2 · 对照目标 8/u)).toBeInTheDocument();
  expect(screen.getByText(/实际采用方法的目标：2/u)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "本工作台参与方法学习" }));
  await waitFor(() => expect(participate).toHaveBeenCalledWith("a", true));
  expect(run).not.toHaveBeenCalled();
});
it("sends explicit global settings, resume and participation operations to the business API", async () => {
  const api = new DigitalLifeApi("");
  const request = vi.spyOn(api, "request").mockResolvedValue({});
  await api.configureGlobalEvolution(false, 150);
  await api.resumeGlobalEvolution();
  await api.resumeEvolution("a/b");
  await api.setEvolutionParticipation("a/b", false);
  expect(request.mock.calls).toEqual([
    ["/api/v1/evolution", { method: "PATCH", body: { enabled: false, dailyCallLimit: 150 } }],
    ["/api/v1/evolution/resume", { method: "POST" }],
    ["/api/v1/workbenches/a%2Fb/evolution/resume", { method: "POST" }],
    ["/api/v1/workbenches/a%2Fb/evolution", { method: "PATCH", body: { enabled: false } }],
  ]);
});

const readyLearning: EvolutionLearningDto = { ...learning, stage: "DEVELOP", blockers: [],
  globalBudget: { enabled: true, paused: false, dailyCallLimit: 150, callsUsedToday: 12, tokensToday: 1234 },
  participation: { enabled: true, paused: false } };
function pendingValue<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise not initialized."); };
  let reject: (reason: unknown) => void = () => { throw new Error("Promise not initialized."); };
  const promise = new Promise<T>((release, fail) => { resolve = release; reject = fail; });
  return { promise, resolve, reject };
}
it("enables a zero shared budget with the default cap and explicitly turns the shared budget off", async () => {
  const value = { ...readyLearning, globalBudget: { ...readyLearning.globalBudget, enabled: false, dailyCallLimit: 0 } };
  const { api, overview } = learningApi(value);
  const save = vi.spyOn(api, "configureGlobalEvolution").mockImplementation((enabled, dailyCallLimit) => Promise.resolve({ ...overview,
    learning: { ...value, globalBudget: { ...value.globalBudget, enabled, dailyCallLimit } } }));
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "启用全局方法学习" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(true, 150));
  await waitFor(() => expect(screen.getByRole("button", { name: "立即评测一次" })).toBeEnabled());
  fireEvent.click(screen.getByRole("radio", { name: "高（每日 400 次）" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(true, 400));
  await waitFor(() => expect(screen.getByRole("radio", { name: "高（每日 400 次）" })).toBeChecked());
  fireEvent.click(screen.getByRole("radio", { name: "关（只记录经验）" }));
  await waitFor(() => expect(save).toHaveBeenLastCalledWith(false, 0));
  await waitFor(() => expect(screen.getByRole("button", { name: "立即评测一次" })).toBeDisabled());
  expect(screen.getByRole("checkbox", { name: "启用全局方法学习" })).not.toBeChecked();
});
it("shows failed resume attempts and enables evaluation only after both paused scopes recover", async () => {
  const paused = { ...readyLearning, globalBudget: { ...readyLearning.globalBudget, paused: true }, participation: { enabled: true, paused: true } };
  const { api, overview } = learningApi(paused);
  const global = vi.spyOn(api, "resumeGlobalEvolution").mockRejectedValueOnce(new Error("private"))
    .mockResolvedValue({ ...overview, learning: { ...paused, globalBudget: readyLearning.globalBudget } });
  const local = vi.spyOn(api, "resumeEvolution").mockRejectedValueOnce(new Error("private"))
    .mockResolvedValue({ ...status, learning: readyLearning });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  fireEvent.click(await screen.findByRole("button", { name: "恢复全局方法学习" }));
  await screen.findByText("没能更新方法学习，请刷新后重试。");
  expect(screen.getByRole("button", { name: "立即评测一次" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "恢复全局方法学习" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "恢复全局方法学习" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "恢复本工作台方法学习" }));
  await screen.findByText("没能更新方法学习，请刷新后重试。");
  fireEvent.click(screen.getByRole("button", { name: "恢复本工作台方法学习" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "立即评测一次" })).toBeEnabled());
  expect(global).toHaveBeenCalledTimes(2);
  expect(local).toHaveBeenCalledTimes(2);
});
it("keeps failed participation changes visible and stops scheduling after opting out", async () => {
  const { api } = learningApi(readyLearning);
  const save = vi.spyOn(api, "setEvolutionParticipation").mockRejectedValueOnce(new Error("private"))
    .mockResolvedValue({ ...status, learning: { ...readyLearning, participation: { enabled: false, paused: false } } });
  const run = vi.spyOn(api, "runEvolutionNow");
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "本工作台参与方法学习" }));
  await screen.findByText("没能更新方法学习，请刷新后重试。");
  expect(screen.getByRole("checkbox", { name: "本工作台参与方法学习" })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: "本工作台参与方法学习" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "本工作台参与方法学习" })).not.toBeChecked());
  expect(save).toHaveBeenLastCalledWith("a", false);
  fireEvent.click(screen.getByRole("button", { name: "立即评测一次" }));
  expect(run).not.toHaveBeenCalled();
});
it("prevents duplicate evaluations while saving and retains the current budget after a failed request", async () => {
  const { api } = learningApi(readyLearning);
  const run = pendingValue<EvolutionStatusDto>();
  const evaluate = vi.spyOn(api, "runEvolutionNow").mockRejectedValueOnce(new Error("private")).mockReturnValue(run.promise);
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  fireEvent.click(await screen.findByRole("button", { name: "立即评测一次" }));
  await screen.findByText("没能更新方法学习，请刷新后重试。");
  expect(screen.getByRole("radio", { name: "中（每日 150 次）" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "立即评测一次" }));
  expect(screen.getByRole("button", { name: "立即评测一次" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "启用全局方法学习" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "立即评测一次" }));
  expect(evaluate).toHaveBeenCalledTimes(2);
  await act(async () => { run.resolve({ ...status, learning: { ...readyLearning, stage: "PROTOCOL", experiment: { id: "experiment", calls: 1, tokens: null, reason: "evaluating" } } }); await Promise.resolve(); });
  expect(screen.getByText("检查模型工具协议")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "当前进展" })).toHaveTextContent("Token 用量未知");
  expect(within(screen.getByRole("region", { name: "学习设置" })).getByText("1,234 tokens")).toBeInTheDocument();
});
it("renders method outcomes independently and rolls back only a selected live method", async () => {
  const base = { revisionId: "live", scope: "WORKBENCH" as const, module: "context" as const, status: "ACTIVE" as const,
    createdAt: "2026-10-23", benefit: "quality" as const, baselineSuccesses: 10, candidateSuccesses: 15, evaluatedRuns: 30, candidateGoals: 5, controlGoals: 5 };
  const value: EvolutionLearningDto = { ...readyLearning, stage: "ACTIVE", methods: [base,
    { ...base, revisionId: "old", module: "completion", status: "REVERTED", benefit: null },
    { ...base, revisionId: "rejected", module: "planning", status: "REJECTED", benefit: "efficiency" }],
    experiment: { id: "finished", calls: 100, tokens: 10_000, reason: "canary" } };
  const { api } = learningApi(value);
  const rollback = vi.spyOn(api, "rollbackEvolution").mockRejectedValueOnce(new Error("private"))
    .mockResolvedValue({ ...status, learning: { ...value, stage: "PAUSED", methods: value.methods.map(method => ({ ...method, status: "REVERTED" as const })) } });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("质量收益")).toBeInTheDocument();
  expect(screen.queryByText("收益尚未验证")).toBeNull();
  expect(screen.getByText("上下文整理")).toBeInTheDocument();
  expect(screen.queryByText("完成检查")).toBeNull();
  expect(screen.getByRole("region", { name: "当前进展" })).toHaveTextContent("试用中");
  expect(screen.getAllByRole("button", { name: "回退当前策略并暂停" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "回退当前策略并暂停" }));
  await screen.findByText("没能更新方法学习，请刷新后重试。");
  fireEvent.click(screen.getByRole("button", { name: "回退当前策略并暂停" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "回退当前策略并暂停" })).toBeNull());
  expect(rollback).toHaveBeenLastCalledWith("a", "live");
  expect(screen.getByText("方法学习已暂停")).toBeInTheDocument();
});
it("shows a polling failure without losing the last method status", async () => {
  vi.useFakeTimers();
  const { api, loadStatus } = learningApi(readyLearning);
  loadStatus.mockResolvedValueOnce({ ...status, learning: readyLearning }).mockRejectedValue(new Error("offline"));
  const view = render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  try {
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("在重放案例上开发方法")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByText("没能读取进化状态，请稍后重试。")).toBeInTheDocument();
    expect(screen.getByText("在重放案例上开发方法")).toBeInTheDocument();
  } finally { view.unmount(); vi.useRealTimers(); }
});
it.each(["success", "failure"] as const)("ignores a late %s from a previously selected workbench", async (outcome) => {
  const oldStatus = pendingValue<EvolutionStatusDto>();
  const oldOverview = pendingValue<EvolutionOverviewDto>();
  const { api, overview, loadStatus, loadOverview } = learningApi(readyLearning);
  loadStatus.mockReturnValueOnce(oldStatus.promise).mockResolvedValue({ ...status, workbenchId: "b",
    learning: { ...readyLearning, appliedGoals: 7 } });
  loadOverview.mockReturnValueOnce(oldOverview.promise).mockResolvedValue(overview);
  const view = render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  view.rerender(<WorkbenchEvolutionPanel api={api} workbenchId="b" />);
  await screen.findByText("实际采用方法的目标：7");
  await act(async () => {
    if (outcome === "success") oldStatus.resolve({ ...status, learning });
    else oldStatus.reject(new Error("old request failed"));
    oldOverview.resolve({ ...overview, learning });
    await Promise.resolve();
  });
  expect(screen.getByText("实际采用方法的目标：7")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "立即评测一次" })).toBeEnabled();
  expect(screen.queryByText("没能读取进化状态，请稍后重试。")).toBeNull();
});
it.each([
  { reason: "budget_exhausted", text: "今日预算已用完" },
  { reason: "revision_limit_reached", text: "策略历史已达上限" },
  { reason: "model_changed", text: "模型或评测环境已变化" },
  { reason: "insufficient_samples", text: "评测样本不足" },
  { reason: "quality_regression", text: "候选质量下降" },
  { reason: "cost_regression", text: "候选调用成本超限" },
  { reason: "hard_violation", text: "候选违反完成约束" },
  { reason: "invalid_evaluation", text: "评测无效" },
  { reason: "invalid_candidate", text: "候选缺少充分证据" },
] satisfies { reason: EvolutionReason; text: string }[])("explains the experiment decision $reason without treating it as production benefit", async ({ reason, text }) => {
  const { api } = learningApi({ ...readyLearning, stage: "DIAGNOSING", blockers: ["not_idle", "insufficient_samples"],
    experiment: { id: "rejected", calls: 9, tokens: 321, reason } });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  const row = await screen.findByRole("region", { name: "当前进展" });
  expect(row).toHaveTextContent(text);
  expect(row).toHaveTextContent("9 次调用");
  expect(row).toHaveTextContent("321 tokens");
  expect(screen.getByText("前台任务优先，等待任务完成后继续。")).toBeInTheDocument();
  expect(screen.getByText("独立评测或灰度样本不足")).toBeInTheDocument();
  expect(screen.getByText("尚未采用新方法")).toBeInTheDocument();
});
it("does not allow immediate evaluation at a zero global cap even when the switches are on", async () => {
  const { api, loadOverview } = learningApi({ ...readyLearning, stage: "EVALUATE", globalBudget: { ...readyLearning.globalBudget, dailyCallLimit: 0 },
    blockers: ["budget_exhausted", "disabled"] });
  loadOverview.mockRejectedValue(new Error("offline"));
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByRole("region", { name: "当前进展" })).toHaveTextContent("方法学习已关闭");
  expect(screen.getByRole("checkbox", { name: "启用全局方法学习" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "本工作台参与方法学习" })).toBeChecked();
  expect(screen.getByRole("button", { name: "立即评测一次" })).toBeDisabled();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
