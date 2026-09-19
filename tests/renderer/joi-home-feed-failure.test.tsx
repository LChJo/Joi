// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { JoiHome } from "../../src/renderer/JoiHome.js";
import type { JoiHomeFeedDto, JoiSnapshotDto } from "../../src/shared/joi.js";

const snapshot: JoiSnapshotDto = {
  workbenchChanges: [], workbenches: [], modelSources: [{
    sourceId: "source", displayName: "Test", kind: "deepseek", accessMode: "api", protocol: "openai",
    order: 0, primary: true, status: "READY", credential: { configured: true, version: 1 },
    activeSourceRevisionId: "revision", activeModel: { capability: "release-tested", id: "model", revisionId: "model-revision" },
  }], partners: [], work: [],
  runtime: { configured: true, status: "READY" },
};
const feed: JoiHomeFeedDto = { goals: [{
  goalId: "running", title: "正在执行的任务", status: "RUNNING", agentCount: 1, canDelete: false,
  updatedAt: "2026-09-19T00:00:00Z", workbench: { workbenchId: "bench", name: "工作台" },
  work: { active: 1, completed: 0, failed: 0, total: 1 },
}], thinking: [], unassignedActions: [] };

describe("home feed failure preserves execution truth", () => {
  it("shows an initial failure and retries without inferring status from inbox messages", async () => {
    const api = new DigitalLifeApi("", true);
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
    const load = vi.spyOn(api, "joiHomeFeed").mockRejectedValue(new Error("private failure"));
    const legacy = vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { inputId: "running", acceptedAt: "2026-09-19T00:00:00Z", status: "CONSUMED" },
    ] });
    render(<JoiHome api={api} />);
    expect(await screen.findByText("任务状态暂时无法刷新，已保留上次成功获取的数据。")).toBeInTheDocument();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
    expect(screen.queryByText(/这里很干净/u)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("private failure");
    expect(legacy).not.toHaveBeenCalled();
    load.mockResolvedValue(feed);
    fireEvent.click(screen.getByRole("button", { name: "重新加载任务状态" }));
    expect(await screen.findByText("执行中")).toBeInTheDocument();
    expect(screen.queryByText(/任务状态暂时无法刷新/u)).not.toBeInTheDocument();
  });

  it("keeps a running card during polling failures and clears the error after recovery", async () => {
    const api = new DigitalLifeApi("", true);
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
    const load = vi.spyOn(api, "joiHomeFeed").mockResolvedValue(feed);
    const legacy = vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    render(<JoiHome api={api} />);
    expect(await screen.findByText("执行中")).toBeInTheDocument();
    load.mockRejectedValue(new Error("offline"));
    await waitFor(() => expect(screen.getByText(/任务状态暂时无法刷新/u)).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(legacy).not.toHaveBeenCalled();
    const goal = feed.goals[0];
    if (goal === undefined || goal.status === "NEEDS_ATTENTION") throw new Error("invalid fixture");
    load.mockResolvedValue({ ...feed, goals: [{ ...goal, status: "FINALIZING" }] });
    act(() => { fireEvent.click(screen.getByRole("button", { name: "重新加载任务状态" })); });
    expect(await screen.findByText("正在总结")).toBeInTheDocument();
    expect(screen.queryByText(/任务状态暂时无法刷新/u)).not.toBeInTheDocument();
  });
});
