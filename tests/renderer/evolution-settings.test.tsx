// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkbenchEvolutionPanel } from "../../src/renderer/EvolutionSettings";
import { DigitalLifeApi } from "../../src/renderer/api";
import type { EvolutionDryRunReportDto, EvolutionLearningDto, EvolutionOverviewDto, EvolutionReason, EvolutionStatusDto } from "../../src/shared/evolution";
import { DEFAULT_EVOLUTION_DAILY_CALL_LIMIT } from "../../src/shared/evolution";

const status: EvolutionStatusDto = { workbenchId: "a", dailyCallLimit: DEFAULT_EVOLUTION_DAILY_CALL_LIMIT, callsUsedToday: 0, evidenceCount: 4, evaluableCount: 2, poolEvaluable: 7, poolVerificationFailed: 2, activeRevisionId: null, reason: "collecting", runRequestedAt: null, lastVerdict: null, versions: [] };
it("starts off and applies preset changes immediately", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue({ ...status, reason: "disabled" });
  vi.spyOn(api, "evolutionOverview").mockResolvedValue({ workbenches: 1, enabled: 0, evaluating: 0, canary: 0, active: 0,
    revalidationRequired: 0, poolEvaluable: 0, poolVerificationFailed: 0, batches: [] });
  const save = vi.spyOn(api, "configureEvolution").mockResolvedValueOnce({ ...status, dailyCallLimit: 50, reason: "collecting" }).mockResolvedValue({ ...status, dailyCallLimit: 0, reason: "disabled" });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("尚未启用自动进化")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "关（只记录经验）" })).toBeChecked();
  // The trigger is a shared pool, so the panel has to show the pool the gate actually uses; a
  // per-workbench count alone no longer explains why a batch has not started.
  expect(screen.getByText(/合计 10 个可客观评价目标/u)).toBeInTheDocument();
  expect(screen.getByText(/当前为 7 个与 2 个/u)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "低（每日 50 次）" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("a", 50));
  expect(await screen.findByText("正在积累可评价的经验")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("radio", { name: "关（只记录经验）" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("a", 0));
  expect(await screen.findByText("尚未启用自动进化")).toBeInTheDocument();
  expect(await screen.findByText("已关闭评测预算，只记录经验。")).toBeInTheDocument();
});

it("surfaces save failures, custom limits and rolls back the active version", async () => {
  const api = new DigitalLifeApi("");
  const active: EvolutionStatusDto = { ...status, dailyCallLimit: 10, activeRevisionId: "r1", reason: "promoted", versions: [{ revisionId: "r1", parentRevisionId: null, module: "completion", status: "ACTIVE", createdAt: "2026-09-22", reason: "promoted", baselineSuccesses: 80, candidateSuccesses: 90, evaluatedRuns: 180 }] };
  vi.spyOn(api, "evolutionStatus").mockResolvedValue(active);
  const save = vi.spyOn(api, "configureEvolution").mockRejectedValue(new Error("private"));
  const rollback = vi.spyOn(api, "rollbackEvolution").mockRejectedValueOnce(new Error("private")).mockResolvedValue({ ...status, reason: "rolled_back" });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  await screen.findByText("完成检查");
  expect(screen.getByText(/当前为自定义额度：每日 10 次/u)).toBeInTheDocument();
  expect(screen.queryByRole("radio", { name: "低（每日 50 次）", checked: true })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "中（每日 150 次）" }));
  await screen.findByText("没能保存预算，请重试。");
  expect(save).toHaveBeenCalledWith("a", 150);
  fireEvent.click(screen.getByRole("button", { name: "回退当前策略并暂停" }));
  await screen.findByText("没能回退策略，请刷新状态后重试。");
  fireEvent.click(screen.getByRole("button", { name: "回退当前策略并暂停" }));
  await screen.findByText("已回退并暂停自动进化，运行中的目标保留原策略。");
  expect(rollback).toHaveBeenCalledWith("a", "r1");
});

it("offers the same manual rollback for an active global strategy", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue({ ...status, globalRevisionId: "global-r1", activeEffective: true, reason: "promoted" });
  const rollback = vi.spyOn(api, "rollbackEvolution").mockResolvedValue({ ...status, reason: "rolled_back" });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  fireEvent.click(await screen.findByRole("button", { name: "回退当前策略并暂停" }));
  await waitFor(() => expect(rollback).toHaveBeenCalledWith("a", "global-r1"));
});

it("dry-runs the pipeline and reports what each phase did", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue(status);
  const run = vi.spyOn(api, "dryRunEvolution").mockResolvedValue({
    workbenchId: "a", outcome: "promoted", verdict: "promoted", promoted: true, steps: 721, truncated: false, blockedAt: null,
    phases: [
      { phase: "DEVELOP", steps: 90, rollouts: 30 },
      { phase: "PROPOSE", steps: 1, rollouts: 0 },
      { phase: "VALIDATE", steps: 90, rollouts: 30 },
      { phase: "EVALUATE", steps: 540, rollouts: 180 },
    ],
    revision: { revisionId: "r1", parentRevisionId: null, module: "completion", status: "ACTIVE", createdAt: "2026-09-24", reason: "promoted", baselineSuccesses: 85, candidateSuccesses: 90, evaluatedRuns: 180 },
    evaluation: { scenarios: 30, baselineSuccesses: 85, candidateSuccesses: 90, evaluatedRuns: 180 },
    selfCheck: { expectedVerdict: "promote", matched: true },
    syntheticEvidence: { evaluable: 10, verificationFailed: 3 },
    events: [], durationMs: 700,
  });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  await screen.findByText("正在积累可评价的经验");
  fireEvent.click(screen.getByRole("button", { name: "干跑一次" }));
  await waitFor(() => expect(run).toHaveBeenCalledWith("a"));
  expect(await screen.findByText("链路跑通：批次一路走到晋升裁决。")).toBeInTheDocument();
  expect(screen.getByText(/开发 30 轮 \/ 90 次调用/u)).toBeInTheDocument();
  expect(screen.getByText(/封存评测 180 轮 \/ 540 次调用/u)).toBeInTheDocument();
  expect(screen.getByText(/合计 721 次合成调用/u)).toBeInTheDocument();
});

it("queues an immediate run and shows the queued state plus the last verdict", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue(status);
  const runNow = vi.spyOn(api, "runEvolutionNow").mockRejectedValueOnce(new Error("private")).mockResolvedValue({
    ...status, runRequestedAt: "2026-09-28T09:30:00.000Z",
    lastVerdict: { reason: "insufficient_gain", at: "2026-09-27T00:00:00.000Z", baselineSuccesses: 85, candidateSuccesses: 87, evaluatedRuns: 180 },
  });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  await screen.findByText("正在积累可评价的经验");
  fireEvent.click(screen.getByRole("button", { name: "立即评测一次" }));
  await screen.findByText("没能发起评测：请确认自动进化未处于暂停或关闭状态。");
  fireEvent.click(screen.getByRole("button", { name: "立即评测一次" }));
  await screen.findByText(/已排入队列/u);
  expect(runNow).toHaveBeenCalledTimes(2);
  expect(await screen.findByText(/上一轮裁决：改善幅度不足/u)).toBeInTheDocument();
  expect(screen.getByText(/原策略通过 85 次 \/ 候选通过 87 次/u)).toBeInTheDocument();
});

it("names the paused state after invalid model responses", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue({ ...status, reason: "model_response_invalid", paused: true });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText(/模型响应不符合评测要求，已暂停自动进化/u)).toBeInTheDocument();
});

it("distinguishes a terminated batch from a paused workbench and names unknown consumption", async () => {
  const api = new DigitalLifeApi("");
  const batch = { batchId: "b1", workbenchId: "a", scope: "GLOBAL" as const, phase: "DEVELOP" as const,
    startedAt: "2026-10-12T15:49:46Z", finishedAt: "2026-10-12T15:50:06Z", reason: "model_response_invalid" as const,
    calls: 2, tokens: null, revisionId: null, failure: { kind: "multiple_tool_calls" as const, stopReason: "toolUse" as const, toolCallCount: 2 } };
  vi.spyOn(api, "evolutionStatus").mockResolvedValue({ ...status, dailyCallLimit: 150, paused: false, reason: "model_response_invalid", batchHistory: [batch] });
  vi.spyOn(api, "evolutionOverview").mockResolvedValue({ workbenches: 1, enabled: 1, evaluating: 0, canary: 0, active: 0,
    revalidationRequired: 0, poolEvaluable: 3, poolVerificationFailed: 1, batches: [batch] });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("模型响应不符合评测要求，本轮已终止；检查模型源后可立即重新评测")).toBeInTheDocument();
  expect(screen.queryByText(/已暂停自动进化/u)).toBeNull();
  expect(screen.getAllByText(/返回了多个工具调用/u)).toHaveLength(2);
  expect(screen.getAllByText(/Token 用量未知/u)).toHaveLength(2);
  expect(screen.getByRole("button", { name: "立即评测一次" })).toBeEnabled();
});

it("shows aggregate batches, canary progress and explicit revalidation", async () => {
  const api = new DigitalLifeApi("");
  const batch = { batchId: "b1", workbenchId: "a", scope: "GLOBAL" as const, phase: "EVALUATE" as const,
    startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T01:00:00.000Z", reason: "canary" as const,
    calls: 240, tokens: 12_000, revisionId: "r1" };
  const localBatch = { ...batch, batchId: "b2", scope: "WORKBENCH" as const, phase: "DEVELOP" as const,
    finishedAt: null, reason: "call_failed" as const, calls: 1, tokens: 400, revisionId: null };
  vi.spyOn(api, "evolutionOverview").mockResolvedValue({ workbenches: 3, enabled: 2, evaluating: 1, canary: 1, active: 1,
    revalidationRequired: 1, poolEvaluable: 8, poolVerificationFailed: 2, batches: [batch, localBatch] });
  vi.spyOn(api, "evolutionStatus").mockResolvedValue({ ...status, dailyCallLimit: 50, reason: "revalidation_required",
    canaryRevisionId: "r1", revalidationRequired: true, activeEffective: false, batchHistory: [localBatch],
    versions: [{ revisionId: "r-context", parentRevisionId: null, module: "context", status: "REJECTED", createdAt: "2026-10-10",
      reason: "insufficient_gain", baselineSuccesses: 80, candidateSuccesses: 82, evaluatedRuns: 180 }] });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText(/已启用 2 \/ 3/u)).toBeInTheDocument();
  expect(screen.getByText(/全局基线 · 封存评测 · 候选已通过合成评测/u)).toBeInTheDocument();
  expect(screen.getByText(/工作台覆盖 · 开发 · 后台调用未完成/u)).toBeInTheDocument();
  expect(screen.getByText(/候选正在生产灰度/u)).toBeInTheDocument();
  expect(screen.getByText(/当前模型固定版本与策略评测版本不一致/u)).toBeInTheDocument();
  expect(screen.getByText("真实批次历史")).toBeInTheDocument();
  expect(screen.getByText("上下文整理")).toBeInTheDocument();
  expect(screen.getAllByText(/400 tokens/u)).toHaveLength(2);
});

it("reports a failed or truncated dry run instead of implying the pipeline is sound", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue(status);
  const run = vi.spyOn(api, "dryRunEvolution").mockRejectedValue(new Error("private"));
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  await screen.findByText("正在积累可评价的经验");
  fireEvent.click(screen.getByRole("button", { name: "干跑一次" }));
  expect(await screen.findByText("干跑没能完成，请稍后重试。")).toBeInTheDocument();
  run.mockResolvedValue({
    workbenchId: "a", outcome: "truncated", verdict: "evaluating", promoted: false, steps: 1600, truncated: true,
    blockedAt: { phase: "EVALUATE", reason: "evaluating" },
    phases: [{ phase: "DEVELOP", steps: 90, rollouts: 30 }],
    revision: null, evaluation: null,
    selfCheck: { expectedVerdict: "promote", matched: false },
    syntheticEvidence: { evaluable: 10, verificationFailed: 3 },
    events: [], durationMs: 10_000,
  });
  fireEvent.click(screen.getByRole("button", { name: "干跑一次" }));
  expect(await screen.findByText("链路未跑完：达到了步数或时间上限。")).toBeInTheDocument();
  // A missed self check is the signal that the stand-in drifted, so it has to be visible rather than
  // left for the operator to infer from a verdict they may not recognise.
  expect(screen.getByText(/自检未通过/u)).toBeInTheDocument();
});

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
it("names the actual blocker, unknown usage and legacy dry run without showing the legacy evidence gate", async () => {
  const { api } = learningApi();
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("尚无可复现缺陷案例")).toBeInTheDocument();
  expect(screen.getByText(/Token 用量未知/u)).toBeInTheDocument();
  expect(screen.getByText(/method-evaluator-v2/u)).toBeInTheDocument();
  expect(screen.queryByText(/合计 10 个可客观评价目标/u)).toBeNull();
  expect(screen.getByText("旧版合成链路干跑")).toBeInTheDocument();
  expect(screen.getByText(/不验证真实案例方法学习/u)).toBeInTheDocument();
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
const syntheticReport: EvolutionDryRunReportDto = { workbenchId: "a", outcome: "rejected", verdict: "insufficient_gain", promoted: false,
  steps: 12, truncated: false, blockedAt: null, phases: [], revision: null, evaluation: null,
  selfCheck: { expectedVerdict: "promote", matched: true }, syntheticEvidence: { evaluable: 10, verificationFailed: 3 }, events: [], durationMs: 100 };
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
  expect(screen.getByText(/当前实验/u)).toHaveTextContent("Token 用量未知");
  expect(screen.getByText(/今日共享调用/u)).toHaveTextContent("1234 tokens");
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
  expect(screen.getByText("收益尚未验证")).toBeInTheDocument();
  expect(screen.getByText("上下文整理")).toBeInTheDocument();
  expect(screen.getByText("完成检查")).toBeInTheDocument();
  expect(screen.getByText(/当前实验/u)).toHaveTextContent("20% 生产灰度");
  expect(screen.getAllByRole("button", { name: "回退当前策略并暂停" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "回退当前策略并暂停" }));
  await screen.findByText("没能更新方法学习，请刷新后重试。");
  fireEvent.click(screen.getByRole("button", { name: "回退当前策略并暂停" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "回退当前策略并暂停" })).toBeNull());
  expect(rollback).toHaveBeenLastCalledWith("a", "live");
  expect(screen.getByText("方法学习已暂停")).toBeInTheDocument();
});
it("keeps legacy history and synthetic dry-run results scoped when aggregate loading fails", async () => {
  const { api, loadOverview, loadStatus } = learningApi(readyLearning);
  loadOverview.mockRejectedValue(new Error("offline"));
  loadStatus.mockResolvedValue({ ...status, learning: readyLearning, batchHistory: [{ batchId: "legacy", workbenchId: "a", scope: "WORKBENCH",
    phase: "PROPOSE", startedAt: "2026-10-23", finishedAt: "2026-10-23", reason: "invalid_candidate", calls: 12, tokens: null, revisionId: null }] });
  const dryRun = vi.spyOn(api, "dryRunEvolution").mockResolvedValueOnce(syntheticReport)
    .mockRejectedValueOnce(new Error("private")).mockResolvedValue({ ...syntheticReport, outcome: "not_started", selfCheck: { expectedVerdict: "promote", matched: false } });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("旧版合成评测历史")).toBeInTheDocument();
  expect(screen.getByText(/提案 · 候选缺少充分证据/u)).toHaveTextContent("Token 用量未知");
  fireEvent.click(screen.getByRole("button", { name: "干跑一次" }));
  await screen.findByText(/链路跑通，但候选被门禁拒绝/u);
  fireEvent.click(screen.getByRole("button", { name: "干跑一次" }));
  await screen.findByText("没能更新方法学习，请刷新后重试。");
  expect(screen.queryByText(/链路跑通，但候选被门禁拒绝/u)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "干跑一次" }));
  await screen.findByText(/批次没能启动，合成证据未达标/u);
  expect(screen.getByText(/自检未通过/u)).toBeInTheDocument();
  expect(screen.getByText(/不验证真实案例方法学习/u)).toBeInTheDocument();
  expect(dryRun).toHaveBeenCalledTimes(3);
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
    learning: { ...readyLearning, evaluatorVersion: "current-workbench" } });
  loadOverview.mockReturnValueOnce(oldOverview.promise).mockResolvedValue(overview);
  const view = render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  view.rerender(<WorkbenchEvolutionPanel api={api} workbenchId="b" />);
  await screen.findByText(/current-workbench/u);
  await act(async () => {
    if (outcome === "success") oldStatus.resolve({ ...status, learning });
    else oldStatus.reject(new Error("old request failed"));
    oldOverview.resolve({ ...overview, learning });
    await Promise.resolve();
  });
  expect(screen.getByText(/current-workbench/u)).toBeInTheDocument();
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
  const row = await screen.findByText(/当前实验/u);
  expect(row).toHaveTextContent(text);
  expect(row).toHaveTextContent("9 次调用");
  expect(row).toHaveTextContent("321 tokens");
  expect(screen.getByText("前台待办、Turn 或 Work 优先")).toBeInTheDocument();
  expect(screen.getByText("独立评测或灰度样本不足")).toBeInTheDocument();
  expect(screen.getByText("尚无经过评测的方法")).toBeInTheDocument();
});
it("does not allow immediate evaluation at a zero global cap even when the switches are on", async () => {
  const { api, loadOverview } = learningApi({ ...readyLearning, stage: "EVALUATE", globalBudget: { ...readyLearning.globalBudget, dailyCallLimit: 0 },
    blockers: ["budget_exhausted", "disabled"] });
  loadOverview.mockRejectedValue(new Error("offline"));
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("独立封存评测")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "启用全局方法学习" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "本工作台参与方法学习" })).toBeChecked();
  expect(screen.getByRole("button", { name: "立即评测一次" })).toBeDisabled();
});
it.each([
  { kind: "provider_error" as const, text: "模型源调用失败" },
  { kind: "timeout" as const, text: "模型源调用超时" },
  { kind: "aborted" as const, text: "评测调用已取消" },
  { kind: "response_truncated" as const, text: "模型输出被截断" },
  { kind: "no_tool_call" as const, text: "未返回工具调用" },
  { kind: "unsupported_tool" as const, text: "返回了不支持的工具调用" },
])("names a legacy $kind failure without exposing the provider error", async ({ kind, text }) => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue({ ...status, dailyCallLimit: 400, reason: "call_failed", failure: { kind, toolCallCount: 0 } });
  vi.spyOn(api, "evolutionOverview").mockRejectedValue(new Error("private"));
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(screen.getByText(/约两天跑完/u)).toBeInTheDocument();
  expect(screen.queryByText("private")).toBeNull();
});
