// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";

import { SettingsPanel, SystemPanel, Timeline } from "../../src/renderer/Console";
import { DigitalLifeApi } from "../../src/renderer/api";
import type { DiagnosticsDto, ExpressionDto, LifeEventDto } from "../../src/renderer/types";
import { formatDate, initials, isoToLocalDateTime, localDateTimeToIso } from "../../src/renderer/view-utils";

const diagnostics: DiagnosticsDto = { agents: { connections: 0 }, database: { journalMode: "wal", state: "open" }, runtime: { pendingOutbox: 0 }, schemaVersion: 4, sse: { events: 0 }, web: { sessions: 0 } };
const human: LifeEventDto = {
  attemptCount: 0, availableAt: "2026-07-15T12:00:00Z", createdAt: "2026-07-15T12:00:00Z", eventId: "event_1",
  lifeId: "life_1", occurredAt: "2026-07-15T12:00:00Z", payload: { text: "已读消息" }, priority: 1,
  source: "human", status: "CONSUMED", type: "human.message",
};
const expression: ExpressionDto = { actionId: "action_1", createdAt: "2026-07-15T13:00:00Z", expressionId: "expression_1", lifeId: "life_1", text: "稍后表达", wakeId: "wake_1" };

describe("renderer edge components", () => {
  it("formats fallback values and covers empty and undelivered timelines", () => {
    const api = new DigitalLifeApi("http://127.0.0.1:43130");
    expect(initials("  ")).toBe("JO");
    expect(formatDate("2026-07-15T12:00:00Z")).toMatch(/07/);
    expect(formatDate("invalid", "Invalid/Zone")).toBe("invalid");
    expect(localDateTimeToIso("2026-07-16T08:30", "Asia/Shanghai")).toBe("2026-07-16T00:30:00.000Z");
    expect(initials("digital life")).toBe("DI");
    expect(() => localDateTimeToIso("not-a-date", "UTC")).toThrow("invalid");
    expect(isoToLocalDateTime("2026-07-16T00:30:00.000Z", "Asia/Shanghai")).toBe("2026-07-16T08:30");
    expect(() => localDateTimeToIso("2026-03-08T02:30", "America/New_York")).toThrow("do not exist");
    const view = render(<Timeline api={api} events={[]} expressions={[]} timezone="UTC" />);
    expect(screen.getByText("还没有活动")).toBeInTheDocument();
    view.rerender(<Timeline api={api} events={[human]} expressions={[expression]} timezone="UTC" />);
    expect(screen.getByText("已读取")).toBeInTheDocument();
    expect(screen.getByText("稍后表达")).toBeInTheDocument();
    view.rerender(<Timeline api={api} events={[
      { ...human, eventId: "artifact_1", payload: { artifactId: "managed_1", filename: "report.pdf", mimeType: "application/pdf", size: 2048 }, source: "agent", type: "agent.artifact_created" },
      { ...human, eventId: "artifact_2", payload: {}, source: "agent", type: "agent.artifact_created" },
      { ...human, eventId: "attachment_message", payload: { attachments: [null, [], "bad", { filename: "brief.txt", size: 1024 }], text: "附件消息" } },
    ]} expressions={[]} timezone="UTC" />);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("未命名文件")).toBeInTheDocument();
    expect(screen.getAllByText("由 joi 保存，每次打开会检查完整性")).toHaveLength(2);
    expect(screen.getByText(/brief.txt/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "预览" })).toHaveAttribute("href", expect.stringContaining("managed_1"));
    view.rerender(<Timeline activity={[
      { activityId: "flow_empty", details: {}, endedAt: "2026-07-15T13:00:00Z", kind: "FLOW", startedAt: "2026-07-15T12:00:00Z", status: "COMPLETED", title: "无详情活动" },
      { activityId: "flow_unknown", details: {}, kind: "FLOW", startedAt: "2026-07-15T14:00:00Z", status: "UNKNOWN", title: "未知活动" },
    ]} api={api} events={[]} expressions={[]} timezone="UTC" />);
    expect(screen.getByText("过程已保存")).toBeInTheDocument();
    expect(screen.getByText("待确认")).toBeInTheDocument();
  });

  it("renders diagnostic loading, healthy-empty interactions, and unknown schema", () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "listBackups").mockResolvedValue({ items: [] });
    const view = render(<SystemPanel diagnostics={null} interactions={[]} />);
    expect(screen.getByLabelText("joi 正在整理页面")).toBeInTheDocument();
    view.rerender(<SystemPanel diagnostics={diagnostics} interactions={[]} />);
    expect(screen.getByText("0 项待处理")).toBeInTheDocument();
    view.rerender(<SystemPanel diagnostics={{ ...diagnostics, web: { lan: { status: 42 }, sessions: 1 } }} interactions={[{ createdAt: "now", interactionId: "i", invocationId: "v", kind: "input-required", prompt: "p", status: "PENDING" }]} />);
    expect(screen.getByText("待确认")).toBeInTheDocument();
    expect(screen.getByText("需要关注")).toBeInTheDocument();
    view.rerender(<SettingsPanel api={api} diagnostics={null} />);
    expect(screen.getByText(/数据格式 v-/)).toBeInTheDocument();
  });
});
