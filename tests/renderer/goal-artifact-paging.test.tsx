// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { JoiHome } from "../../src/renderer/JoiHome.js";
import type { JoiGoalCardDto, JoiSnapshotDto, WorkbenchArtifactDto } from "../../src/shared/joi.js";

const snapshot: JoiSnapshotDto = { workbenchChanges: [], workbenches: [], partners: [], modelSources: [], work: [], runtime: { configured: true, status: "READY" } };
const files = (count: number, start = 0, mimeType = "application/json"): WorkbenchArtifactDto[] => Array.from({ length: count }, (_, index) => ({
  artifactId: `artifact-${String(index + start)}`, directory: "deliverables", kind: "FILE", mimeType, name: `file-${String(index + start)}.${mimeType === "text/markdown" ? "md" : "json"}`, size: 100,
}));
const goal = (artifacts: WorkbenchArtifactDto[]): JoiGoalCardDto => ({
  agentCount: 1, canDelete: true, goalId: "synthetic goal", title: "Synthetic goal", status: "COMPLETED", updatedAt: "2026-11-02T00:00:00Z",
  workbench: { workbenchId: "synthetic-bench", name: "Synthetic bench" }, work: { active: 0, completed: 1, failed: 0, total: 1 }, completionSummary: "# Published result", artifacts,
});

async function open(value: JoiGoalCardDto) {
  const api = new DigitalLifeApi("http://127.0.0.1:43210", true);
  vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
  const feed = vi.spyOn(api, "joiHomeFeed").mockResolvedValue({ goals: [value], thinking: [], unassignedActions: [] });
  const view = render(<JoiHome api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /打开「Synthetic goal」的最终结果全文/u }));
  return { api, feed, ...view, dialog: screen.getByRole("dialog") };
}

it("shows up to three changed files individually and opens larger document folders in Explorer", async () => {
  const { api, dialog } = await open(goal([...files(4, 0, "text/markdown"), ...files(3, 10).map(item => ({ ...item, directory: "src" }))]));
  const opener = vi.spyOn(api, "openWorkbenchArtifact").mockResolvedValue({ opened: true });
  expect(within(dialog).queryByText("file-0.md")).toBeNull();
  expect(within(dialog).getByText("file-10.json")).toBeVisible();
  expect(dialog.querySelectorAll("details.agent-artifact-group")).toHaveLength(0);
  fireEvent.click(within(dialog).getByRole("button", { name: /打开产物 deliverables/u }));
  await waitFor(() => expect(opener).toHaveBeenCalledWith("synthetic-bench", expect.objectContaining({ mode: "OPEN_FOLDER", source: "GOAL", artifactId: "artifact-0" })));
});

it("represents a large legacy folder with one Explorer action without mounting its files", async () => {
  const { container, dialog } = await open(goal(files(3_000)));
  expect(within(dialog).getByText("Published result")).toBeVisible();
  expect(container.querySelectorAll(".agent-artifact")).toHaveLength(1);
  expect(within(dialog).getByText(/3000 个文件$/u)).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "打开产物 deliverables" })).toBeVisible();
  expect(screen.queryByText("file-0.json")).toBeNull();
  expect(container.querySelectorAll("details.agent-artifact-group")).toHaveLength(0);
});

it("replaces artifact pages, preserves the body and retries without accumulating file cards", async () => {
  const standalone = (count: number, start = 0) => files(count, start, "text/markdown").map(item => ({ ...item, directory: item.name }));
  const value = { ...goal(standalone(20)), artifactCount: 25, artifactNextCursor: "artifact-19" };
  const { api, dialog } = await open(value);
  const request = vi.spyOn(api, "request").mockRejectedValueOnce(new Error("Synthetic failure"))
    .mockResolvedValueOnce({ items: standalone(5, 20) }).mockResolvedValueOnce({ items: value.artifacts, nextCursor: "artifact-19" });
  fireEvent.click(within(dialog).getByRole("button", { name: "下一页" }));
  expect(await within(dialog).findByRole("alert")).toBeVisible();
  expect(within(dialog).getByText("file-0.md")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
  await waitFor(() => expect(within(dialog).queryByText("file-0.md")).toBeNull());
  expect(within(dialog).getByText("file-24.md")).toBeVisible();
  expect(dialog.querySelectorAll(".agent-artifact")).toHaveLength(5);
  expect(within(dialog).getByText("Published result")).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "上一页" }));
  await waitFor(() => expect(within(dialog).getByText("file-0.md")).toBeVisible());
  expect(dialog.querySelectorAll(".agent-artifact")).toHaveLength(20);
  expect(request).toHaveBeenCalledWith(expect.stringContaining("/joi/goals/synthetic%20goal/artifacts?"));
});

it("ignores a page that resolves after its reader closes", async () => {
  const { api, dialog } = await open({ ...goal(files(1, 0, "text/markdown")), artifactNextCursor: "artifact-0", artifactCount: 2 });
  let resolve: ((value: unknown) => void) | undefined;
  vi.spyOn(api, "request").mockImplementation(() => new Promise(done => { resolve = done; }));
  fireEvent.click(within(dialog).getByRole("button", { name: "下一页" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  await act(async () => { resolve?.({ items: files(1, 1, "text/markdown") }); await Promise.resolve(); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("file-1.md")).toBeNull();
});

it("pages legacy standalone documents without growing the mounted set", async () => {
  const { dialog } = await open(goal(files(55, 0, "text/markdown").map(item => ({ ...item, directory: item.name }))));
  expect(dialog.querySelectorAll(".agent-artifact")).toHaveLength(20);
  fireEvent.click(within(dialog).getByRole("button", { name: "下一页" }));
  expect(within(dialog).getByText("file-20.md")).toBeVisible();
  expect(within(dialog).queryByText("file-0.md")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "上一页" }));
  expect(within(dialog).getByText("file-0.md")).toBeVisible();
  expect(dialog.querySelectorAll(".agent-artifact")).toHaveLength(20);
});

it("shows a newly published artifact preview in an already open goal detail", async () => {
  const value = goal([]);
  const { api, feed, dialog } = await open(value);
  vi.spyOn(api, "joiGoalDetail").mockResolvedValue({ goalId: value.goalId, fullTitle: value.title });
  vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [] });
  fireEvent.click(within(dialog).getByRole("button", { name: "查看详情" }));
  await waitFor(() => expect(screen.getByRole("dialog").querySelector(".joi-goal-artifacts")).toBeNull());
  feed.mockResolvedValue({ goals: [{ ...value, resultId: "published-result", artifacts: files(1, 0, "text/markdown"), artifactCount: 1 }], thinking: [], unassignedActions: [] });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  expect(await within(screen.getByRole("dialog")).findByText("file-0.md")).toBeVisible();
});
