// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { JoiHome } from "../../src/renderer/JoiHome";
import { DigitalLifeApi } from "../../src/renderer/api";
import type { JoiGoalCardDto, JoiSnapshotDto } from "../../src/shared/joi";
import type * as MarkdownModule from "react-markdown";
import { SafeMarkdown } from "../../src/renderer/SafeMarkdown";
import { GoalResultHistory } from "../../src/renderer/GoalResultHistory";

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("react-markdown", async importOriginal => {
  const actual = await importOriginal<typeof MarkdownModule>();
  return { ...actual, default: (options: Parameters<typeof actual.default>[0]) => { parse(options.children); return actual.default(options); } };
});

async function renderResult(body: string) {
  const api = new DigitalLifeApi("", true);
  const goal: JoiGoalCardDto = { goalId: "markdown-result", title: "结果复用", completionSummary: body, status: "COMPLETED", agentCount: 0, canDelete: true,
    updatedAt: "2026-11-03T00:00:00Z", workbench: { workbenchId: "bench", name: "Test" }, work: { active: 0, completed: 1, failed: 0, total: 1 } };
  const snapshot: JoiSnapshotDto = { modelSources: [], partners: [], runtime: { configured: true, status: "READY" }, work: [], workbenchChanges: [],
    workbenches: [{ workbenchId: "bench", name: "Test", scopeSummary: "", updatedAt: goal.updatedAt }] };
  vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(api, "joiHomeFeed").mockResolvedValue({ goals: [goal], thinking: [], unassignedActions: [] });
  render(<JoiHome api={api} />);
  return screen.findByRole("button", { name: "打开「结果复用」的最终结果全文" });
}

async function openResult(body: string) {
  fireEvent.click(await renderResult(body));
  return screen.getByRole("dialog");
}

describe("result rendering work", () => {
  it("bounds mounted home previews while keeping the complete cached result", async () => {
    const body = "# Bounded preview fixture\n\n" + Array.from({ length: 250 }, (_, i) => `- **item ${String(i)}** with [reference](https://example.test)\n`).join("") + "\nFULL_RESULT_TAIL";
    const button = await renderResult(body);
    const preview = button.querySelector(".joi-goal-result-copy");
    expect(preview?.textContent).toContain("Bounded preview fixture");
    expect(preview?.textContent.length).toBeLessThanOrEqual(321);
    expect(preview?.querySelectorAll("*").length).toBe(0);
    expect(preview?.textContent).not.toContain("FULL_RESULT_TAIL");
    fireEvent.click(button);
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("FULL_RESULT_TAIL")).toBeInTheDocument();
    expect(within(drawer).getAllByRole("link")).toHaveLength(250);
    expect(parse.mock.calls.filter(([input]) => input === body)).toHaveLength(1);
  });
  it("shares parsing with the historical result reader and repeated history selections", async () => {
    const api = new DigitalLifeApi("", true);
    const body = "# Shared historical parse fixture";
    const completedAt = "2026-11-03T00:00:00Z";
    const goal: JoiGoalCardDto = { goalId: "history-cache", title: "历史复用", status: "COMPLETED", agentCount: 0, canDelete: true,
      updatedAt: completedAt, workbench: { workbenchId: "bench", name: "Test" }, work: { active: 0, completed: 1, failed: 0, total: 1 } };
    vi.spyOn(api, "joiGoalResults").mockResolvedValue({ items: [{ resultId: "saved", completedAt, status: "COMPLETED" }] });
    vi.spyOn(api, "joiGoalResult").mockResolvedValue({ resultId: "saved", goalId: goal.goalId, completedAt, status: "COMPLETED", body });
    render(<><SafeMarkdown>{body}</SafeMarkdown><GoalResultHistory api={api} goal={goal} onClose={() => undefined} /></>);
    const drawer = screen.getByRole("dialog");
    fireEvent.click(await within(drawer).findByRole("button", { name: /最新结果/u }));
    await within(drawer).findByRole("heading", { name: "Shared historical parse fixture" });
    expect(parse.mock.calls.filter(([input]) => input === body)).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(await within(drawer).findByRole("button", { name: /最新结果/u }));
    await within(drawer).findByRole("heading", { name: "Shared historical parse fixture" });
    expect(parse.mock.calls.filter(([input]) => input === body)).toHaveLength(1);
  });
  it("reuses preview parsing in the result drawer and after reopening", async () => {
    const body = "# Shared parse fixture\n\n| A | B |\n| --- | --- |\n| one | two |";
    const drawer = await openResult(body);
    expect(within(drawer).getByRole("table")).toBeInTheDocument();
    expect(parse.mock.calls.filter(([input]) => input === body)).toHaveLength(1);
    fireEvent.click(within(drawer).getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "打开「结果复用」的最终结果全文" }));
    expect(parse.mock.calls.filter(([input]) => input === body)).toHaveLength(1);
  });
  it("skips empty geometry, sizes typed text and shrinks after clearing", async () => {
    let drawerReads = 0;
    const getter = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this instanceof HTMLTextAreaElement && this.closest(".joi-result-drawer") !== null) drawerReads += 1;
      return 60;
    });
    try {
      const drawer = await openResult("Empty geometry fixture");
      expect(drawerReads).toBe(0);
      const input = within(drawer).getByRole("textbox");
      input.style.border = "1px solid black";
      fireEvent.change(input, { target: { value: "first\nsecond" } });
      expect(drawerReads).toBe(1);
      expect(input.style.height).not.toBe("auto");
      fireEvent.change(input, { target: { value: "" } });
      expect(drawerReads).toBe(1);
      expect(input.style.height).toBe("auto");
    } finally { getter.mockRestore(); }
  });
});
