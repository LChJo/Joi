// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RemoteJoiApp, type RemoteJoiConnection } from "../../src/renderer/RemoteJoiApp.js";
import type { JoiHomeFeedDto } from "../../src/shared/joi.js";

describe("RemoteJoiApp", () => {
  it("renders a portrait-only joi feed and sends text without privileged controls", async () => {
    const connection: RemoteJoiConnection = {
      feed: vi.fn().mockResolvedValue({
        goals: [{
          agentCount: 2, canDelete: false, goalId: "goal-1", status: "RUNNING", title: "整理发布计划",
          updatedAt: "2026-08-26T00:00:00.000Z", work: { active: 1, completed: 2, failed: 0, total: 3 },
          workbench: { name: "发布", workbenchId: "workbench-1" },
        }],
        thinking: [], unassignedActions: [],
      }),
      sendMessage: vi.fn().mockResolvedValue({ acceptedAt: "2026-08-26T00:00:00.000Z", inputId: "input-1", status: "PENDING" }),
      status: vi.fn().mockReturnValue("connected"),
    };

    render(<RemoteJoiApp connection={connection} />);
    expect(await screen.findByRole("heading", { name: "整理发布计划" })).toBeInTheDocument();
    expect(screen.getByText("1 项执行中 · 2 项已完成")).toBeInTheDocument();
    expect(screen.queryByText("设置")).not.toBeInTheDocument();
    expect(screen.queryByText("搭档")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /附件/u })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "给 joi 发消息" }), { target: { value: "继续检查风险" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    // eslint-disable-next-line @typescript-eslint/unbound-method
    await waitFor(() => expect(connection.sendMessage).toHaveBeenCalledWith("继续检查风险", expect.stringMatching(/^remote:/u)));
  });

  it("renders every safe goal state and preserves a failed send for retry", async () => {
    const statuses: JoiHomeFeedDto["goals"][number]["status"][] = [
      "ARRANGING", "ARRANGED", "REVIEWING", "EXTENDING", "FINALIZING", "COMPLETED", "NEEDS_ATTENTION", "FAILED", "CANCELED",
    ];
    const goals = statuses.map((status, index) => ({
      agentCount: 1,
      canDelete: false,
      clarification: status === "NEEDS_ATTENTION" ? { prompt: "请选择下一步", reasonCode: "question_required" } : { reasonCode: "none" },
      completionSummary: status === "COMPLETED" ? "任务已经完成" : undefined,
      goalId: `goal-${String(index)}`,
      status,
      title: `任务 ${String(index)}`,
      updatedAt: "2026-08-26T00:00:00.000Z",
      work: { active: 0, completed: 0, failed: status === "FAILED" ? 1 : 0, total: status === "FAILED" ? 1 : 0 },
      workbench: { name: "测试工作台", workbenchId: "workbench-1" },
    })) as JoiHomeFeedDto["goals"];
    const attention = goals.find((goal) => goal.status === "NEEDS_ATTENTION");
    if (attention !== undefined) goals.push({ ...attention, clarification: { reasonCode: "question_required" }, goalId: "goal-attention-fallback", title: "缺少提示的任务" });
    const connection: RemoteJoiConnection = {
      feed: vi.fn().mockResolvedValue({ goals, thinking: [], unassignedActions: [] }),
      sendMessage: vi.fn().mockRejectedValue(new Error("offline")),
      status: () => "connecting",
    };

    render(<RemoteJoiApp connection={connection} />);
    expect(await screen.findByText("请选择下一步")).toBeInTheDocument();
    expect(screen.getByText("这个任务需要你回到桌面确认。")).toBeInTheDocument();
    expect(screen.getByText("任务已经完成")).toBeInTheDocument();
    expect(screen.getAllByText("joi 正在梳理")).toHaveLength(9);
    expect(screen.getByText("1 项异常")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "给 joi 发消息" }), { target: { value: "再试一次" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("消息没能送达，请等连接恢复后重试。")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "给 joi 发消息" })).toHaveValue("再试一次");
  });

  it("shows a disconnected empty state when no browser credential can connect", async () => {
    const connection: RemoteJoiConnection = {
      feed: vi.fn().mockRejectedValue(new Error("not paired")),
      sendMessage: vi.fn(),
      status: () => "disconnected",
    };
    render(<RemoteJoiApp connection={connection} />);
    expect(await screen.findByText("连接已断开")).toBeInTheDocument();
    const textbox = screen.getByRole("textbox", { name: "给 joi 发消息" });
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    const form = textbox.closest("form");
    expect(form).not.toBeNull();
    if (form !== null) fireEvent.submit(form);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(connection.sendMessage).not.toHaveBeenCalled();
  });
});
