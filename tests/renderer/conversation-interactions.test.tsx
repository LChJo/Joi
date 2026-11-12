// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, DigitalLifeApi } from "../../src/renderer/api";
import { ConversationPage } from "../../src/renderer/ConversationPage";
import type { ConversationDto, ConversationTurnStatus, SendConversationInput } from "../../src/shared/conversations";

function conversation(id: string,status: ConversationTurnStatus = "COMPLETED"): ConversationDto {
  return { conversationId: id,workbenchId: "wb",title: id === "first" ? "项目说明" : "设计讨论",updatedAt: "2026-11-11",turns: [{ turnId: `${id}-turn`,text: "Question",status,createdAt: "2026-11-11",artifacts: [{ name: "report.md",size: 10 }],config: { partnerId: "joi-chat",partnerName: "joi",networkId: "network",networkName: "Network",modelName: "Configured model",skills: ["user/design"],attachmentIds: ["attachment"] },entries: [
    { entryId: "markdown",sequence: 1,createdAt: "2026-11-11",kind: "MARKDOWN",role: "AGENT",text: "## Formatted answer" },
    { entryId: "call",sequence: 2,createdAt: "2026-11-11",kind: "TOOL_CALL",role: "TOOL",toolName: "read" },
    { entryId: "result",sequence: 3,createdAt: "2026-11-11",kind: "TOOL_RESULT",role: "TOOL" },
    { entryId: "artifact",sequence: 4,createdAt: "2026-11-11",kind: "ARTIFACT",role: "AGENT",artifact: { name: "report.md",kind: "FILE",mimeType: "text/markdown",size: 10 } },
    { entryId: "error",sequence: 5,createdAt: "2026-11-11",kind: "ERROR",role: "SYSTEM",text: "Safe error" },
  ] }] };
}
function setup() {
  const api = new DigitalLifeApi("",true);
  vi.spyOn(api,"listWorkbenches").mockResolvedValue({ items: [{ workbenchId: "wb",name: "Project",scopeSummary: "Project",updatedAt: "2026-11-11" },{ workbenchId: "wb2",name: "Design",scopeSummary: "Design",updatedAt: "2026-11-11" }] });
  vi.spyOn(api,"listPartners").mockResolvedValue({ items: [{ partnerId: "native",displayName: "Native partner",engine: "codex",kind: "local-pi",status: "ACTIVE",skills: [] } as never] });
  vi.spyOn(api,"listModelSources").mockResolvedValue({ items: [{ sourceId: "network",displayName: "Network",activeModel: { id: "Configured model" },status: "READY" } as never] });
  const history = vi.spyOn(api,"listConversations").mockResolvedValue({ items: [conversation("first"),conversation("second")] });
  const get = vi.spyOn(api,"getConversation").mockImplementation(id => Promise.resolve(conversation(id)));
  const send = vi.spyOn(api,"sendConversation").mockImplementation((input: SendConversationInput) => Promise.resolve({ ...conversation(input.conversationId),workbenchId: input.workbenchId }));
  const stop = vi.spyOn(api,"stopConversation").mockResolvedValue({ stopped: true });
  vi.spyOn(api,"conversationInheritance").mockResolvedValue({ memoryCount: 2,evolutionRevisionId: "effective-method" });
  vi.spyOn(api,"conversationGit").mockResolvedValue({ available: false,branch: "",branches: [],ahead: 0,behind: 0,files: [],history: [] });
  vi.spyOn(api,"request").mockResolvedValue({ items: [{ id: "user/design",displayName: "Design Skill" }] });
  const upload = vi.spyOn(api,"uploadJoiAttachment").mockResolvedValue({ attachmentId: "attachment",filename: "notes.txt",mimeType: "text/plain",size: 4,createdAt: "2026-11-11" });
  const quick = vi.spyOn(api,"quickConversationWorkbench").mockResolvedValue({ workbenchId: "quick",name: "Folder project",scopeSummary: "Project",updatedAt: "2026-11-11" });
  return { api,history,get,send,stop,upload,quick };
}
async function ready() { await waitFor(() => expect(screen.getByRole("button",{ name: "大模型网络" })).toHaveTextContent("Network")); }
it("CHAT-02/03 selects workbench, Skills and attachments independently, creates from a folder and retries the same message identity", async () => {
  const { api,send,upload,quick } = setup();send.mockRejectedValueOnce(new ApiError("fixture_failed","Retry this request",503));
  const { container } = render(<ConversationPage api={api} onSettings={vi.fn()} />);await ready();
  fireEvent.click(screen.getByRole("button",{ name: "工作台" }));fireEvent.click(screen.getByRole("option",{ name: "Design" }));
  fireEvent.click(screen.getByRole("button",{ name: "工作台" }));fireEvent.click(screen.getByRole("button",{ name: "从工作路径快速新建…" }));
  await waitFor(() => expect(quick).toHaveBeenCalledTimes(1));await waitFor(() => expect(screen.getByRole("button",{ name: "工作台" })).toHaveTextContent("Folder project"));
  fireEvent.click(screen.getByRole("button",{ name: "Skills" }));const skill = screen.getByRole("checkbox",{ name: "Design Skill" });fireEvent.click(skill);fireEvent.click(skill);fireEvent.click(skill);fireEvent.keyDown(document,{ key: "Escape" });
  fireEvent.click(screen.getByRole("button",{ name: "附件" }));fireEvent.click(screen.getByRole("button",{ name: "添加文件…" }));
  const input = container.querySelector('input[type="file"]');if (input === null) throw new Error("Missing file input");fireEvent.change(input,{ target: { files: [new File(["note"],"notes.txt")] } });
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));await screen.findByRole("button",{ name: "移除 notes.txt" });fireEvent.click(screen.getByRole("button",{ name: "移除 notes.txt" }));
  fireEvent.pointerDown(document.body);fireEvent.click(screen.getByRole("button",{ name: "记忆与进化 · 已继承" }));expect(screen.getByText(/记忆摘要 · 2/)).toBeInTheDocument();expect(screen.getByText(/effective-method/)).toBeInTheDocument();fireEvent.keyDown(document,{ key: "Escape" });
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Hello project" } });fireEvent.keyDown(screen.getByRole("textbox",{ name: "消息" }),{ key: "Enter",ctrlKey: true });
  await screen.findByRole("alert");expect(screen.getByRole("textbox",{ name: "消息" })).toHaveValue("Hello project");fireEvent.click(screen.getByRole("button",{ name: "发送消息" }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));expect(send.mock.calls[0]?.[0].requestId).toBe(send.mock.calls[1]?.[0].requestId);
  expect(send.mock.calls[1]?.[0]).toMatchObject({ workbenchId: "quick",skills: ["user/design"],attachmentIds: [] });
  fireEvent.click(screen.getByRole("button",{ name: "新建对话" }));expect(screen.getByRole("button",{ name: "工作台" })).toBeEnabled();expect(screen.getByRole("textbox",{ name: "消息" })).toHaveValue("");
});
it("CHAT-02/04 keeps separate follow-up drafts when switching grouped and searched history, and copies formatted output", async () => {
  const { api,get } = setup();const copy = vi.fn(() => Promise.resolve());Object.defineProperty(navigator,"clipboard",{ configurable: true,value: { writeText: copy } });
  get.mockImplementation(id => { const chat = conversation(id);chat.turns[0]?.entries.unshift({ entryId: "activity",kind: "ACTIVITY",role: "SYSTEM",sequence: 0,createdAt: chat.updatedAt,activity: { type: "THINKING",thinking: { phaseId: "phase",state: "COMPLETED",summary: "UI_ONLY_THOUGHT" } } });return Promise.resolve(chat); });
  render(<ConversationPage api={api} onSettings={vi.fn()} />);await ready();
  fireEvent.click(screen.getByRole("button",{ name: /^项目说明$/ }));await screen.findByRole("heading",{ name: "Formatted answer" });
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Draft one" } });fireEvent.click(screen.getByRole("button",{ name: /^设计讨论$/ }));await waitFor(() => expect(screen.getByRole("textbox",{ name: "消息" })).toHaveValue(""));
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Draft two" } });fireEvent.change(screen.getByRole("textbox",{ name: "搜索对话…" }),{ target: { value: "项目" } });expect(screen.queryByRole("button",{ name: /^设计讨论$/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{ name: /^项目说明$/ }));await waitFor(() => expect(screen.getByRole("textbox",{ name: "消息" })).toHaveValue("Draft one"));
  fireEvent.click(screen.getByRole("button",{ name: "复制回答" }));await waitFor(() => expect(copy).toHaveBeenCalledWith("## Formatted answer"));
  fireEvent.click(screen.getByRole("button",{ name: "对话规则" }));expect(screen.getByText(/对话固定属于一个工作台/)).toBeInTheDocument();fireEvent.click(screen.getByRole("button",{ name: "对话规则" }));
  fireEvent.click(screen.getByRole("button",{ name: "显示或收起工作区" }));fireEvent.click(screen.getByRole("button",{ name: "显示或收起对话列表" }));
});
it("CHAT-03 selects a native partner without changing its engine-owned model and supports the settings shortcut", async () => {
  const { api,send } = setup();const settings = vi.fn();render(<ConversationPage api={api} onSettings={settings} />);await ready();
  fireEvent.click(screen.getByRole("button",{ name: "搭档" }));fireEvent.click(screen.getByRole("option",{ name: /Native partner/ }));expect(screen.getByRole("button",{ name: "大模型网络" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Native message" } });fireEvent.click(screen.getByRole("button",{ name: "发送消息" }));await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ partnerId: "native",networkId: "native" })));
  fireEvent.keyDown(window,{ key: ",",metaKey: true });fireEvent.keyDown(window,{ key: "x" });expect(settings).toHaveBeenCalledTimes(1);
});
it.each(["FAILED","STOPPED","INTERRUPTED"] as const)("CHAT-04 displays %s history without replaying a request", async status => {
  const { api,get,send } = setup();get.mockResolvedValue(conversation("first",status));render(<ConversationPage api={api} onSettings={vi.fn()} />);await ready();
  fireEvent.click(screen.getByRole("button",{ name: /^项目说明$/ }));await screen.findByRole("heading",{ name: "Formatted answer" });expect(screen.getByText(status === "FAILED" ? "未能完成" : status === "STOPPED" ? "已停止" : "执行已中断，请先检查工作区再重试。")).toBeInTheDocument();expect(send).not.toHaveBeenCalled();
});
it("CHAT-04 progressively polls an active conversation and preserves its output when stopped", async () => {
  vi.useFakeTimers();
  try {
    const { api,get,stop } = setup();get.mockResolvedValueOnce(conversation("first","QUEUED")).mockResolvedValueOnce(conversation("first","RUNNING")).mockResolvedValue(conversation("first","STOPPED"));
    render(<ConversationPage api={api} onSettings={vi.fn()} />);await act(async () => { await vi.advanceTimersByTimeAsync(5); });fireEvent.click(screen.getByRole("button",{ name: /^项目说明$/ }));await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("等待执行")).toBeInTheDocument();await act(async () => { await vi.advanceTimersByTimeAsync(800); });expect(screen.getByText("正在处理…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{ name: "停止生成" }));await act(async () => { await Promise.resolve(); });expect(stop).toHaveBeenCalledWith("first");expect(screen.getByText("已停止")).toBeInTheDocument();expect(screen.getByRole("heading",{ name: "Formatted answer" })).toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});
it("CHAT-02 reports quick-create errors, treats a canceled folder picker as no change, and keeps the draft", async () => {
  const { api,quick } = setup();quick.mockRejectedValueOnce(new ApiError("workbench_workspace_selection_canceled","Canceled",409)).mockRejectedValueOnce(new Error("fixture"));render(<ConversationPage api={api} onSettings={vi.fn()} />);await ready();
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Keep this draft" } });fireEvent.click(screen.getByRole("button",{ name: "工作台" }));fireEvent.click(screen.getByRole("button",{ name: "从工作路径快速新建…" }));await waitFor(() => expect(quick).toHaveBeenCalledTimes(1));expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{ name: "从工作路径快速新建…" }));await screen.findByRole("alert");expect(screen.getByRole("textbox",{ name: "消息" })).toHaveValue("Keep this draft");fireEvent.click(screen.getByRole("button",{ name: "移除" }));
});

it("CHAT-24 retries an unacknowledged update and retains loaded history across progress refreshes",async () => {
  vi.useFakeTimers();
  try {
    const { api,get } = setup();
    const active = { ...conversation("first","RUNNING"),historyCursor: "history:first:50",eventCursor: "events:first:1" };
    get.mockResolvedValue(active);
    const events = vi.spyOn(api,"conversationEvents")
      .mockResolvedValueOnce({ items: [],cursor: "events:first:2",hasMore: false })
      .mockResolvedValue({ items: [{ sequence: 3,turnId: "first-turn" }],cursor: "events:first:3",hasMore: false });
    const latest = active.turns[0];if (latest === undefined) throw new Error("Missing active turn");
    const original = { ...latest,turnId: "old",text: "Old original message",status: "COMPLETED" as const,entries: [] };
    const page = vi.spyOn(api,"conversationHistory")
      .mockRejectedValueOnce(new ApiError("fixture_unavailable","History unavailable",503))
      .mockResolvedValueOnce({ items: [original,latest],nextCursor: "history:first:20" })
      .mockResolvedValue({ items: [{ ...original,turnId: "oldest",text: "Oldest original message" }],nextCursor: null });
    const view = render(<ConversationPage api={api} onSettings={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });
    fireEvent.click(screen.getByRole("button",{ name: /^项目说明$/ }));await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button",{ name: "加载更早消息" }));await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("alert")).toHaveTextContent("请求未完成，请重试。");
    fireEvent.click(screen.getByRole("button",{ name: "加载更早消息" }));await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Old original message")).toBeInTheDocument();expect(screen.getAllByText("Question")).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(get).toHaveBeenCalledTimes(1);expect(events).toHaveBeenLastCalledWith("first","events:first:1");
    get.mockRejectedValueOnce(new ApiError("fixture_unavailable","Update unavailable",503));
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(screen.getByRole("alert")).toHaveTextContent("请求未完成，请重试。");
    expect(events).toHaveBeenLastCalledWith("first","events:first:2");
    get.mockResolvedValue({ ...active,eventCursor: "events:first:3" });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(events).toHaveBeenLastCalledWith("first","events:first:2");
    expect(screen.getByText("Old original message")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{ name: "加载更早消息" }));await act(async () => { await Promise.resolve(); });
    expect(page).toHaveBeenLastCalledWith("first","history:first:20");
    expect(screen.getByText("Oldest original message")).toBeInTheDocument();expect(screen.queryByRole("button",{ name: "加载更早消息" })).not.toBeInTheDocument();
    get.mockResolvedValue({ ...active,eventCursor: "events:first:4" });
    await act(async () => { await vi.advanceTimersByTimeAsync(700); });
    expect(screen.getByText("Oldest original message")).toBeInTheDocument();expect(screen.queryByRole("button",{ name: "加载更早消息" })).not.toBeInTheDocument();
    view.unmount();
  } finally { vi.useRealTimers(); }
});

it("CHAT-22/23 keeps the subagent setting in the next turn and reports a scoped cancel failure",async () => {
  const { api,get,send } = setup();
  get.mockResolvedValue({ ...conversation("first"),children: [{ childId: "child",status: "QUEUED" }] });
  const cancel = vi.spyOn(api,"cancelConversationChild").mockRejectedValueOnce(new ApiError("fixture_unavailable","Cancel unavailable",503)).mockResolvedValue({ canceled: true });
  render(<ConversationPage api={api} onSettings={vi.fn()} />);await ready();
  fireEvent.click(screen.getByRole("button",{ name: /^项目说明$/ }));await screen.findByRole("heading",{ name: "Formatted answer" });
  fireEvent.click(screen.getByText(/子代理：/,{ selector: ".chat-activity-brief" }));
  fireEvent.click(screen.getByText(/子代理：/,{ selector: "summary" }));fireEvent.click(screen.getByRole("button",{ name: "取消" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("请求未完成，请重试。");
  fireEvent.click(screen.getByRole("button",{ name: "取消" }));await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));expect(cancel).toHaveBeenLastCalledWith("first","child");
  fireEvent.click(screen.getByRole("button",{ name: "扩展" }));
  fireEvent.click(screen.getByRole("switch",{ name: "子代理" }));
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Continue without children" } });fireEvent.click(screen.getByRole("button",{ name: "发送消息" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "first",subagentsEnabled: false })));
});

it("CHAT-30 restores independent extension switches from history and keeps them while changing partners",async () => {
  const { api,get,send } = setup();
  get.mockImplementation(id => {
    const item = conversation(id),turn = item.turns[0];
    if (id === "first" && turn !== undefined) turn.config = { ...turn.config,subagentsEnabled: false,piExtensions: ["openwiki"] };
    return Promise.resolve(item);
  });
  render(<ConversationPage api={api} onSettings={vi.fn()} />);await ready();
  fireEvent.click(screen.getByRole("button",{ name: /^项目说明$/ }));await screen.findByRole("heading",{ name: "Formatted answer" });
  fireEvent.click(screen.getByRole("button",{ name: "扩展" }));
  expect(screen.getByRole("switch",{ name: "子代理" })).not.toBeChecked();expect(screen.getByRole("switch",{ name: "OpenWiki" })).toBeChecked();
  fireEvent.click(screen.getByRole("switch",{ name: "Browser Loop" }));
  await act(async () => { fireEvent.click(screen.getByRole("button",{ name: /^设计讨论$/ }));await Promise.resolve(); });
  await waitFor(() => expect(get).toHaveBeenLastCalledWith("second"));
  fireEvent.click(screen.getByRole("button",{ name: "扩展" }));
  expect(screen.getByRole("switch",{ name: "OpenWiki" })).not.toBeChecked();expect(screen.getByRole("switch",{ name: "子代理" })).toBeChecked();
  await act(async () => { fireEvent.click(screen.getByRole("button",{ name: /^项目说明$/ }));await Promise.resolve(); });await waitFor(() => expect(get).toHaveBeenLastCalledWith("first"));
  fireEvent.click(screen.getByRole("button",{ name: "扩展" }));expect(screen.getByRole("switch",{ name: "Browser Loop" })).toBeChecked();
  fireEvent.click(screen.getByRole("button",{ name: "搭档" }));
  await act(async () => { fireEvent.click(screen.getByRole("option",{ name: /Native partner/ }));await Promise.resolve(); });
  expect(screen.queryByRole("button",{ name: "扩展" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox",{ name: "消息" }),{ target: { value: "Native continuation" } });
  await act(async () => { fireEvent.click(screen.getByRole("button",{ name: "发送消息" }));await Promise.resolve(); });
  await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ partnerId: "native",piExtensions: [] })));
  fireEvent.click(screen.getByRole("button",{ name: "搭档" }));
  await act(async () => { fireEvent.click(screen.getByRole("option",{ name: /joi/ }));await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button",{ name: "扩展" }));expect(screen.getByRole("switch",{ name: "OpenWiki" })).toBeChecked();expect(screen.getByRole("switch",{ name: "Browser Loop" })).toBeChecked();
});
