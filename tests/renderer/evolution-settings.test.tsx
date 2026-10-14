// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkbenchEvolutionPanel } from "../../src/renderer/EvolutionSettings";
import { DigitalLifeApi } from "../../src/renderer/api";
import type { EvolutionStatusDto } from "../../src/shared/evolution";
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
    finishedAt: null, reason: "call_failed" as const, calls: 1, tokens: null, revisionId: null };
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
