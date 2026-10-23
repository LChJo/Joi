// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WorkbenchEvolutionPanel } from "../../src/renderer/EvolutionSettings";
import { DigitalLifeApi } from "../../src/renderer/api";
import type { EvolutionLearningDto, EvolutionStatusDto } from "../../src/shared/evolution";

const learning: EvolutionLearningDto = {
  version: 2, evaluatorVersion: "private-evaluator-id", stage: "DIAGNOSING",
  blockers: ["not_idle", "daily_candidate_limit"],
  globalBudget: { enabled: true, paused: false, dailyCallLimit: 150, callsUsedToday: 99, tokensToday: 137008 },
  participation: { enabled: true, paused: false }, cases: { development: 4, sealed: 0, defects: 4 },
  experiment: { id: "latest", calls: 99, tokens: 137008, reason: "insufficient_gain" }, appliedGoals: 0, methods: [],
};
const status: EvolutionStatusDto = { workbenchId: "a", dailyCallLimit: 150, callsUsedToday: 99,
  evidenceCount: 4, evaluableCount: 4, poolEvaluable: 4, poolVerificationFailed: 0, activeRevisionId: null,
  reason: "insufficient_gain", runRequestedAt: null, lastVerdict: null, versions: [], learning,
  batchHistory: [{ batchId: "legacy", workbenchId: "a", scope: "GLOBAL", phase: "EVALUATE", startedAt: "2026-10-23",
    finishedAt: "2026-10-23", reason: "promoted", calls: 200, tokens: 50000, revisionId: "legacy-revision" }] };

function show(value: EvolutionStatusDto = status) {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue(value);
  vi.spyOn(api, "evolutionOverview").mockResolvedValue({ workbenches: 1, enabled: 1, evaluating: 0, canary: 0, active: 0,
    revalidationRequired: 0, poolEvaluable: 4, poolVerificationFailed: 0, batches: status.batchHistory ?? [],
    ...(value.learning === undefined ? {} : { learning: value.learning }) });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  return api;
}

it("puts the current outcome ahead of settings without legacy history, dry runs or evaluator internals", async () => {
  show();
  const progress = await screen.findByRole("region", { name: "当前进展" });
  const methods = screen.getByRole("region", { name: "已采用的方法" });
  const settings = screen.getByRole("region", { name: "学习设置" });
  expect(progress.compareDocumentPosition(methods) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(methods.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(progress).getByText("最近一次评测")).toBeInTheDocument();
  expect(within(progress).getByText(/改善幅度不足/u)).toBeInTheDocument();
  expect(screen.queryByText(/旧版|合成评测|干跑|private-evaluator-id|当前实验/u)).toBeNull();
  expect(screen.queryByRole("button", { name: "干跑一次" })).toBeNull();
});

it("acknowledges a queued evaluation as a run request rather than a settings update", async () => {
  const api = show();
  vi.spyOn(api, "runEvolutionNow").mockResolvedValue({ ...status, runRequestedAt: "2026-10-23T09:00:00Z" });
  fireEvent.click(await screen.findByRole("button", { name: "立即评测一次" }));
  expect(await screen.findByText("已安排评测，工作台空闲且预算可用后开始。")).toBeInTheDocument();
  expect(screen.queryByText("已更新方法学习设置")).toBeNull();
});

it("does not claim an evaluation was queued when no reproducible case exists", async () => {
  const empty: EvolutionStatusDto = { ...status, learning: { ...learning, stage: "OBSERVING", experiment: null,
    blockers: ["no_reproducible_case"], cases: { development: 0, sealed: 0, defects: 0 } } };
  const api = show(empty);
  vi.spyOn(api, "runEvolutionNow").mockResolvedValue(empty);
  fireEvent.click(await screen.findByRole("button", { name: "立即评测一次" }));
  await waitFor(() => expect(screen.getAllByText("尚无可复现缺陷案例")).toHaveLength(2));
  expect(screen.queryByText(/已安排评测/u)).toBeNull();
});

it("labels an unfinished experiment as running rather than a completed assessment", async () => {
  show({ ...status, learning: { ...learning, stage: "EVALUATE", blockers: [],
    experiment: { id: "running", calls: 99, tokens: 137008, reason: "evaluating" } } });
  expect(await screen.findByText("正在评测")).toBeInTheDocument();
  expect(screen.queryByText("最近一次评测")).toBeNull();
});

it("uses an upgrade notice for an older host instead of restoring retired controls", async () => {
  const legacy = { ...status };
  delete legacy.learning;
  show(legacy);
  expect(await screen.findByText(/更新 Joi 后/u)).toBeInTheDocument();
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByText(/干跑|真实批次历史|策略历史/u)).toBeNull();
});

it("keeps rejected and reverted candidates out of the adopted methods section", async () => {
  const method = { revisionId: "rejected", scope: "GLOBAL" as const, module: "planning" as const,
    status: "REJECTED" as const, createdAt: "2026-10-23", benefit: null,
    baselineSuccesses: 3, candidateSuccesses: 2, evaluatedRuns: 5, candidateGoals: 0, controlGoals: 0 };
  show({ ...status, learning: { ...learning, methods: [method, { ...method, revisionId: "reverted", status: "REVERTED" }] } });
  const methods = await screen.findByRole("region", { name: "已采用的方法" });
  expect(within(methods).getByText("尚未采用新方法")).toBeInTheDocument();
  expect(within(methods).queryByText("任务规划")).toBeNull();
  expect(within(methods).queryByRole("button")).toBeNull();
});
