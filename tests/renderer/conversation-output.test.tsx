// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { ConversationOutput } from "../../src/renderer/ConversationOutput";
import type { AgentConversationEntryDto } from "../../src/shared/joi";
import type { ConversationEntryDto } from "../../src/shared/conversations";
import type { UserQuestionDto } from "../../src/shared/user-questions";

const thinking = (id: string,summary?: string): ConversationEntryDto => ({ entryId: id,kind: "ACTIVITY",role: "SYSTEM",sequence: 1,createdAt: "2026-11-12",activity: { type: "THINKING",thinking: { phaseId: id,state: "COMPLETED",durationMs: 1250,...(summary === undefined ? {} : { summary }) } } });

it("ASK-09 compacts the active question and defaults to a single answered summary with expandable details", () => {
  const question: UserQuestionDto = {
    questionId: "ask-model", version: 1, scope: { kind: "CONVERSATION", id: "chat" }, ownerId: "turn",
    sourceName: "joi", question: "Which model should we test first?", kind: "QUESTION",
    options: [{ id: "qwen", label: "Qwen4-Max", recommended: true }], multiSelect: false, allowCustom: true,
    defaultAnswer: "Qwen4-Max", defaultOptionIds: ["qwen"], status: "ACTIVE", delivery: "PENDING",
    createdAt: "2026-11-19T10:01:00.000Z", expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const view = render(<ConversationOutput entries={[]} questions={[question]} status="RUNNING" />);
  expect(screen.getByRole("textbox")).toHaveAttribute("rows", "2");
  expect(screen.getByRole("timer")).toBeVisible();
  expect(screen.getByRole("button", { name: "采用推荐并继续" })).toBeEnabled();
  view.rerender(<ConversationOutput entries={[]} status="COMPLETED" questions={[{ ...question, status: "ANSWERED", delivery: "DELIVERED",
    answer: { text: "Qwen4-Max", selectedOptionIds: ["qwen"], source: "USER_DEFAULT", answeredAt: "2026-11-19T10:02:00.000Z" },
  }]} />);
  const summary = view.container.querySelector("summary");
  expect(summary).toHaveTextContent("Which model should we test first?");
  expect(summary).toHaveTextContent("Qwen4-Max");
  expect(summary?.parentElement).not.toHaveAttribute("open");
  expect(screen.getByText("回答已交付。")).not.toBeVisible();
  if (summary === null) throw new Error("Missing question summary");
  fireEvent.click(summary);
  expect(screen.getByText("来自 joi")).toBeVisible();
  expect(screen.getByText("你采用了推荐回答")).toBeVisible();
  expect(screen.getByText("回答已交付。")).toBeVisible();
});

it("CHAT-36 shows only the last thinking phase across prose and tool groups, with expandable details",() => {
  const entries: ConversationEntryDto[] = [thinking("old","Earlier summary"),tool("read","read","TOOL_CALL","1"),tool("done","read","TOOL_RESULT","1"),{ entryId: "answer",kind: "MARKDOWN",role: "AGENT",text: "Progress answer",sequence: 2,createdAt: "2026-11-12" },thinking("latest","Latest public summary")];
  const view = render(<ConversationOutput entries={entries} status="RUNNING" />);
  expect(view.container).not.toHaveTextContent("Earlier summary");
  expect(screen.getAllByText(/思考完成/)).toHaveLength(1);
  expect(screen.getByText("Progress answer")).toBeVisible();expect(screen.getAllByText("read").length).toBeGreaterThan(0);
  const summary = screen.getByText(/思考完成/).closest("summary");if (summary === null) throw new Error("Missing thinking disclosure");
  expect(screen.getByText("Latest public summary")).not.toBeVisible();fireEvent.click(summary);
  expect(screen.getByText("Latest public summary")).toBeVisible();
  view.rerender(<ConversationOutput entries={[...entries,thinking("new","Newest public summary")]} status="COMPLETED" />);
  expect(screen.queryByText("Latest public summary")).not.toBeInTheDocument();expect(screen.getAllByText(/思考完成/)).toHaveLength(1);
  expect(screen.getByText("Newest public summary")).toBeVisible();
});

it("CHAT-36 bounds expanded thinking details by Unicode length and omits empty details",() => {
  const view = render(<ConversationOutput entries={[thinking("latest","想🙂".repeat(700) + "OMITTED_END")]} status="COMPLETED" />);
  const summary = screen.getByText(/思考完成/).closest("summary");if (summary === null) throw new Error("Missing thinking disclosure");fireEvent.click(summary);
  const details = screen.getByText(/^想🙂/);
  expect(details).toBeVisible();expect(Array.from(details.textContent)).toHaveLength(1201);expect(details.textContent.endsWith("🙂…")).toBe(true);
  expect(view.container).not.toHaveTextContent("OMITTED_END");expect(screen.getByText("摘要已省略部分内容")).toBeVisible();
  view.rerender(<ConversationOutput entries={[thinking("latest")]} status="COMPLETED" />);
  expect(screen.getAllByText(/思考完成/)).toHaveLength(1);expect(screen.queryByText("摘要已省略部分内容")).not.toBeInTheDocument();
});

it("CHAT-27 keeps thinking and context in the tool disclosure through streaming",() => {
  const activity: ConversationEntryDto = { entryId: "phase",kind: "ACTIVITY",role: "SYSTEM",sequence: 1,createdAt: "2026-11-12",activity: { type: "THINKING",thinking: { phaseId: "phase",state: "STARTED" } } };
  const entries = [activity,tool("read","read","TOOL_CALL","1")];
  const view = render(<ConversationOutput entries={entries} status="RUNNING" context={{ kind: "CHARACTERS",state: "COMPACTING",requestChars: 100,budgetChars: 1000,missingHistory: true }} />);
  const summary = view.container.querySelector("summary");if (summary === null) throw new Error("Missing activity summary");
  expect(summary).toHaveTextContent("正在思考");expect(summary).toHaveTextContent("正在摘要历史");expect(summary).toHaveTextContent("共 1 次");
  fireEvent.click(summary);expect(screen.getByRole("status")).toHaveTextContent("100 / 1000");
  view.rerender(<ConversationOutput entries={[{ ...activity,activity: { type: "THINKING",thinking: { phaseId: "phase",state: "COMPLETED",durationMs: 1250,summary: "Public summary",summaryTruncated: true } } },...entries.slice(1),tool("done","read","TOOL_RESULT","1")]} status="COMPLETED" />);
  expect(view.container.querySelector("details")).toHaveAttribute("open");expect(screen.getByText("Public summary")).toBeVisible();expect(summary).toHaveTextContent("思考完成");
  expect(view.container).toHaveTextContent("摘要已省略部分内容");expect(view.container).not.toHaveTextContent("PRIVATE_TOOL_BODY");
});

it("CHAT-27 renders an activity-only row ahead of prose when tools have not started",() => {
  const view = render(<ConversationOutput entries={[{ entryId: "answer",kind: "MARKDOWN",role: "AGENT",text: "Answer",sequence: 1,createdAt: "2026-11-12" }]} status="RUNNING" context={{ kind: "CHARACTERS",state: "READY" }} />);
  expect(view.container.firstElementChild?.tagName).toBe("DETAILS");expect(view.container).not.toHaveTextContent("等待上下文估算");
  expect(view.container.querySelector("summary")).not.toHaveTextContent("共 0 次");expect(view.container.lastElementChild).toHaveTextContent("Answer");
});

it("CHAT-23 hides standalone context metadata in completed replies",() => {
  const answer: ConversationEntryDto = { entryId: "answer",kind: "MARKDOWN",role: "AGENT",text: "Answer",sequence: 1,createdAt: "2026-11-12" };
  const ready = { kind: "CHARACTERS",state: "READY" } as const;
  const trailing: ConversationEntryDto = { entryId: "context",kind: "ACTIVITY",role: "SYSTEM",sequence: 2,createdAt: "2026-11-12",activity: { type: "CONTEXT",context: ready } };
  const view = render(<ConversationOutput entries={[answer,trailing]} status="RUNNING" />);
  expect(screen.getByText("上下文已就绪",{ selector: "summary span" })).toBeVisible();
  view.rerender(<ConversationOutput entries={[answer,trailing]} status="COMPLETED" />);
  expect(screen.queryAllByText("上下文已就绪")).toHaveLength(0);
  view.rerender(<ConversationOutput entries={[answer]} context={ready} status="COMPLETED" />);
  expect(view.container.querySelector("details")).toBeNull();
  expect(screen.getByText("Answer")).toBeVisible();
  view.rerender(<ConversationOutput entries={[tool("read","read","TOOL_RESULT"),answer]} context={ready} status="COMPLETED" />);
  const summary = view.container.querySelector("summary");if (summary === null) throw new Error("Missing tool disclosure");
  expect(summary).not.toHaveTextContent("上下文已就绪");
  fireEvent.click(summary);
  expect(screen.getByRole("status")).toHaveTextContent("上下文已就绪");
});

const tool = (id: string,name: string,kind: "TOOL_CALL" | "TOOL_RESULT",callId?: string): AgentConversationEntryDto => ({ entryId: id,toolName: name,kind,role: "TOOL",sequence: 1,createdAt: "2026-11-11",...(callId === undefined ? {} : { toolCallId: callId }),...(kind === "TOOL_RESULT" ? { text: "PRIVATE_TOOL_BODY" } : {}) });
it("CHAT-16 collapses paired calls/results, shows the latest tool and expands calls in order", () => {
  const entries = [tool("one","ls","TOOL_CALL","1"),tool("one-done","ls","TOOL_RESULT","1"),tool("two","bash","TOOL_CALL","2"),tool("two-done","bash","TOOL_RESULT","2")];
  const { container } = render(<ConversationOutput entries={entries} status="COMPLETED" />);
  const summary = container.querySelector("summary");if (summary === null) throw new Error("Missing tool summary");
  expect(summary).toHaveTextContent("bash");expect(summary).toHaveTextContent("共 2 次");expect(container.querySelector("details")).not.toHaveAttribute("open");
  expect(screen.getByText("ls")).not.toBeVisible();expect(screen.queryByText("PRIVATE_TOOL_BODY")).not.toBeInTheDocument();
  fireEvent.click(summary);expect(screen.getByText("ls")).toBeVisible();expect(container.querySelectorAll("li")).toHaveLength(2);
});
it("CHAT-16 keeps expanded groups stable during streaming and preserves prose, artifact and error order", () => {
  const entries: AgentConversationEntryDto[] = [tool("read","read","TOOL_CALL")];
  const view = render(<ConversationOutput entries={entries} status="RUNNING" />);
  const summary = view.container.querySelector("summary");if (summary === null) throw new Error("Missing summary");fireEvent.click(summary);
  view.rerender(<ConversationOutput entries={[...entries,tool("done","read","TOOL_RESULT"),tool("write","write","TOOL_CALL")]} status="RUNNING" />);
  expect(view.container.querySelector("details")).toHaveAttribute("open");expect(summary).toHaveTextContent("write");
  view.rerender(<ConversationOutput entries={[...entries,tool("done","read","TOOL_RESULT"),{ entryId: "answer",kind: "MARKDOWN",role: "AGENT",text: "## Answer",sequence: 2,createdAt: "2026-11-11" },tool("next","ls","TOOL_RESULT"),{ entryId: "artifact",kind: "ARTIFACT",role: "AGENT",sequence: 3,createdAt: "2026-11-11",artifact: { name: "report.md",size: 1,kind: "FILE",mimeType: "text/markdown" } },{ entryId: "error",kind: "ERROR",role: "SYSTEM",sequence: 4,createdAt: "2026-11-11",text: "Safe failure" }]} status="FAILED" />);
  expect(view.container.querySelectorAll("details")).toHaveLength(2);expect(screen.getByRole("heading",{ name: "Answer" })).toBeInTheDocument();expect(screen.getByText("report.md")).toBeInTheDocument();expect(screen.getByText("Safe failure")).toBeInTheDocument();
});
it("CHAT-16 handles repeated identities, nameless results, stopped calls and empty output without exposing tool bodies", () => {
  const view = render(<ConversationOutput entries={[]} status="COMPLETED" />);expect(view.container).toBeEmptyDOMElement();
  const call = tool("one","bash","TOOL_CALL","same");
  view.rerender(<ConversationOutput entries={[call,{ ...call,entryId: "repeat" },tool("result","bash","TOOL_RESULT","same")]} status="COMPLETED" />);
  expect(screen.getByText("共 1 次")).toBeInTheDocument();
  const orphan = tool("orphan","unused","TOOL_RESULT");delete orphan.toolName;
  view.rerender(<ConversationOutput entries={[orphan]} status="COMPLETED" />);expect(view.container.querySelector("summary")).toHaveTextContent("工具");
  view.rerender(<ConversationOutput entries={[call]} status="STOPPED" />);expect(view.container.querySelector("summary")).toHaveTextContent("已停止");
  view.rerender(<ConversationOutput entries={[call]} status="QUEUED" />);expect(view.container.querySelector("summary")).toHaveTextContent("执行中");expect(view.container).not.toHaveTextContent("PRIVATE_TOOL_BODY");
});
it("CHAT-17 shows safe arguments and truthful status in the latest summary and each expanded call", () => {
  const first = { ...tool("read","read","TOOL_CALL","read"),text: "src/runtime.ts" };
  const latest = { ...tool("bash","bash","TOOL_CALL","bash"),text: "grep -n memory src/runtime.ts" };
  const view = render(<ConversationOutput entries={[first,tool("read-result","read","TOOL_RESULT","read"),latest]} status="RUNNING" />);
  const summary = view.container.querySelector("summary");if (summary === null) throw new Error("Missing summary");
  expect(summary).toHaveTextContent("grep -n memory src/runtime.ts");expect(summary).toHaveTextContent("执行中");
  expect(summary.querySelector("code")).toHaveAttribute("title","grep -n memory src/runtime.ts");
  fireEvent.click(summary);
  expect(view.container.querySelector("li")).toHaveTextContent("src/runtime.ts");expect(view.container.querySelector("li")).toHaveTextContent("已完成");
  view.rerender(<ConversationOutput entries={[first,tool("read-result","read","TOOL_RESULT","read"),latest,{ ...tool("failed","bash","TOOL_RESULT","bash"),toolState: "failed" }]} status="RUNNING" />);
  expect(summary).toHaveTextContent("执行失败");expect(view.container.querySelector("details")).toHaveAttribute("open");
  expect(view.container.querySelector("li:last-child")).toHaveAttribute("data-tool-state","failed");
  expect(view.container.querySelectorAll("li")).toHaveLength(2);expect(view.container).not.toHaveTextContent("PRIVATE_TOOL_BODY");
});
it("CHAT-17 preserves recorded legacy failures and distinguishes missing parameters, interruption and unknown results", () => {
  const call = { ...tool("call","bash","TOOL_CALL","call"),text: " \n " };
  const view = render(<ConversationOutput entries={[call,{ ...tool("failed","bash","TOOL_RESULT","call"),text: "执行失败" }]} status="COMPLETED" />);
  expect(view.container.querySelector("summary")).toHaveTextContent("执行失败");expect(view.container.querySelector("summary")).toHaveTextContent("参数未记录");
  view.rerender(<ConversationOutput entries={[call]} status="INTERRUPTED" />);expect(view.container.querySelector("summary")).toHaveTextContent("已中断");
  view.rerender(<ConversationOutput entries={[call]} status="COMPLETED" />);expect(view.container.querySelector("summary")).toHaveTextContent("未记录结果");
});
