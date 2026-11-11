// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DigitalLifeApi, ApiError } from "../../src/renderer/api";
import { ConversationPage } from "../../src/renderer/ConversationPage";
import { ArchivePage } from "../../src/renderer/ArchivePage";
import { ConversationHistoryRow } from "../../src/renderer/ConversationHistoryRow";
import type { ConversationDto } from "../../src/shared/conversations";

const chat: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "讨论设计",updatedAt: "2026-11-11T08:00:00Z",turns: [] };
function setup() {
  const api = new DigitalLifeApi("",true);
  vi.spyOn(api,"listWorkbenches").mockResolvedValue({ items: [{ workbenchId: "wb",name: "设计项目",scopeSummary: "Design",updatedAt: chat.updatedAt }] });
  const list = vi.spyOn(api,"listConversations").mockResolvedValue({ items: [chat] });
  const get = vi.spyOn(api,"getConversation").mockResolvedValue(chat);
  vi.spyOn(api,"listPartners").mockResolvedValue({ items: [] });
  vi.spyOn(api,"listModelSources").mockResolvedValue({ items: [] });
  vi.spyOn(api,"conversationInheritance").mockResolvedValue({ memoryCount: 0,evolutionRevisionId: null });
  vi.spyOn(api,"request").mockResolvedValue({ items: [] });
  const archive = vi.spyOn(api,"archiveConversation").mockResolvedValue({ changed: true });
  const restore = vi.spyOn(api,"restoreConversation").mockResolvedValue({ changed: true });
  const remove = vi.spyOn(api,"deleteConversation").mockResolvedValue({ changed: true });
  return { api,list,get,archive,restore,remove };
}

it("CHAT-13 shows compact titles and a focus tooltip, archives the selected conversation and clears its composer", async () => {
  const { api,list,archive } = setup();
  const view = render(<ConversationPage api={api} onSettings={vi.fn()} />);
  const row = await screen.findByRole("button",{ name: "讨论设计" });
  expect(screen.queryByText("和 AI 一起，把事情做好")).not.toBeInTheDocument();
  expect(row.querySelector("small")).toBeNull();
  fireEvent.focus(row);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip).toHaveTextContent("讨论设计");expect(tooltip).toHaveTextContent("设计项目");expect(tooltip).toHaveTextContent("2026");
  fireEvent.keyDown(row,{ key: "Escape" });expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.click(row);await waitFor(() => expect(screen.getByText("设计项目 · 对话")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button",{ name: "对话操作 讨论设计" }));
  list.mockResolvedValue({ items: [] });fireEvent.click(screen.getByRole("menuitem",{ name: "归档" }));
  await waitFor(() => expect(archive).toHaveBeenCalledWith("chat"));
  await screen.findByText("今天想一起做点什么？");
  expect(screen.queryByRole("button",{ name: "讨论设计" })).not.toBeInTheDocument();
  view.unmount();render(<ConversationPage api={api} onSettings={vi.fn()} />);
  await screen.findByText("今天想一起做点什么？");
});

it("CHAT-14 searches, reads and restores archived conversations without starting execution", async () => {
  const { api,list,restore } = setup();
  list.mockResolvedValue({ items: [{ ...chat,archivedAt: chat.updatedAt }] });
  vi.spyOn(api,"joiHomeFeed").mockReturnValue(new Promise(() => undefined));
  vi.spyOn(api,"joiSnapshot").mockReturnValue(new Promise(() => undefined));
  render(<ArchivePage api={api} />);
  fireEvent.click(screen.getByRole("tab",{ name: "对话" }));
  await screen.findByRole("button",{ name: "讨论设计" });expect(list).toHaveBeenCalledWith(true);
  fireEvent.change(screen.getByRole("searchbox",{ name: "搜索归档对话…" }),{ target: { value: "不存在" } });
  expect(screen.queryByRole("button",{ name: "讨论设计" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("searchbox",{ name: "搜索归档对话…" }),{ target: { value: "设计项目" } });
  fireEvent.click(screen.getByRole("button",{ name: "讨论设计" }));
  const dialog = await screen.findByRole("dialog",{ name: "讨论设计" });expect(within(dialog).getByText("设计项目")).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button",{ name: "关闭" }));
  list.mockResolvedValue({ items: [] });fireEvent.click(screen.getByRole("button",{ name: "恢复" }));
  await waitFor(() => expect(restore).toHaveBeenCalledWith("chat"));await waitFor(() => expect(screen.queryByRole("button",{ name: "讨论设计" })).not.toBeInTheDocument());
});

it("CHAT-14 confirms deletion, keeps the row on failure and allows retry", async () => {
  const { api,list,remove } = setup();remove.mockRejectedValueOnce(new ApiError("fixture_failed","请重试",503));
  vi.spyOn(api,"joiHomeFeed").mockReturnValue(new Promise(() => undefined));
  vi.spyOn(api,"joiSnapshot").mockReturnValue(new Promise(() => undefined));
  render(<ArchivePage api={api} />);fireEvent.click(screen.getByRole("tab",{ name: "对话" }));
  fireEvent.click(await screen.findByRole("button",{ name: "删除" }));
  fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button",{ name: "取消" }));expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{ name: "删除" }));fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button",{ name: "删除" }));
  await screen.findByRole("alert");expect(screen.getByRole("button",{ name: "讨论设计" })).toBeInTheDocument();
  list.mockResolvedValue({ items: [] });fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button",{ name: "删除" }));
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
});

it("CHAT-13 disables archive/delete while a conversation is active", async () => {
  const { api,list,remove } = setup();list.mockResolvedValue({ items: [{ ...chat,canArchive: false }] });
  render(<ConversationPage api={api} onSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button",{ name: "对话操作 讨论设计" }));
  expect(screen.getByRole("menuitem",{ name: "归档" })).toBeDisabled();expect(screen.getByRole("menuitem",{ name: "删除" })).toBeDisabled();
  fireEvent.keyDown(document,{ key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();expect(screen.getByRole("button",{ name: "对话操作 讨论设计" })).toHaveFocus();
  expect(remove).not.toHaveBeenCalled();
});

it("CHAT-14 retries unavailable archives, opens a formatted transcript with an unknown workbench, and recovers a failed restore", async () => {
  const { api,list,get,restore } = setup();
  list.mockRejectedValueOnce(new Error("Unavailable"));
  vi.spyOn(api,"listWorkbenches").mockResolvedValue({ items: [] });
  get.mockResolvedValue({ ...chat,turns: [{ turnId: "turn",text: "Question",createdAt: chat.updatedAt,status: "COMPLETED",config: { partnerId: "joi-chat",partnerName: "joi",networkId: "net",networkName: "Network",modelName: "Model",skills: [],attachmentIds: [] },artifacts: [],entries: [
    { entryId: "answer",sequence: 1,createdAt: chat.updatedAt,kind: "MARKDOWN",role: "AGENT",text: "## Saved answer" },
    { entryId: "tool",sequence: 2,createdAt: chat.updatedAt,kind: "TOOL_CALL",role: "TOOL",toolName: "read" },
    { entryId: "error",sequence: 3,createdAt: chat.updatedAt,kind: "ERROR",role: "SYSTEM" },
  ] }] });
  vi.spyOn(api,"joiHomeFeed").mockReturnValue(new Promise(() => undefined));vi.spyOn(api,"joiSnapshot").mockReturnValue(new Promise(() => undefined));
  render(<ArchivePage api={api} />);
  const tabs = screen.getByRole("tablist");fireEvent.keyDown(tabs,{ key: "End" });expect(screen.getByRole("tab",{ name: "对话" })).toHaveFocus();
  await screen.findByRole("alert");fireEvent.click(screen.getByRole("button",{ name: "重试" }));
  fireEvent.click(await screen.findByRole("button",{ name: "讨论设计" }));
  const dialog = await screen.findByRole("dialog");expect(within(dialog).getByRole("heading",{ name: "Saved answer" })).toBeInTheDocument();expect(within(dialog).getByText("wb")).toBeInTheDocument();expect(within(dialog).queryByText("read")).not.toBeInTheDocument();
  fireEvent.keyDown(document,{ key: "Escape" });expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  restore.mockRejectedValueOnce(new Error("Unavailable"));fireEvent.click(screen.getByRole("button",{ name: "恢复" }));await screen.findByRole("alert");expect(screen.getByRole("button",{ name: "讨论设计" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{ name: "恢复" }));await waitFor(() => expect(screen.queryByRole("button",{ name: "讨论设计" })).not.toBeInTheDocument());
  fireEvent.keyDown(tabs,{ key: "Home" });expect(screen.getByRole("tab",{ name: "任务" })).toHaveFocus();fireEvent.keyDown(tabs,{ key: "ArrowRight" });expect(screen.getByRole("tab",{ name: "对话" })).toHaveFocus();fireEvent.keyDown(tabs,{ key: "ArrowLeft" });expect(screen.getByRole("tab",{ name: "任务" })).toHaveFocus();
});

it("CHAT-13 supports keyboard menu navigation and dismisses transient metadata when scrolling or clicking outside", () => {
  const archive = vi.fn(),remove = vi.fn(),select = vi.fn();
  render(<ConversationHistoryRow disabled={false} item={chat} onArchive={archive} onDelete={remove} onSelect={select} selected workbench="设计项目" />);
  const row = screen.getByRole("button",{ name: "讨论设计" }),trigger = screen.getByRole("button",{ name: "对话操作 讨论设计" });
  fireEvent.mouseEnter(row);expect(screen.getByRole("tooltip")).toBeInTheDocument();fireEvent.mouseLeave(row);expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.focus(row);fireEvent.scroll(window);expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();fireEvent.focus(row);fireEvent.resize(window);expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.click(trigger);expect(screen.getByRole("menuitem",{ name: "归档" })).toHaveFocus();
  const menu = screen.getByRole("menu");fireEvent.keyDown(menu,{ key: "ArrowDown" });expect(screen.getByRole("menuitem",{ name: "删除" })).toHaveFocus();fireEvent.keyDown(menu,{ key: "ArrowUp" });expect(screen.getByRole("menuitem",{ name: "归档" })).toHaveFocus();fireEvent.keyDown(menu,{ key: "End" });expect(screen.getByRole("menuitem",{ name: "删除" })).toHaveFocus();fireEvent.keyDown(menu,{ key: "Home" });expect(screen.getByRole("menuitem",{ name: "归档" })).toHaveFocus();
  fireEvent.keyDown(menu,{ key: "Tab" });expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.click(trigger);fireEvent.pointerDown(document.body);expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.click(trigger);fireEvent.click(screen.getByRole("menuitem",{ name: "删除" }));expect(remove).toHaveBeenCalledOnce();
  fireEvent.click(row);expect(select).toHaveBeenCalledOnce();
});

it("CHAT-13 traps deletion focus, blocks dismissal while pending, and clears deleted selected history", async () => {
  const { api,list,remove } = setup();
  let complete: ((value: { changed: boolean }) => void) | undefined;
  remove.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  render(<ConversationPage api={api} onSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button",{ name: "讨论设计" }));await waitFor(() => expect(screen.queryByRole("button",{ name: "工作台" })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button",{ name: "对话操作 讨论设计" }));fireEvent.click(screen.getByRole("menuitem",{ name: "删除" }));
  const dialog = screen.getByRole("alertdialog"),cancel = within(dialog).getByRole("button",{ name: "取消" }),confirm = within(dialog).getByRole("button",{ name: "删除" });
  expect(cancel).toHaveFocus();fireEvent.keyDown(document,{ key: "Tab",shiftKey: true });expect(confirm).toHaveFocus();fireEvent.keyDown(document,{ key: "Tab" });expect(cancel).toHaveFocus();
  fireEvent.click(confirm);expect(confirm).toBeDisabled();fireEvent.keyDown(document,{ key: "Escape" });expect(screen.getByRole("alertdialog")).toBeInTheDocument();fireEvent.keyDown(document,{ key: "Tab" });expect(dialog).toHaveFocus();
  list.mockResolvedValue({ items: [] });await act(async () => { complete?.({ changed: true });await Promise.resolve(); });await screen.findByText("今天想一起做点什么？");expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();expect(screen.queryByRole("button",{ name: "讨论设计" })).not.toBeInTheDocument();
});

it.each(["archived","deleted"])("CHAT-14 does not restore a remembered %s conversation into an editable composer", async state => {
  const { api,list,get } = setup();
  const view = render(<ConversationPage api={api} onSettings={vi.fn()} />);fireEvent.click(await screen.findByRole("button",{ name: "讨论设计" }));await waitFor(() => expect(screen.queryByRole("button",{ name: "工作台" })).not.toBeInTheDocument());view.unmount();
  list.mockResolvedValue({ items: [] });
  if (state === "archived") get.mockResolvedValue({ ...chat,archivedAt: chat.updatedAt });else get.mockRejectedValue(new ApiError("conversation_not_found","Unavailable",404));
  render(<ConversationPage api={api} onSettings={vi.fn()} />);await screen.findByText("今天想一起做点什么？");await waitFor(() => expect(screen.getByRole("button",{ name: "工作台" })).toBeEnabled());expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
