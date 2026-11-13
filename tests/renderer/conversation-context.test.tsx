// @vitest-environment jsdom
import { fireEvent,render,screen,within } from "@testing-library/react";
import { ConversationContext } from "../../src/renderer/ConversationContext.js";
import type { ConversationDto } from "../../src/shared/conversations.js";

it("REL-04 shows bounded model recovery separately from context compaction",() => {
  const context = { kind: "CHARACTERS" as const,state: "BACKOFF" as const,recovery: { state: "RETRYING" as const,attempt: 2,maxAttempts: 3,nextRetryAt: "2026-11-13T00:00:02Z" } };
  const view = render(<ConversationContext conversation={{ context }} />);
  expect(screen.getByRole("status")).toHaveTextContent("正在恢复模型连接（2/3）");
  expect(screen.getByRole("status")).toHaveTextContent("摘要稍后重试");
  view.rerender(<ConversationContext conversation={{ context: { ...context,recovery: { state: "RECOVERED",attempt: 2,maxAttempts: 3 } } }} />);
  expect(screen.getByRole("status")).toHaveTextContent("模型连接已恢复");
});

it("CHAT-23 shows character estimates, safe compression and child state with cancellation",() => {
  const chat: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "Title",updatedAt: "2026-11-11",turns: [],
    context: { kind: "CHARACTERS",state: "BACKOFF",requestChars: 51060,budgetChars: 55000,activityAt: "2026-11-11T00:00:00Z",missingHistory: true },
    children: [{ childId: "child",status: "RUNNING" }] };
  const cancel = vi.fn();const view = render(<ConversationContext conversation={chat} onCancel={cancel} />);
  expect(screen.getByRole("status")).toHaveTextContent("51060 / 55000");expect(screen.getByRole("status")).toHaveTextContent("摘要稍后重试");
  expect(screen.queryByText("导入历史不含完整的私有工具记录。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(/子代理：/));fireEvent.click(screen.getByRole("button",{ name: "取消" }));expect(cancel).toHaveBeenCalledWith("child");
  view.rerender(<ConversationContext conversation={{ ...chat,context: { kind: "NATIVE",state: "READY" },children: [] }} onCancel={cancel} />);
  expect(screen.getByRole("status")).toHaveTextContent("上下文由原生引擎管理");expect(screen.queryByText(/51060/)).not.toBeInTheDocument();
});

it.each([
  ["READY","上下文已就绪"],["COMPACTING","正在摘要历史"],["COMPRESSED","历史已摘要"],
  ["TRIMMED","本次请求已省略部分历史"],["CAPACITY","上下文容量不足"],
] as const)("CHAT-23 identifies %s without inventing usage before an estimate arrives",(state,label) => {
  const chat: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "Title",updatedAt: "2026-11-11",turns: [],context: { kind: "CHARACTERS",state } };
  const view = render(<ConversationContext conversation={chat} onCancel={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent(label);
  expect(screen.getByRole("status")).not.toHaveTextContent("等待上下文估算");
  expect(view.container.querySelector("time")).toBeNull();
  view.rerender(<ConversationContext conversation={{ ...chat,context: { kind: "CHARACTERS",state,requestChars: 0 } }} onCancel={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("0 / 0");
});

it("CHAT-23 keeps terminal child outcomes visible and permits cancellation only for active children",() => {
  const chat: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "Title",updatedAt: "2026-11-11",turns: [] };
  const cancel = vi.fn(),view = render(<ConversationContext conversation={chat} onCancel={cancel} />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<ConversationContext conversation={{ ...chat,children: [
    { childId: "queued",status: "QUEUED" },{ childId: "done",status: "COMPLETED" },{ childId: "canceled",status: "CANCELED" },
    { childId: "interrupted",status: "INTERRUPTED" },{ childId: "failed",status: "FAILED" },
  ] }} onCancel={cancel} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(/子代理：/));
  const rows = screen.getAllByRole("listitem");
  expect(rows.map(row => row.textContent)).toEqual([
    expect.stringContaining("等待执行"),expect.stringContaining("已完成"),expect.stringContaining("已停止"),
    expect.stringContaining("执行已中断"),expect.stringContaining("未能完成"),
  ]);
  const queued = rows[0];if (queued === undefined) throw new Error("Missing queued child");
  fireEvent.click(within(queued).getByRole("button",{ name: "取消" }));
  expect(cancel).toHaveBeenCalledWith("queued");expect(screen.getAllByRole("button",{ name: "取消" })).toHaveLength(1);
});
