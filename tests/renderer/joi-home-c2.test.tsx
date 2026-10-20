// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DigitalLifeApi } from "../../src/renderer/api.js";
import { JoiHome } from "../../src/renderer/JoiHome.js";
import type { JoiGoalCardDto, JoiSnapshotDto } from "../../src/shared/joi.js";

const goal: JoiGoalCardDto = {
  agentCount: 2, canDelete: true, completionSummary: "# 结果标题\n\n完整结果末尾", goalId: "goal-c2", status: "COMPLETED",
  title: "保留目标与完整结果", updatedAt: "2026-10-20T00:00:00Z", workbench: { workbenchId: "bench-c2", name: "工作台示例" },
  work: { active: 0, completed: 2, failed: 0, total: 2 },
};

function setup() {
  const api = new DigitalLifeApi("", true);
  const snapshot: JoiSnapshotDto = {
    modelSources: [], partners: [], runtime: { configured: true, status: "READY" }, work: [], workbenchChanges: [],
    workbenches: [{ workbenchId: "bench-c2", name: "工作台示例", scopeSummary: "示例范围", updatedAt: goal.updatedAt }],
  };
  vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(api, "joiHomeFeed").mockResolvedValue({ goals: [goal], thinking: [], unassignedActions: [] });
  render(<JoiHome api={api} />);
  return api;
}

describe("C2 home interactions", () => {
  it("uses a decorative workbench icon and preserves the full goal and result entry", async () => {
    setup();
    await screen.findByText(goal.title);
    const orb = document.querySelector(".joi-goal-open .workbench-orb");
    expect(orb).toHaveAttribute("aria-hidden", "true");
    expect(orb?.querySelector("svg")).not.toBeNull();
    expect(orb?.textContent).toBe("");
    expect(screen.getByRole("button", { name: `打开「${goal.title}」的最终结果全文` })).toBeInTheDocument();
    expect(screen.queryByText("你的目标")).not.toBeInTheDocument();
  });

  it("starts without stealing focus and keeps a draft or attachment expanded after blur", async () => {
    setup();
    const input = await screen.findByLabelText("给 joi 输入");
    const form = input.closest("form");
    expect(input).not.toHaveFocus();
    fireEvent.change(input, { target: { value: "补充想法" } });
    fireEvent.blur(input);
    expect(form).toHaveClass("has-content");
    fireEvent.change(input, { target: { value: "" } });
    expect(form).not.toHaveClass("has-content");
    fireEvent.change(screen.getByLabelText("给 joi 添加附件"), { target: { files: [new File(["fixture"], "plan.txt", { type: "text/plain" })] } });
    expect(form).toHaveClass("has-content");
  });

  it("keeps an explicit workbench choice visible when the empty editor loses focus", async () => {
    setup();
    const input = await screen.findByLabelText("给 joi 输入");
    fireEvent.click(screen.getByRole("button", { name: "joi 自主分发" }));
    fireEvent.click(screen.getByRole("button", { name: "工作台示例" }));
    fireEvent.blur(input);
    expect(input.closest("form")).toHaveClass("has-content");
    expect(screen.getByRole("button", { name: "分发给 工作台示例" })).toBeInTheDocument();
  });

  it("submits with Ctrl or Command Enter while preserving composition and ordinary newlines", async () => {
    const api = setup();
    const send = vi.spyOn(api, "sendJoiMessage").mockResolvedValue({ acceptedAt: goal.updatedAt, inputId: "new-c2", status: "PENDING" });
    const input = await screen.findByLabelText("给 joi 输入");
    fireEvent.change(input, { target: { value: "第一行\n第二行" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { ctrlKey: true, isComposing: true, key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { ctrlKey: true, key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledWith("第一行\n第二行", {}));
    fireEvent.change(input, { target: { value: "新的目标" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledWith("新的目标", {}));
  });
});
