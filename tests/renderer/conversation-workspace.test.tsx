// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError, DigitalLifeApi } from "../../src/renderer/api";
import { ConversationWorkspace } from "../../src/renderer/ConversationWorkspace";
import type { ConversationDto, GitWorkspaceDto } from "../../src/shared/conversations";

function setup() {
  const api = new DigitalLifeApi("",true);
  const state: GitWorkspaceDto = { available: true,branch: "main",branches: ["main","feature/chat"],ahead: 1,behind: 0,
    files: [{ path: "staged.txt",index: "M",workingTree: " " },{ path: "pending.txt",index: " ",workingTree: "M" }],
    history: [{ hash: "abcdef12345",message: "A commit",date: "2026-11-11" }] };
  const gitStatus = vi.spyOn(api,"conversationGit").mockResolvedValue(state);
  const fileListing = vi.spyOn(api,"conversationFiles").mockResolvedValue({ items: [{ path: "src",directory: true },{ path: "README.md",directory: false }] });
  const fileRead = vi.spyOn(api,"conversationFile").mockResolvedValue({ text: "<script>unsafe()</script>",truncated: false });
  vi.spyOn(api,"conversationDiff").mockResolvedValue({ patch: "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+<script>unsafe()</script>\n",truncated: false });
  const run = vi.spyOn(api,"runConversationGit").mockResolvedValue({ commandId: "cmd",status: "COMPLETED" });
  return { api,state,run,fileListing,fileRead,gitStatus };
}
it("CHAT-07 chooses individual/all staging, commits only staged changes and exposes branch/sync/history controls", async () => {
  const { api,run } = setup();render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);
  fireEvent.click(screen.getByRole("button",{ name: "Git" }));await screen.findByText("A commit");
  for (const [label,action] of [["暂存 pending.txt","STAGE"],["取消暂存 staged.txt","UNSTAGE"],["全部暂存","STAGE"],["全部取消暂存","UNSTAGE"],["获取","FETCH"],["拉取（仅快进）","PULL"],["推送","PUSH"]] as const) {
    fireEvent.click(screen.getByRole("button",{ name: label }));await waitFor(() => expect(run).toHaveBeenLastCalledWith("wb",expect.objectContaining({ action })));
  }
  fireEvent.change(screen.getByLabelText("提交说明"),{ target: { value: "Commit staged" } });fireEvent.click(screen.getByRole("button",{ name: "提交已暂存变更" }));
  await waitFor(() => expect(run).toHaveBeenLastCalledWith("wb",expect.objectContaining({ action: "COMMIT",message: "Commit staged" })));
  fireEvent.change(screen.getByRole("combobox",{ name: "分支" }),{ target: { value: "feature/chat" } });await waitFor(() => expect(run).toHaveBeenLastCalledWith("wb",expect.objectContaining({ action: "SWITCH",branch: "feature/chat" })));
  fireEvent.change(screen.getByLabelText("新分支名称"),{ target: { value: "feature/new" } });fireEvent.click(screen.getByRole("button",{ name: "创建并切换" }));
  await waitFor(() => expect(run).toHaveBeenLastCalledWith("wb",expect.objectContaining({ action: "BRANCH",branch: "feature/new" })));
});
it("CHAT-08 renders escaped diffs in both views and reads selected workspace files", async () => {
  const { api,fileListing } = setup();const { container } = render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);
  fireEvent.click(screen.getByRole("button",{ name: "Git" }));fireEvent.click(await screen.findByRole("button",{ name: /^pending.txt/ }));
  await screen.findByText("+<script>unsafe()</script>");expect(container.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button",{ name: "并排视图" }));expect(container.querySelector(".chat-diff-columns")).not.toBeNull();
  fireEvent.click(screen.getByRole("button",{ name: "统一视图" }));fireEvent.click(screen.getByRole("button",{ name: "返回" }));
  fireEvent.click(screen.getByRole("button",{ name: "文件" }));fireEvent.click(await screen.findByRole("button",{ name: "src" }));
  await waitFor(() => expect(fileListing).toHaveBeenCalledWith("wb","src"));
  fireEvent.click(screen.getByRole("button",{ name: "返回" }));fireEvent.click(await screen.findByRole("button",{ name: "README.md" }));
  expect(await screen.findByText("<script>unsafe()</script>")).toBeInTheDocument();expect(container.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button",{ name: "返回" }));expect(await screen.findByRole("button",{ name: "README.md" })).toBeInTheDocument();
});
it("CHAT-08 offers a system open action for a workspace file outside the text preview limits", async () => {
  const { api,fileListing,fileRead,gitStatus } = setup();
  fileListing.mockResolvedValue({ items: [{ path: "周报.png",directory: false }] });
  fileRead.mockResolvedValue({ text: "",truncated: false,unavailable: "TOO_LARGE" });
  const request = vi.spyOn(api,"request").mockResolvedValue({ opened: true })
    .mockRejectedValueOnce(new ApiError("workbench_artifact_open_failed","Fixture",500));
  render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);
  await waitFor(() => expect(gitStatus).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button",{ name: "文件" }));
  fireEvent.click(await screen.findByRole("button",{ name: "周报.png" }));
  fireEvent.click(await screen.findByRole("button",{ name: "直接打开" }));
  expect(request).toHaveBeenCalledWith("/api/v1/conversation-workspaces/wb/open",{ method: "POST",body: { path: "周报.png",mode: "OPEN" } });
  expect(await screen.findByRole("status")).toHaveTextContent("系统无法打开所选文件。");
  fireEvent.click(screen.getByRole("button",{ name: "转到目录" }));
  expect(request).toHaveBeenLastCalledWith("/api/v1/conversation-workspaces/wb/open",{ method: "POST",body: { path: "周报.png",mode: "REVEAL" } });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByText("请求未完成，请重试。")).not.toBeInTheDocument();
});
it("CHAT-08/09 opens or reveals reported files from a desktop menu, including older root-level records", () => {
  const { api } = setup();
  const request = vi.spyOn(api,"request").mockResolvedValue({ opened: true });
  const conversation: ConversationDto = { conversationId: "chat",workbenchId: "wb",title: "Report",updatedAt: "2026-11-11",turns: [{
    turnId: "turn",text: "Report",createdAt: "2026-11-11",status: "COMPLETED",entries: [],
    config: { partnerId: "joi-chat",partnerName: "joi",networkId: "network",networkName: "Network",modelName: "model",skills: [],attachmentIds: [] },
    artifacts: [{ name: "周报.png",size: 20,relativePath: "reports/周报.png" },{ name: "旧周报.png",size: 20 }],
  }] };
  const view = render(<ConversationWorkspace api={api} conversation={conversation} workbenchId="wb" workbenchName="Project" />);
  const trigger = screen.getByRole("button",{ name: /^周报\.png.*操作/u });
  vi.spyOn(trigger,"getBoundingClientRect").mockReturnValue(new DOMRect(200,window.innerHeight - 40,30,30));
  fireEvent.click(trigger);
  expect(screen.getByRole("menu")).toHaveStyle({ top: `${String(window.innerHeight - 126)}px` });
  fireEvent.keyDown(screen.getByRole("menuitem",{ name: "直接打开" }),{ key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole("menuitem",{ name: "直接打开" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.click(trigger);
  fireEvent.scroll(window);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.click(trigger);
  fireEvent.blur(screen.getByRole("menuitem",{ name: "直接打开" }),{ relatedTarget: screen.getByRole("button",{ name: "文件" }) });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  expect(screen.getByRole("menuitem",{ name: "直接打开" })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("menuitem",{ name: "直接打开" }),{ key: "ArrowDown" });
  expect(screen.getByRole("menuitem",{ name: "转到目录" })).toHaveFocus();
  fireEvent.click(screen.getByRole("menuitem",{ name: "转到目录" }));
  expect(request).toHaveBeenLastCalledWith("/api/v1/conversation-workspaces/wb/open",{ method: "POST",body: { path: "reports/周报.png",mode: "REVEAL" } });
  fireEvent.click(screen.getByRole("button",{ name: /^旧周报\.png.*操作/u }));
  fireEvent.click(screen.getByRole("menuitem",{ name: "直接打开" }));
  expect(request).toHaveBeenLastCalledWith("/api/v1/conversation-workspaces/wb/open",{ method: "POST",body: { path: "旧周报.png",mode: "OPEN" } });
  view.rerender(<ConversationWorkspace api={new DigitalLifeApi("")} conversation={conversation} workbenchId="wb" workbenchName="Project" />);
  expect(screen.queryByRole("button",{ name: /周报\.png.*操作/u })).not.toBeInTheDocument();
});
it("CHAT-08 reports a removed file and ignores an older preview after selecting another file", async () => {
  const { api,fileListing,fileRead,gitStatus } = setup();
  const older = Promise.withResolvers<{ text: string; truncated: boolean }>();
  fileListing.mockResolvedValue({ items: [{ path: "old.txt",directory: false },{ path: "current.txt",directory: false }] });
  fileRead.mockRejectedValueOnce(new ApiError("workspace_file_not_found","Fixture",404))
    .mockReturnValueOnce(older.promise).mockResolvedValueOnce({ text: "Current preview",truncated: false });
  render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);
  await waitFor(() => expect(gitStatus).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button",{ name: "文件" }));
  const oldFile = await screen.findByRole("button",{ name: "old.txt" });
  fireEvent.click(oldFile);
  expect(await screen.findByRole("status")).toHaveTextContent("此文件已不在当前工作区。");
  fireEvent.click(oldFile);
  fireEvent.click(screen.getByRole("button",{ name: "current.txt" }));
  await screen.findByText("Current preview");
  await act(async () => { older.resolve({ text: "Older preview",truncated: false });await older.promise; });
  expect(screen.queryByText("Older preview")).not.toBeInTheDocument();
  expect(screen.getByText("Current preview")).toBeInTheDocument();
});
it("CHAT-08 shows a current folder error and discards a delayed error after leaving Files", async () => {
  const { api,fileListing,gitStatus } = setup();
  const later = Promise.withResolvers<{ items: { path: string; directory: boolean }[] }>();
  fileListing.mockRejectedValueOnce(new ApiError("workspace_file_not_found","Fixture",404)).mockReturnValueOnce(later.promise);
  render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);
  await waitFor(() => expect(gitStatus).toHaveBeenCalled());
  const files = screen.getByRole("button",{ name: "文件" });
  const changes = screen.getByRole("button",{ name: "变更" });
  fireEvent.click(files);
  expect(await screen.findByRole("status")).toHaveTextContent("此文件已不在当前工作区。");
  fireEvent.click(changes);
  fireEvent.click(files);
  fireEvent.click(changes);
  await act(async () => { later.reject(new ApiError("workspace_file_not_found","Fixture",404));await later.promise.catch(() => undefined); });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("CHAT-08/09 restricts browser schemes and embeds explicit URLs in a sandbox while keeping local files desktop-only", () => {
  const { api } = setup();const view = render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);
  const submit = () => { const form = screen.getByLabelText("预览地址").closest("form");if (form === null) throw new Error("Missing preview form");fireEvent.submit(form); };
  fireEvent.click(screen.getByRole("button",{ name: "浏览器" }));fireEvent.change(screen.getByLabelText("预览地址"),{ target: { value: "javascript:unsafe()" } });submit();
  expect(screen.getByRole("status")).toHaveTextContent("请输入不含账号密码");
  fireEvent.change(screen.getByLabelText("预览地址"),{ target: { value: "https://example.org/preview" } });submit();
  expect(screen.getByTitle("浏览器")).toHaveAttribute("sandbox","allow-scripts allow-forms");expect(screen.getByTitle("浏览器")).toHaveAttribute("src","https://example.org/preview");
  view.unmount();const lan = new DigitalLifeApi("");render(<ConversationWorkspace api={lan} conversation={null} workbenchId="wb" workbenchName="Project" />);
  fireEvent.click(screen.getByRole("button",{ name: "文件" }));expect(screen.getByText("请在桌面端使用文件与 Git 功能")).toBeInTheDocument();
});
it("CHAT-07 converges queued Git operations through polling and reports failures without replay", async () => {
  vi.useFakeTimers();
  try {
    const { api,run } = setup();run.mockResolvedValue({ commandId: "cmd",status: "QUEUED" });
    vi.spyOn(api,"getConversationGitCommand").mockResolvedValue({ commandId: "cmd",status: "FAILED",errorCode: "git_operation_failed" });
    render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5); });fireEvent.click(screen.getByRole("button",{ name: "Git" }));fireEvent.click(screen.getByRole("button",{ name: "获取" }));
    await act(async () => { await Promise.resolve(); });await act(async () => { await vi.advanceTimersByTimeAsync(1000); });expect(screen.getByRole("status")).toHaveTextContent("Git 操作未完成");expect(run).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
it("CHAT-07/08 shows unavailable and clean repositories, empty folders and bounded empty diffs", async () => {
  const { api,state,fileListing,gitStatus } = setup();gitStatus.mockRejectedValueOnce(new Error("fixture"));
  const { container } = render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);
  fireEvent.click(screen.getByRole("button",{ name: "Git" }));await screen.findByRole("status");
  gitStatus.mockResolvedValue({ ...state,branch: "",branches: [],files: [] });fireEvent.click(screen.getByRole("button",{ name: "刷新" }));await screen.findByText("工作区干净");expect(screen.getByRole("combobox",{ name: "分支" })).toHaveValue("");
  gitStatus.mockResolvedValue({ ...state,files: [{ path: "only.txt",index: " ",workingTree: "M" }] });fireEvent.click(screen.getByRole("button",{ name: "刷新" }));fireEvent.click(await screen.findByRole("button",{ name: /^only.txt/ }));
  vi.spyOn(api,"conversationDiff").mockResolvedValue({ patch: "",truncated: true });fireEvent.click(await screen.findByRole("button",{ name: "返回" }));fireEvent.click(screen.getByRole("button",{ name: /^only.txt/ }));
  await screen.findByText("所选内容暂无可显示的文本差异");expect(screen.getByText("预览内容已截断")).toBeInTheDocument();expect(container.querySelector("script")).toBeNull();
  fileListing.mockResolvedValue({ items: [] });fireEvent.click(screen.getByRole("button",{ name: "文件" }));await screen.findByText("此文件夹为空");
});
it.each(["COMPLETED","INTERRUPTED"] as const)("CHAT-07 reports %s queued Git operations without resubmission", async status => {
  vi.useFakeTimers();
  try {
    const { api,run } = setup();run.mockResolvedValue({ commandId: "cmd",status: "QUEUED" });vi.spyOn(api,"getConversationGitCommand").mockResolvedValue({ commandId: "cmd",status });
    render(<ConversationWorkspace api={api} conversation={null} workbenchId="wb" workbenchName="Project" />);await act(async () => { await vi.advanceTimersByTimeAsync(5); });fireEvent.click(screen.getByRole("button",{ name: "Git" }));fireEvent.click(screen.getByRole("button",{ name: "获取" }));
    await act(async () => { await Promise.resolve(); });await act(async () => { await vi.advanceTimersByTimeAsync(1000); });expect(screen.getByRole("status")).toHaveTextContent(status === "COMPLETED" ? "Git 操作已完成" : "执行已中断");expect(run).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
