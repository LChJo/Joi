// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RemoteJoiApp, type RemoteJoiConnection } from "../../src/renderer/RemoteJoiApp.js";
import type { JoiHomeFeedDto } from "../../src/shared/joi.js";
import type { RemoteCommand } from "../../src/shared/remote";

describe("RemoteJoiApp", () => {
  it("loads shared conversation history and sends through the paired channel without desktop controls", async () => {
    const chat = { conversationId: "chat",workbenchId: "wb",title: "已有对话",updatedAt: "2026-11-14",turns: [{ turnId: "turn",text: "原问题",status: "COMPLETED",createdAt: "2026-11-14",config: { partnerId: "joi-chat",partnerName: "joi",networkId: "network",networkName: "网络",modelName: "Model",skills: [],attachmentIds: [] },artifacts: [],entries: [{ entryId: "entry",kind: "MARKDOWN",role: "AGENT",text: "已有回复" }] }] };
    const invoke = vi.fn().mockImplementation((command: RemoteCommand) => {
      switch (command.kind) {
        case "conversation.catalog": return Promise.resolve({ workbenches: [{ workbenchId: "wb",name: "项目" }],networks: [{ sourceId: "network",displayName: "网络",status: "READY",activeModel: { id: "Model" } }],partners: [] });
        case "conversation.skills": return Promise.resolve({ items: [] });
        case "conversation.inheritance": return Promise.resolve({ memoryCount: 0,evolutionRevisionId: null });
        case "conversation.list": return Promise.resolve({ items: [chat] });
        case "conversation.get": return Promise.resolve(chat);
        case "conversation.send": return Promise.resolve({ ...chat,turns: [...chat.turns,{ ...chat.turns[0],turnId: "second",text: command.input.text,entries: [{ entryId: "second-reply",kind: "MARKDOWN",role: "AGENT",text: "远程回复" }] }] });
        default: return Promise.reject(new Error("unexpected_command"));
      }
    });
    const connection: RemoteJoiConnection = { feed: vi.fn().mockResolvedValue({ goals: [],thinking: [],unassignedActions: [] }),sendMessage: vi.fn(),status: () => "connected",command: <T,>(command: RemoteCommand) => invoke(command) as Promise<T> };
    const view = render(<RemoteJoiApp connection={connection} />);
    fireEvent.click(screen.getByRole("button",{ name: "对话" }));
    fireEvent.click(await screen.findByText("已有对话"));
    expect(await screen.findByText("已有回复")).toBeInTheDocument();
    expect(screen.queryByRole("button",{ name: "显示或收起工作区" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{ name: "附件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{ name: "对话设置" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "在手机继续" } });
    fireEvent.click(screen.getByRole("button",{ name: "发送消息" }));
    expect(await screen.findByText("远程回复")).toBeInTheDocument();
    const sendCommand = invoke.mock.calls.map(call => call[0] as RemoteCommand).find(command => command.kind === "conversation.send");
    expect(sendCommand?.kind).toBe("conversation.send");
    if (sendCommand?.kind === "conversation.send") expect(sendCommand.input).toMatchObject({ conversationId: "chat",text: "在手机继续",workbenchId: "wb" });
    const originalWidth = window.innerWidth;
    const toggleHistory = screen.getByRole("button",{ name: "显示或收起对话列表" });
    const resize = (width: number) => { Object.defineProperty(window,"innerWidth",{ configurable: true,value: width });fireEvent(window,new Event("resize")); };
    try {
      expect(toggleHistory).toHaveAttribute("aria-expanded","true");
      resize(390);expect(toggleHistory).toHaveAttribute("aria-expanded","false");
      resize(1440);expect(toggleHistory).toHaveAttribute("aria-expanded","true");
      fireEvent.click(toggleHistory);resize(390);resize(1440);
      expect(toggleHistory).toHaveAttribute("aria-expanded","false");
    } finally { resize(originalWidth); }
    fireEvent.click(screen.getByRole("button",{ name: "归档对话" }));
    expect(await screen.findByRole("button",{ name: "已有对话" })).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ kind: "conversation.list",archived: true }));
    view.unmount();
  });

  it("offers conversations alongside tasks in the remote browser", async () => {
    const connection: RemoteJoiConnection = {
      feed: vi.fn().mockResolvedValue({ goals: [], thinking: [], unassignedActions: [] }),
      sendMessage: vi.fn(),
      status: () => "connected",
    };
    render(<RemoteJoiApp connection={connection} />);
    expect(await screen.findByRole("button", { name: "对话" })).toBeInTheDocument();
  });

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
      "ARRANGING", "ARRANGED", "REVIEWING", "EXTENDING", "FINALIZING", "COMPLETED", "COMPLETED_WITH_GAPS", "NEEDS_ATTENTION", "FAILED", "CANCELED",
    ];
    const goals = statuses.map((status, index) => ({
      agentCount: 1,
      canDelete: false,
      clarification: status === "NEEDS_ATTENTION" ? { prompt: "请选择下一步", reasonCode: "question_required" } : { reasonCode: "none" },
      completionSummary: status === "COMPLETED" || status === "COMPLETED_WITH_GAPS" ? "任务已经完成" : undefined,
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
    expect(screen.getAllByText("任务已经完成")).toHaveLength(2);
    expect(screen.getAllByText("joi 正在梳理")).toHaveLength(10);
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
