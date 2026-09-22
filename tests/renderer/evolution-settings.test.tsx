// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkbenchEvolutionPanel } from "../../src/renderer/EvolutionSettings";
import { DigitalLifeApi } from "../../src/renderer/api";
import type { EvolutionStatusDto } from "../../src/shared/evolution";
import { DEFAULT_EVOLUTION_DAILY_CALL_LIMIT } from "../../src/shared/evolution";

const status: EvolutionStatusDto = { workbenchId: "a", dailyCallLimit: DEFAULT_EVOLUTION_DAILY_CALL_LIMIT, callsUsedToday: 0, evidenceCount: 4, evaluableCount: 2, activeRevisionId: null, reason: "collecting", versions: [] };
it("starts on the low preset and applies preset changes immediately", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockResolvedValue(status);
  const save = vi.spyOn(api, "configureEvolution").mockResolvedValue({ ...status, dailyCallLimit: 0, reason: "disabled" });
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("正在积累可评价的经验")).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "低（每日 50 次）" })).toBeChecked();
  expect(screen.getByText(/约两周跑完一轮完整评测/u)).toBeInTheDocument();
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

it("shows a retryable notice when the evolution status cannot be read", async () => {
  const api = new DigitalLifeApi("");
  vi.spyOn(api, "evolutionStatus").mockRejectedValue(new Error("private"));
  render(<WorkbenchEvolutionPanel api={api} workbenchId="a" />);
  expect(await screen.findByText("没能读取进化状态，请稍后重试。")).toBeInTheDocument();
});
