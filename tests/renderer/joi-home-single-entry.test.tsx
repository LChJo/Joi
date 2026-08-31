// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";
import { WorkbenchManager, JoiHome, ModelSourceManager } from "../../src/renderer/JoiHome.js";
import type { WorkbenchDetailDto, WorkbenchDto, JoiAcceptedMessageDto, JoiGoalCardDto, JoiSnapshotDto, JoiThinkingItemDto, ModelSourceDto, PartnerDto } from "../../src/shared/joi.js";

const readySource: ModelSourceDto = {
  accessMode: "api",
  activeModel: { capability: "release-tested", id: "deepseek-chat", revisionId: "model-1" },
  activeSourceRevisionId: "source-revision-1",
  credential: { configured: true, version: 1 },
  displayName: "DeepSeek",
  kind: "deepseek",
  order: 0,
  primary: true,
  protocol: "openai",
  sourceId: "source-1",
  status: "READY",
};

function snapshot(modelSources: ModelSourceDto[]): JoiSnapshotDto {
  const configured = modelSources.some((source) => source.status === "READY");
  return { workbenchChanges: [], workbenches: [], modelSources, partners: [], runtime: { configured, status: configured ? "READY" : "NOT_CONFIGURED" }, work: [] };
}

describe("Workbench context center", () => {
  it("shows safe workspace, work, result and private-instance metadata and runs management actions", async () => {
    const api = new DigitalLifeApi("", true);
    const workbench = workbenchDto("workbench-1", "发布 Workbench");
    const detail: WorkbenchDetailDto = {
      activeWork: [{ workbenchId: workbench.workbenchId, status: "RUNNING", title: "更新发布文档", workId: "work-1" }],
      workbenchId: workbench.workbenchId,
      instances: [{ engine: "pi-core", instanceId: "instance-1", lastUsedAt: workbench.updatedAt, partnerId: "partner-1", partnerName: "写作者", sessionPolicy: "RESIDENT", status: "IDLE" }],
      name: workbench.name,
      personaRevisionId: "persona-revision-2",
      projectLabel: "发布工程",
      recentResults: [{ createdAt: workbench.updatedAt, isLate: true, partnerRevisionId: "partner-revision-1", resultId: "result-1", status: "COMPLETED", summary: "发布检查完成", workId: "work-old" }],
      recentOutcomes: [{ completedAt: workbench.updatedAt, goalId: "goal-1", resultRevision: 1, status: "COMPLETED", summary: "发布文档已经完成，风险已收口。", title: "更新发布文档" }],
      responsibility: "维护发布流水线",
      updatedAt: workbench.updatedAt,
      workspace: { displayName: "release", kind: "BOUND", status: "READY" },
    };
    vi.spyOn(api, "listWorkbenches").mockResolvedValue({ items: [workbench] });
    vi.spyOn(api, "getWorkbench").mockResolvedValue(detail);
    vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [{
      agentId: "instance-1", workbenchId: workbench.workbenchId, canDelete: false, createdAt: workbench.updatedAt,
      engine: "pi-core", lastActivityAt: workbench.updatedAt, partnerId: "partner-1", partnerName: "写作者",
      sessionPolicy: "RESIDENT", status: "IDLE", transport: "LOCAL",
    }] });
    const update = vi.spyOn(api, "updateWorkbench").mockResolvedValue({ ...detail, personaRevisionId: "persona-revision-3" });
    const bind = vi.spyOn(api, "bindWorkbenchWorkspace").mockResolvedValue(detail.workspace);
    const rebuild = vi.spyOn(api, "rebuildWorkbenchWorkspace").mockResolvedValue({ displayName: "发布 Workbench 工作区", kind: "MANAGED", status: "PROVISIONING" });

    render(<WorkbenchManager api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /发布 Workbench/u }));
    expect(await screen.findByRole("heading", { name: "发布 Workbench" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看 写作者 详情" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "上下文设置" }));
    expect(screen.getByRole("heading", { name: "工作区" }).closest("article")).toHaveTextContent("release · BOUND · READY");
    expect(screen.getByText(/更新发布文档 · RUNNING/u)).toBeInTheDocument();
    expect(screen.getByText("发布文档已经完成，风险已收口。")).toBeInTheDocument();
    const recentOutcomes = screen.getByRole("heading", { name: "最近结果总结" }).closest("article");
    expect(recentOutcomes).toHaveTextContent("更新发布文档");
    expect(recentOutcomes).toHaveTextContent("COMPLETED");
    expect(recentOutcomes).not.toHaveTextContent("发布检查完成");
    expect(document.body.textContent).not.toContain("PRIVATE_PERSONA_BODY");
    expect(document.body.textContent).not.toMatch(/[A-Za-z]:\\/u);

    fireEvent.change(screen.getByLabelText("提交新人格 revision（留空保持当前）"), { target: { value: "NEW_PRIVATE_PERSONA" } });
    fireEvent.click(screen.getByRole("button", { name: "保存上下文" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(workbench.workbenchId, expect.objectContaining({ persona: "NEW_PRIVATE_PERSONA" })));
    expect(document.body.textContent).not.toContain("NEW_PRIVATE_PERSONA");

    fireEvent.click(screen.getByRole("button", { name: "绑定已有目录" }));
    await waitFor(() => expect(bind).toHaveBeenCalledWith(workbench.workbenchId));
    fireEvent.click(screen.getByRole("button", { name: "重建受管目录" }));
    await waitFor(() => expect(rebuild).toHaveBeenCalledWith(workbench.workbenchId));
  });

  it("drills from Workbench Agent cards into a read-only Markdown/tool stream and deletes only terminal ephemeral Agents", async () => {
    const api = new DigitalLifeApi("", true);
    const workbench = workbenchDto("workbench-agent", "研发 Workbench");
    const detail: WorkbenchDetailDto = {
      activeWork: [], workbenchId: workbench.workbenchId, instances: [], name: workbench.name, personaRevisionId: "persona-1",
      projectLabel: "研发", recentOutcomes: [], recentResults: [], responsibility: "研发", updatedAt: workbench.updatedAt,
      workspace: { displayName: "workspace", kind: "BOUND", status: "READY" },
    };
    const ephemeral = {
      agentId: "agent-once", workbenchId: workbench.workbenchId, canDelete: true, createdAt: workbench.updatedAt, engine: "codex" as const,
      lastActivityAt: workbench.updatedAt, partnerId: "partner-1", partnerName: "实现者", sessionPolicy: "EPHEMERAL" as const,
      status: "COMPLETED" as const, transport: "LOCAL" as const,
    };
    const resident = { ...ephemeral, agentId: "agent-resident", canDelete: false, partnerName: "长期搭档", sessionPolicy: "RESIDENT" as const, status: "IDLE" as const };
    vi.spyOn(api, "listWorkbenches").mockResolvedValue({ items: [workbench] });
    vi.spyOn(api, "getWorkbench").mockResolvedValue(detail);
    vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [ephemeral, resident] });
    vi.spyOn(api, "agentConversation")
      .mockResolvedValueOnce({ agent: ephemeral, items: [
        { createdAt: workbench.updatedAt, entryId: "entry-1", kind: "MARKDOWN", role: "AGENT", sequence: 0, text: "## 完成\n\n- 已验证\n\n[安全链接](https://example.com/result) [内部链接](/private)\n\n![remote](https://example.com/private.png)" },
        { createdAt: workbench.updatedAt, entryId: "entry-2", kind: "TOOL_CALL", role: "TOOL", sequence: 1, text: "已调用", toolName: "apply_patch" },
        { createdAt: workbench.updatedAt, entryId: "entry-3", kind: "TOOL_RESULT", role: "TOOL", sequence: 2, text: "测试通过" },
        { artifact: { artifactId: "entry-4", kind: "FILE", mimeType: "text/markdown", name: "report.md", size: 128 }, createdAt: workbench.updatedAt, entryId: "entry-4", kind: "ARTIFACT", role: "AGENT", sequence: 3 },
        { createdAt: workbench.updatedAt, entryId: "entry-user", kind: "MARKDOWN", role: "USER", sequence: 4, text: "原始任务投影" },
        { createdAt: workbench.updatedAt, entryId: "entry-tool-fallback", kind: "TOOL_CALL", role: "TOOL", sequence: 5 },
        { createdAt: workbench.updatedAt, entryId: "entry-result-fallback", kind: "TOOL_RESULT", role: "TOOL", sequence: 6, toolName: "shell" },
        { createdAt: workbench.updatedAt, entryId: "entry-artifact-fallback", kind: "ARTIFACT", role: "AGENT", sequence: 7 },
        { artifact: { artifactId: "entry-directory", kind: "DIRECTORY", mimeType: "inode/directory", name: "reports", size: 0 }, createdAt: workbench.updatedAt, entryId: "entry-directory", kind: "ARTIFACT", role: "AGENT", sequence: 8 },
        { artifact: { kind: "FILE", mimeType: "text/plain", name: "legacy.txt", size: 12 }, createdAt: workbench.updatedAt, entryId: "entry-legacy", kind: "ARTIFACT", role: "AGENT", sequence: 9 },
      ], nextCursor: "page-2" })
      .mockResolvedValueOnce({ agent: ephemeral, items: [
        { createdAt: workbench.updatedAt, entryId: "entry-5", kind: "ERROR", role: "SYSTEM", sequence: 4, text: "**已恢复**" },
      ] });
    const remove = vi.spyOn(api, "deleteWorkbenchAgent").mockResolvedValue(undefined);
    const openArtifact = vi.spyOn(api, "openWorkbenchArtifact")
      .mockResolvedValueOnce({ opened: true })
      .mockResolvedValueOnce({ opened: true })
      .mockRejectedValueOnce(new Error("desktop unavailable"))
      .mockRejectedValueOnce(new ApiError("artifact_missing", "产物已经移动。", 404));

    render(<WorkbenchManager api={api} initialWorkbenchId={workbench.workbenchId} />);
    expect(await screen.findByRole("button", { name: "查看 实现者 详情" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除 实现者" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 长期搭档" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 实现者 详情" }));
    expect(await screen.findByRole("heading", { name: "完成" })).toBeInTheDocument();
    expect(screen.getByText("apply_patch")).toBeInTheDocument();
    const toolResult = screen.getByText("测试通过");
    expect(toolResult).not.toBeVisible();
    const toolResultDetails = toolResult.closest("details");
    if (toolResultDetails === null) throw new Error("missing compact tool result");
    fireEvent.click(within(toolResultDetails).getByText("工具结果"));
    expect(toolResult).toBeVisible();
    expect(screen.getByText("report.md")).toBeInTheDocument();
    const artifactButton = screen.getByRole("button", { name: "打开产物 report.md" });
    fireEvent.click(artifactButton);
    await waitFor(() => expect(openArtifact).toHaveBeenCalledWith(workbench.workbenchId, {
      artifactId: "entry-4", mode: "OPEN", source: "AGENT", sourceId: ephemeral.agentId,
    }));
    fireEvent.contextMenu(artifactButton);
    await waitFor(() => expect(openArtifact).toHaveBeenCalledWith(workbench.workbenchId, {
      artifactId: "entry-4", mode: "REVEAL", source: "AGENT", sourceId: ephemeral.agentId,
    }));
    const directoryButton = screen.getByRole("button", { name: "打开产物 reports" });
    expect(directoryButton).toHaveTextContent("打开文件夹");
    fireEvent.click(directoryButton);
    expect(await screen.findByText("这个产物暂时无法打开。")).toBeInTheDocument();
    fireEvent.contextMenu(directoryButton);
    expect(await screen.findByText("产物已经移动。")).toBeInTheDocument();
    expect(screen.getByText("legacy.txt")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开产物 legacy.txt" })).not.toBeInTheDocument();
    expect(screen.getByText("原始任务投影")).toBeInTheDocument();
    expect(screen.getByText("tool")).toBeInTheDocument();
    expect(screen.getByText("shell")).toBeInTheDocument();
    expect(screen.getByText("产物")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "安全链接" })).toHaveAttribute("href", "https://example.com/result");
    expect(screen.getByText("内部链接").closest("a")).toBeNull();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
    expect(await screen.findByText("已恢复")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更早记录" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回 Agent 列表" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除 实现者" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(workbench.workbenchId, ephemeral.agentId));
  });

  it("keeps the Agent area usable when its list is invalid and reports a read failure without exposing a composer", async () => {
    const api = new DigitalLifeApi("", true);
    const workbench = workbenchDto("workbench-fallback", "容错 Workbench");
    const detail: WorkbenchDetailDto = {
      activeWork: [], workbenchId: workbench.workbenchId, instances: [], name: workbench.name, personaRevisionId: "persona-1",
      projectLabel: "容错", recentOutcomes: [], recentResults: [], responsibility: "容错", updatedAt: workbench.updatedAt,
      workspace: { displayName: "workspace", kind: "BOUND", status: "READY" },
    };
    const agent = {
      agentId: "agent-fallback", workbenchId: workbench.workbenchId, canDelete: false, createdAt: workbench.updatedAt, engine: "pi-core" as const,
      lastActivityAt: workbench.updatedAt, partnerId: "partner-1", partnerName: "容错搭档", sessionPolicy: "RESIDENT" as const,
      status: "IDLE" as const, transport: "LOCAL" as const,
    };
    vi.spyOn(api, "listWorkbenches").mockResolvedValue({ items: [workbench] });
    vi.spyOn(api, "getWorkbench").mockResolvedValue(detail);
    vi.spyOn(api, "listWorkbenchAgents")
      .mockResolvedValueOnce({ items: null as never })
      .mockResolvedValue({ items: [agent] });
    vi.spyOn(api, "agentConversation").mockRejectedValue(new Error("offline"));

    const view = render(<WorkbenchManager api={api} initialWorkbenchId={workbench.workbenchId} />);
    expect(await screen.findByRole("heading", { name: "还没有 Agent" })).toBeInTheDocument();
    view.unmount();

    vi.restoreAllMocks();
    vi.spyOn(api, "listWorkbenches").mockResolvedValue({ items: [workbench] });
    vi.spyOn(api, "getWorkbench").mockResolvedValue(detail);
    vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [agent] });
    vi.spyOn(api, "agentConversation").mockRejectedValue(new Error("offline"));
    render(<WorkbenchManager api={api} initialWorkbenchId={workbench.workbenchId} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 容错搭档 详情" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("没能读取 Agent 对话。");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

function parentForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Expected a parent form.");
  return form;
}

function workbenchDto(workbenchId: string, name: string): WorkbenchDto {
  return { workbenchId, name, scopeSummary: "scope", updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("joi home single entry", () => {
  it("shows the exact first-run copy and exactly seven direct connection choices", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([]));
    render(<JoiHome api={api} />);
    expect(await screen.findByRole("heading", { name: "joi需要链接到大模型网络" })).toBeInTheDocument();
    const choices = screen.getAllByRole("button", { name: /连接/u });
    expect(choices).toHaveLength(7);
    expect(choices.map((choice) => choice.textContent)).toEqual(expect.arrayContaining(["连接 Kimi", "连接 GLM", "连接 Qwen", "连接 Doubao", "连接 MiniMax", "连接 DeepSeek", "连接 通用平台"]));
    expect(screen.queryByLabelText("给 joi 输入")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/OpenRouter|SiliconFlow|转发平台|聚合平台/iu);
  });

  it("uses one composer when a source is ready and keeps consecutive inputs accepted", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    const submitted: string[] = [];
    vi.spyOn(api, "joiHomeFeed").mockImplementation(() => Promise.resolve({
      goals: [],
      thinking: submitted.map((inputId, index) => ({
        agentCount: 0,
        goalId: inputId,
        phase: "queued" as const,
        stage: "ROUTING" as const,
        startedAt: `2026-07-28T10:00:0${String(index)}.000Z`,
        turnId: `pending:${inputId}`,
        work: { active: 0, completed: 0, failed: 0, total: 0 },
      })),
      unassignedActions: [],
    }));
    const send = vi.spyOn(api, "sendJoiMessage").mockImplementation((_message) => {
      const inputId = `input-${String(submitted.length + 1)}`;
      submitted.push(inputId);
      return Promise.resolve({ acceptedAt: `2026-07-28T10:00:0${String(submitted.length - 1)}.000Z`, inputId, status: "PENDING" });
    });
    render(<JoiHome api={api} />);
    const composer = await screen.findByLabelText("给 joi 输入");
    fireEvent.change(composer, { target: { value: "先研究方案" } });
    fireEvent.submit(parentForm(composer));
    await waitFor(() => expect(send).toHaveBeenCalledWith("先研究方案", {}));
    fireEvent.change(composer, { target: { value: "同时整理风险" } });
    fireEvent.submit(parentForm(composer));
    await waitFor(() => expect(send).toHaveBeenCalledWith("同时整理风险", {}));
    expect(await screen.findAllByText("queued")).toHaveLength(2);
  });

  it("routes the composer input to the Workbench chosen in the toolbar", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbenchDto("workbench-work", "发布工程")] });
    const send = vi.spyOn(api, "sendJoiMessage").mockResolvedValue({ acceptedAt: "2026-07-28T10:00:00.000Z", inputId: "input-1", status: "PENDING" });
    render(<JoiHome api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "joi 自主分发" }));
    expect(screen.queryByText("这条输入交给谁")).not.toBeInTheDocument();
    expect(screen.queryByText(/不选择时由 joi 自主判断归属/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "joi 自主分发（默认）" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "发布工程" }));
    expect(screen.getByRole("button", { name: "分发给 发布工程" })).toBeInTheDocument();

    const composer = screen.getByLabelText("给 joi 输入");
    fireEvent.change(composer, { target: { value: "发布一版" } });
    fireEvent.submit(parentForm(composer));
    await waitFor(() => expect(send).toHaveBeenCalledWith("发布一版", { workbenchId: "workbench-work" }));
  });

  it("keeps a large composer workbench picker searchable", async () => {
    const api = new DigitalLifeApi("");
    const workbenches = Array.from({ length: 20 }, (_, index) => workbenchDto(`composer-workbench-${String(index)}`, `工作台 ${String(index)}`));
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({ goals: [], thinking: [], unassignedActions: [] });

    render(<JoiHome api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "joi 自主分发" }));
    expect(screen.queryByText("这条输入交给谁")).not.toBeInTheDocument();
    expect(screen.queryByText(/不选择时由 joi 自主判断归属/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "joi 自主分发（默认）" })).not.toBeInTheDocument();
    const search = screen.getByLabelText("搜索工作台");
    const list = screen.getByRole("group", { name: "工作台列表" });
    expect(list).toHaveClass("joi-workbench-options");
    expect(within(list).getAllByRole("button")).toHaveLength(20);
    fireEvent.change(search, { target: { value: "工作台 17" } });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(within(list).getByRole("button", { name: "工作台 17" })).toBeInTheDocument();
  });

  it("shows Joi-proposed Workbench changes and requires an explicit user decision", async () => {
    const api = new DigitalLifeApi("");
    const pending = {
      createdAt: "2026-07-28T10:00:00.000Z", kind: "MERGE" as const, reason: "同一工程上下文",
      requestId: "change-1", sourceWorkbenchId: "workbench-old", status: "PENDING" as const, targetWorkbenchId: "workbench-current",
    };
    vi.spyOn(api, "joiSnapshot")
      .mockResolvedValueOnce({ ...snapshot([readySource]), workbenchChanges: [pending] })
      .mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    const decide = vi.spyOn(api, "decideWorkbenchChange").mockResolvedValue({ ...pending, status: "CONFIRMED" });
    render(<JoiHome api={api} />);
    expect(await screen.findByText("joi 建议合并工作台")).toBeInTheDocument();
    expect(screen.getByText("同一工程上下文")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认合并" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("change-1", "CONFIRM"));
    await waitFor(() => expect(screen.queryByText("joi 建议合并工作台")).not.toBeInTheDocument());
  });

  it("selects a provider access mode before saving and validating a source", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValueOnce(snapshot([])).mockResolvedValue(snapshot([readySource]));
    const create = vi.spyOn(api, "createModelSource").mockResolvedValue({ ...readySource, status: "DRAFT" });
    vi.spyOn(api, "validateModelSource").mockResolvedValue(readySource);
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "连接 Kimi" }));
    expect(screen.getByRole("button", { name: "开放平台 API" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Kimi Code" }));
    expect(screen.getByRole("button", { name: "OpenAI-compatible" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anthropic-compatible" }));
    expect(screen.getByText(/订阅套餐仅适合个人交互使用/u)).toBeInTheDocument();
    expect(screen.getByText(/K3 的 Model ID 是 k3，不是 kimi-k3/u)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Model ID（可选，高级设置）"), { target: { value: "kimi-custom" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key" } });
    fireEvent.submit(parentForm(screen.getByLabelText("API Key")));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ accessMode: "coding-plan", apiKey: "test-key", kind: "kimi", modelId: "kimi-custom", protocol: "anthropic" }));
    expect(await screen.findByRole("heading", { name: "现在想让 joi 做什么？" })).toBeInTheDocument();
  });

  it("offers a separate Qwen Token Plan connection", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValueOnce(snapshot([])).mockResolvedValue(snapshot([readySource]));
    const create = vi.spyOn(api, "createModelSource").mockResolvedValue({ ...readySource, status: "DRAFT" });
    vi.spyOn(api, "validateModelSource").mockResolvedValue(readySource);
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "连接 Qwen" }));
    expect(screen.getByRole("button", { name: "百炼 Coding Plan" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "百炼 Token Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Anthropic-compatible" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key" } });
    fireEvent.submit(parentForm(screen.getByLabelText("API Key")));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ accessMode: "token-plan", apiKey: "test-key", kind: "qwen", modelId: undefined, protocol: "anthropic" }));
  });

  it("keeps a failed generic source as a diagnosable draft and supports local keyless fields", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([]));
    const generic = { ...readySource, baseUrl: "http://127.0.0.1:11434/v1", displayName: "本机", kind: "generic-openai" as const, status: "DRAFT" as const };
    const create = vi.spyOn(api, "createModelSource").mockResolvedValue(generic);
    vi.spyOn(api, "validateModelSource").mockResolvedValue({ ...generic, reasonCode: "endpoint_unreachable", status: "DEGRADED" });
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "连接 通用平台" }));
    fireEvent.click(screen.getByRole("button", { name: "OpenAI-compatible" }));
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "本机" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:11434/v1" } });
    fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "local-model" } });
    fireEvent.submit(parentForm(screen.getByLabelText("API Key（本机 localhost 可留空）")));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ accessMode: "custom", apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", displayName: "本机", kind: "generic-openai", modelId: "local-model", protocol: "openai" }));
    expect(await screen.findByText(/无法访问所选接口/u)).toBeInTheDocument();
  });

  it("manages redacted source ordering, validation, disable and deletion", async () => {
    const api = new DigitalLifeApi("");
    const backup = { ...readySource, accessMode: "coding-plan" as const, activeModel: { ...readySource.activeModel, id: "kimi-for-coding" }, displayName: "Kimi Code", kind: "kimi" as const, order: 1, primary: false, protocol: "anthropic" as const, sourceId: "source-2" };
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [readySource, backup] });
    const order = vi.spyOn(api, "orderModelSources").mockResolvedValue({ items: [{ ...backup, order: 0, primary: true }, { ...readySource, order: 1, primary: false }] });
    const validate = vi.spyOn(api, "validateModelSource").mockResolvedValueOnce(readySource).mockRejectedValueOnce(new Error("offline"));
    const update = vi.spyOn(api, "updateModelSource").mockResolvedValue({ ...readySource, status: "DISABLED" });
    const remove = vi.spyOn(api, "deleteModelSource").mockResolvedValue(undefined);
    render(<ModelSourceManager api={api} />);
    expect(await screen.findByText("DeepSeek")).toBeInTheDocument();
    expect(screen.getByText(/Coding Plan/u)).toBeInTheDocument();
    expect(screen.getByText(/Anthropic-compatible/u)).toBeInTheDocument();
    const kimi = screen.getByText("Kimi Code").closest("article");
    if (kimi === null) throw new Error("Kimi source row missing");
    expect(kimi).toHaveClass("model-source-item");
    expect(within(kimi).getByRole("group", { name: "Kimi Code 操作" })).toHaveClass("model-source-actions");
    fireEvent.click(within(kimi).getByRole("button", { name: "上移" }));
    await waitFor(() => expect(order).toHaveBeenCalledWith(["source-2", "source-1"]));
    const deepseek = screen.getByText("DeepSeek").closest("article");
    if (deepseek === null) throw new Error("DeepSeek source row missing");
    fireEvent.click(within(deepseek).getByRole("button", { name: "验证" }));
    fireEvent.click(within(deepseek).getByRole("button", { name: "停用" }));
    fireEvent.click(within(deepseek).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(validate).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith("source-1", { disabled: true });
    expect(remove).toHaveBeenCalledWith("source-1");
    fireEvent.click(within(kimi).getByRole("button", { name: "验证" }));
    expect(await screen.findByText("验证没有通过。")).toBeInTheDocument();
  });

  it("edits model, endpoint metadata and optional replacement credentials as a new draft revision", async () => {
    const api = new DigitalLifeApi("");
    const generic = {
      ...readySource, accessMode: "custom" as const, activeModel: { ...readySource.activeModel, id: "old-model" }, baseUrl: "https://old.example/v1",
      displayName: "Private", kind: "generic-openai" as const, sourceId: "source-generic",
    };
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [generic] });
    const update = vi.spyOn(api, "updateModelSource").mockResolvedValue({
      ...generic, activeModel: { ...generic.activeModel, id: "new-model" }, baseUrl: "https://new.example/v1", displayName: "Private 2", status: "DRAFT",
    });
    render(<ModelSourceManager api={api} />);
    expect(await screen.findByText(/自定义接口/u)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "编辑 Private" }));
    fireEvent.change(screen.getByLabelText("编辑显示名称"), { target: { value: "Private 2" } });
    fireEvent.change(screen.getByLabelText("编辑 Base URL"), { target: { value: "https://new.example/v1" } });
    fireEvent.change(screen.getByLabelText("编辑 Model ID"), { target: { value: "new-model" } });
    fireEvent.change(screen.getByLabelText("替换 API Key（留空则保留）"), { target: { value: "replacement-key" } });
    fireEvent.submit(parentForm(screen.getByLabelText("编辑 Model ID")));
    await waitFor(() => expect(update).toHaveBeenCalledWith("source-generic", {
      apiKey: "replacement-key", baseUrl: "https://new.example/v1", displayName: "Private 2", modelId: "new-model",
    }));
    expect(await screen.findByText("修改已保存为草稿 revision，请验证后启用。")).toBeInTheDocument();
  });

  it("renders a human-readable label for every model-source status", async () => {
    const api = new DigitalLifeApi("");
    const states: ModelSourceDto["status"][] = ["DRAFT", "VALIDATING", "DEGRADED", "NEEDS_AUTH", "DISABLED"];
    const items = states.map((status, index) => ({ ...readySource, displayName: `源 ${String(index)}`, sourceId: `source-${String(index)}`, status }));
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items });
    render(<ModelSourceManager api={api} />);
    for (const label of ["草稿", "正在验证", "暂时异常", "需要重新连接", "已停用"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
  });

  it("keeps snapshot and composer failures retryable without losing text", async () => {
    const api = new DigitalLifeApi("");
    const snapshotSpy = vi.spyOn(api, "joiSnapshot")
      .mockRejectedValueOnce(new ApiError("offline", "模型网络离线", 503))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "sendJoiMessage").mockRejectedValue(new ApiError("save_failed", "输入暂时无法保存", 503));
    render(<JoiHome api={api} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("模型网络离线");
    fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("没能读取 joi 的状态");
    fireEvent.click(screen.getByRole("button", { name: "再试一次" }));
    const composer = await screen.findByLabelText("给 joi 输入");
    fireEvent.change(composer, { target: { value: "不能丢失" } });
    fireEvent.submit(parentForm(composer));
    expect(await screen.findByRole("alert")).toHaveTextContent("输入暂时无法保存");
    expect(composer).toHaveValue("不能丢失");
    expect(snapshotSpy).toHaveBeenCalledTimes(3);
  });

  it("reports setup and settings load failures and allows canceling a selected network", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([]));
    vi.spyOn(api, "createModelSource").mockRejectedValueOnce(new ApiError("invalid", "密钥不正确", 400)).mockRejectedValue(new Error("failed"));
    const view = render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "连接 DeepSeek" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "连接 DeepSeek" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "bad" } });
    fireEvent.submit(parentForm(screen.getByLabelText("API Key")));
    expect(await screen.findByText("密钥不正确")).toBeInTheDocument();
    fireEvent.submit(parentForm(screen.getByLabelText("API Key")));
    expect(await screen.findByText(/连接没检查成功/)).toBeInTheDocument();
    view.unmount();
    vi.spyOn(api, "listModelSources").mockRejectedValue(new Error("offline"));
    render(<ModelSourceManager api={api} />);
    expect(await screen.findByText("没能读取模型网络设置。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加网络" }));
    expect(screen.getByRole("heading", { name: "joi需要链接到大模型网络" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
  });

  it("renders one minimal goal stream with transient thinking and no right-side work panel", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbenchDto("workbench-1", "登录工程")] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{ agentCount: 2, workbench: { workbenchId: "workbench-1", name: "登录工程" }, canDelete: false, goalId: "goal-1", status: "RUNNING", title: "研究一下登录改造", updatedAt: "2026-07-28T10:00:00.000Z", work: { active: 1, completed: 1, failed: 0, total: 2 } }],
      thinking: [{
        agentCount: 2,
        goalId: "goal-1",
        phase: "progressing",
        stage: "RUNNING",
        startedAt: "2026-07-28T10:00:00.000Z",
        turnId: "turn-1",
        work: { active: 1, completed: 1, failed: 0, total: 2 },
      }],
      unassignedActions: [{ acceptedAt: "2026-07-28T10:00:03.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "clarify", status: "CLARIFICATION_REQUIRED", textPreview: "这条到底归谁" }],
    });
    render(<JoiHome api={api} />);
    expect(await screen.findByRole("heading", { name: "现在想让 joi 做什么？" })).toBeInTheDocument();
    expect(await screen.findByText("研究一下登录改造")).toBeInTheDocument();
    expect(screen.getByText("这条到底归谁")).toBeInTheDocument();
    expect(screen.getByText("progressing")).toBeInTheDocument();
    expect(screen.getByText("搭档执行中", { selector: ".joi-thinking-stage" })).toBeInTheDocument();
    expect(screen.getByText(/已用/u, { selector: ".joi-thinking-elapsed" })).toBeInTheDocument();
    expect(screen.getByText(/2 Agent · 1\/2 工作完成/u, { selector: ".joi-thinking-meta" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "工作状态" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录工程" })).toBeInTheDocument();
  });

  it("shows safe stage/count summaries across elapsed-time bands and tolerates an old thinking DTO", async () => {
    const api = new DigitalLifeApi("");
    const now = Date.now();
    const legacyThinking = {
      goalId: "legacy-thinking",
      phase: "progressing" as const,
      startedAt: new Date(now - 5_000).toISOString(),
      turnId: "legacy-thinking-turn",
    } as unknown as JoiThinkingItemDto;
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [],
      thinking: [
        { agentCount: 0, goalId: "planning", phase: "progressing", stage: "PLANNING", startedAt: new Date(now - 5_000).toISOString(), turnId: "planning-turn", work: { active: 0, completed: 0, failed: 0, total: 0 } },
        { agentCount: 2, goalId: "dispatching", phase: "progressing", stage: "DISPATCHING", startedAt: new Date(now - 65_000).toISOString(), turnId: "dispatching-turn", work: { active: 2, completed: 1, failed: 1, total: 3 } },
        { agentCount: 0, goalId: "waiting", phase: "progressing", stage: "WAITING", startedAt: new Date(now - 65_000).toISOString(), turnId: "waiting-turn", work: { active: 1, completed: 0, failed: 0, total: 1 } },
        { agentCount: 1, goalId: "finalizing", phase: "progressing", stage: "FINALIZING", startedAt: new Date(now - 2 * 60 * 60 * 1_000).toISOString(), turnId: "finalizing-turn", work: { active: 0, completed: 1, failed: 0, total: 1 } },
        legacyThinking,
      ],
      unassignedActions: [],
    });
    render(<JoiHome api={api} />);
    expect(await screen.findByText("正在拆分工作", { selector: ".joi-thinking-stage" })).toBeInTheDocument();
    expect(screen.getByText("正在安排搭档", { selector: ".joi-thinking-stage" })).toBeInTheDocument();
    expect(screen.getByText("等待搭档回应", { selector: ".joi-thinking-stage" })).toBeInTheDocument();
    expect(screen.getByText("正在汇总结果", { selector: ".joi-thinking-stage" })).toBeInTheDocument();
    expect(screen.getByText("正在整理任务", { selector: ".joi-thinking-stage" })).toBeInTheDocument();
    expect(screen.getByText("2 Agent · 1/3 工作完成 · 1 失败", { selector: ".joi-thinking-meta" })).toBeInTheDocument();
    expect(screen.getAllByText(/已用 [0-9]+ 秒/u, { selector: ".joi-thinking-elapsed" })).toHaveLength(2);
    expect(screen.getAllByText(/已用 1 分钟/u, { selector: ".joi-thinking-elapsed" })).toHaveLength(2);
    expect(screen.getByText(/已用 2 小时/u, { selector: ".joi-thinking-elapsed" })).toBeInTheDocument();
  });

  it("drills from a goal card into an inline detail with the Workbench title, agent list and live data stream", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-1", "登录工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{
        agentCount: 2, workbench: { workbenchId: workbench.workbenchId, name: workbench.name }, canDelete: true,
        completionSummary: "## 登录改造完成\n\n**功能** 已通过验收。\n\n| 维度 | 结果 |\n| --- | --- |\n| 回归 | 通过 |",
        goalId: "goal-1", status: "COMPLETED", title: "研究一下登录改造", updatedAt: "2026-07-28T10:00:00.000Z", work: { active: 0, completed: 2, failed: 0, total: 2 },
      }],
      thinking: [],
      unassignedActions: [],
    });
    const agent = {
      agentId: "agent-1", workbenchId: workbench.workbenchId, canDelete: true, createdAt: "2026-07-28T10:00:00.000Z", engine: "pi-core" as const,
      lastActivityAt: "2026-07-28T10:00:00.000Z", partnerId: "partner-1", partnerName: "实现者", sessionPolicy: "EPHEMERAL" as const,
      status: "COMPLETED" as const, transport: "LOCAL" as const,
    };
    const other = { ...agent, agentId: "agent-2", partnerName: "审查者" };
    const listAgents = vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [agent, other] });
    vi.spyOn(api, "agentConversation").mockImplementation((_workbenchId: string, agentId: string) => Promise.resolve({
      agent: agentId === "agent-2" ? other : agent,
      items: [{ createdAt: "2026-07-28T10:00:00.000Z", entryId: `entry-${agentId}`, kind: "MARKDOWN" as const, role: "AGENT" as const, sequence: 0, text: agentId === "agent-2" ? "审查通过" : "改造完成报告" }],
    }));
    render(<JoiHome api={api} />);
    const previewStrong = await screen.findByText("功能");
    expect(previewStrong.tagName).toBe("STRONG");
    expect(screen.getAllByRole("table")).toHaveLength(1);

    fireEvent.click(screen.getByText("研究一下登录改造"));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "研究一下登录改造" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "最终结果" })).toBeInTheDocument();
    expect(screen.getByLabelText("joi 信息流")).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getByLabelText("这条目标的 Agent 列表")).toBeInTheDocument();
    await waitFor(() => expect(listAgents).toHaveBeenCalledWith(workbench.workbenchId, { goalId: "goal-1", limit: 100 }));
    expect(await screen.findByText("改造完成报告")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /审查者/u }));
    expect(await screen.findByText("审查通过")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("joi 信息流")).toBeInTheDocument();
  });

  it("refreshes the selected running Agent quickly enough to reveal an incoming visible message", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-live", "实时分析");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{
        agentCount: 1, workbench: { workbenchId: workbench.workbenchId, name: workbench.name }, canDelete: false,
        goalId: "goal-live", status: "RUNNING", title: "跟踪分析过程", updatedAt: workbench.updatedAt,
        work: { active: 1, completed: 0, failed: 0, total: 1 },
      }],
      thinking: [],
      unassignedActions: [],
    });
    const agent = {
      agentId: "agent-live", workbenchId: workbench.workbenchId, canDelete: false, createdAt: workbench.updatedAt,
      engine: "pi-core" as const, lastActivityAt: workbench.updatedAt, partnerId: "partner-live", partnerName: "分析搭档",
      sessionPolicy: "EPHEMERAL" as const, status: "RUNNING" as const, transport: "LOCAL" as const,
    };
    vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [agent] });
    const conversation = vi.spyOn(api, "agentConversation")
      .mockResolvedValueOnce({ agent, items: [] })
      .mockResolvedValue({
        agent,
        items: [{ createdAt: workbench.updatedAt, entryId: "entry-live", kind: "MARKDOWN", role: "AGENT", sequence: 0, text: "正在流式整理证据" }],
      });

    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByText("跟踪分析过程"));
    expect(await screen.findByText("这位 Agent 还没有可展示的执行消息。")).toBeInTheDocument();
    expect(await screen.findByText("正在流式整理证据", {}, { timeout: 1_400 })).toBeInTheDocument();
    expect(conversation.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("downgrades a failed partner to a clickable warning on a completed goal and opens its error stream", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-partial", "综合工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{
        agentCount: 2, workbench: { workbenchId: workbench.workbenchId, name: workbench.name }, canDelete: true,
        completionSummary: "## 最终结论\n\n已有信息足够回答原问题。", goalId: "goal-partial", status: "COMPLETED",
        title: "汇总搭档结论", updatedAt: workbench.updatedAt, work: { active: 0, completed: 1, failed: 1, total: 2 },
      }],
      thinking: [],
      unassignedActions: [],
    });
    const completed = {
      agentId: "agent-completed", workbenchId: workbench.workbenchId, canDelete: true, createdAt: workbench.updatedAt,
      engine: "pi-core" as const, lastActivityAt: workbench.updatedAt, partnerId: "partner-completed", partnerName: "完成搭档",
      sessionPolicy: "EPHEMERAL" as const, status: "COMPLETED" as const, transport: "LOCAL" as const,
    };
    const failed = {
      ...completed, agentId: "agent-failed", partnerId: "partner-failed", partnerName: "失败搭档", status: "FAILED" as const,
    };
    vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [completed, failed] });
    const conversation = vi.spyOn(api, "agentConversation").mockImplementation((_workbenchId, agentId) => Promise.resolve({
      agent: agentId === failed.agentId ? failed : completed,
      items: [{
        createdAt: workbench.updatedAt, entryId: `entry-${agentId}`, kind: agentId === failed.agentId ? "ERROR" as const : "MARKDOWN" as const,
        role: "AGENT" as const, sequence: 0, text: agentId === failed.agentId ? "安全错误详情" : "成功结果详情",
      }],
    }));

    render(<JoiHome api={api} />);
    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("已有信息足够回答原问题。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看 1 个异常搭档" }));

    expect(await screen.findByText("安全错误详情")).toBeInTheDocument();
    expect(conversation).toHaveBeenCalledWith(workbench.workbenchId, failed.agentId, { limit: 50 });
    expect(screen.getByRole("button", { name: /失败搭档/u })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the clean final-result drawer from the card preview and can switch into the full goal detail", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-1", "登录工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{
        agentCount: 1, workbench: { workbenchId: workbench.workbenchId, name: workbench.name }, canDelete: true,
        completedAt: "2026-07-28T11:00:00.000Z",
        completionSummary: "## 登录改造完成\n\n**功能** 已通过验收，完整报告如下。",
        goalId: "goal-1", status: "COMPLETED", title: "研究一下登录改造", updatedAt: "2026-07-28T11:00:00.000Z", work: { active: 0, completed: 2, failed: 0, total: 2 },
      }],
      thinking: [],
      unassignedActions: [],
    });
    const listAgents = vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [] });
    render(<JoiHome api={api} />);
    const preview = await screen.findByRole("button", { name: /最终结果全文/u });
    expect(preview).toHaveTextContent("已通过验收");

    fireEvent.keyDown(preview, { key: "ArrowDown" });
    fireEvent.keyDown(preview, { key: " " });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.click(preview);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "最终结果" })).toBeInTheDocument();
    expect(within(drawer).getByText("已通过验收，完整报告如下。")).toBeInTheDocument();
    expect(within(drawer).queryByLabelText("这条目标的 Agent 列表")).not.toBeInTheDocument();

    fireEvent.click(within(drawer).getByRole("button", { name: "查看详情" }));
    expect(await screen.findByLabelText("这条目标的 Agent 列表")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "研究一下登录改造" })).toBeInTheDocument();
    await waitFor(() => expect(listAgents).toHaveBeenCalledWith(workbench.workbenchId, { goalId: "goal-1", limit: 100 }));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a persisted direct answer on a zero-Work completed card", async () => {
    const api = new DigitalLifeApi("", true);
    const workbench = workbenchDto("workbench-direct", "问答工作台");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{
        agentCount: 0, workbench: { workbenchId: workbench.workbenchId, name: workbench.name }, canDelete: true,
        artifacts: [{ artifactId: "goal-artifact-1", kind: "FILE", mimeType: "text/markdown", name: "answer.md", size: 256 }],
        completedAt: "2026-08-24T09:00:00.000Z", completionSummary: "## 身份\n\n我是 **Joi**，你的 AI 助手。",
        goalId: "input-direct", status: "COMPLETED", title: "你是谁", updatedAt: "2026-08-24T09:00:00.000Z",
        work: { active: 0, completed: 0, failed: 0, total: 0 },
      }],
      thinking: [],
      unassignedActions: [],
    });
    vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [] });
    const openArtifact = vi.spyOn(api, "openWorkbenchArtifact").mockResolvedValue({ opened: true });
    render(<JoiHome api={api} />);

    const preview = await screen.findByRole("button", { name: "打开「你是谁」的最终结果全文" });
    expect(preview).toHaveTextContent("我是 Joi，你的 AI 助手。");
    fireEvent.click(preview);
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByRole("heading", { name: "最终结果" })).toBeInTheDocument();
    const artifactButton = within(drawer).getByRole("button", { name: "打开产物 answer.md" });
    fireEvent.click(artifactButton);
    await waitFor(() => expect(openArtifact).toHaveBeenCalledWith(workbench.workbenchId, {
      artifactId: "goal-artifact-1", mode: "OPEN", source: "GOAL", sourceId: "input-direct",
    }));
    fireEvent.contextMenu(artifactButton);
    await waitFor(() => expect(openArtifact).toHaveBeenCalledWith(workbench.workbenchId, {
      artifactId: "goal-artifact-1", mode: "REVEAL", source: "GOAL", sourceId: "input-direct",
    }));
  });

  it("shows the harness map panel in the goal detail only when the feed carries a projection", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-h", "分析工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [
        {
          agentCount: 0, workbench: { workbenchId: workbench.workbenchId, name: workbench.name }, canDelete: false,
          goalId: "goal-h",
          harness: {
            currentLayer: 2, decisionCount: 3, destination: "完成 688141 分析", fogCount: 1, mapStatus: "ACTIVE",
            openPathCount: 1, reviewedRevision: 1, revision: 5, topFogNote: "数据源未定",
            topPaths: [
              { pathId: "p2", status: "OPEN", title: "深入财报" },
              { pathId: "p1", status: "CLOSED", title: "收集资料" },
              { pathId: "p0", status: "OUT_OF_SCOPE", title: "盯盘" },
            ],
          },
          status: "RUNNING", title: "分析股票", updatedAt: "2026-08-06T10:00:00.000Z",
          work: { active: 1, completed: 0, failed: 0, total: 1 },
        },
        {
          agentCount: 0, workbench: { workbenchId: workbench.workbenchId, name: workbench.name }, canDelete: false,
          goalId: "goal-plain", status: "ARRANGING", title: "随手一问", updatedAt: "2026-08-06T10:00:00.000Z",
          work: { active: 0, completed: 0, failed: 0, total: 0 },
        },
      ],
      thinking: [],
      unassignedActions: [],
    });
    vi.spyOn(api, "listWorkbenchAgents").mockResolvedValue({ items: [] });

    const view = render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByText("分析股票"));
    expect(await screen.findByText("目的地：完成 688141 分析")).toBeInTheDocument();
    expect(screen.getByText("深入财报")).toBeInTheDocument();
    expect(screen.getByText("收集资料")).toBeInTheDocument();
    expect(screen.getByText("盯盘")).toBeInTheDocument();
    expect(screen.getByText(/已决策 3 · 雾区 1 · 第 2 层路径/u)).toBeInTheDocument();
    expect(screen.getByText("雾区：数据源未定")).toBeInTheDocument();

    view.unmount();
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByText("随手一问"));
    await screen.findByRole("heading", { name: "随手一问" });
    expect(screen.queryByText(/目的地/u)).not.toBeInTheDocument();
  });

  it("renders every goal phase, keeps settled thinking briefly, expires old thinking and removes a terminal goal", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-phases", "阶段 Workbench");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    const statuses = ["ARRANGING", "ARRANGED", "RUNNING", "REVIEWING", "EXTENDING", "NEEDS_ATTENTION", "FINALIZING", "COMPLETED", "FAILED", "CANCELED"] as const;
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: statuses.map((status, index): JoiGoalCardDto => {
        const base = {
          agentCount: index,
          workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
          canDelete: status === "COMPLETED",
          goalId: `goal-${status}`,
          ...(status === "FAILED" ? { completionSummary: "有一项执行未完成" } : {}),
          title: `目标 ${status}`,
          updatedAt: workbench.updatedAt,
          work: { active: status === "RUNNING" ? 1 : 0, completed: status === "COMPLETED" ? 1 : 0, failed: status === "FAILED" ? 1 : 0, total: 1 },
        };
        return status === "NEEDS_ATTENTION"
          ? { ...base, clarification: { reasonCode: "question_required" }, status }
          : { ...base, status };
      }),
      thinking: [
        { agentCount: 6, expiresAt: "2099-01-01T00:00:00.000Z", goalId: "goal-COMPLETED", phase: "settled", stage: "FINALIZING", startedAt: workbench.updatedAt, turnId: "settled-visible", work: { active: 0, completed: 1, failed: 0, total: 1 } },
        { agentCount: 0, expiresAt: "2000-01-01T00:00:00.000Z", goalId: "goal-CANCELED", phase: "settled", stage: "FINALIZING", startedAt: workbench.updatedAt, turnId: "settled-expired", work: { active: 0, completed: 0, failed: 0, total: 0 } },
      ],
      unassignedActions: [],
    });
    const dismiss = vi.spyOn(api, "dismissJoiMessage").mockResolvedValue({ acceptedAt: workbench.updatedAt, inputId: "goal-COMPLETED", status: "CONSUMED" });

    render(<JoiHome api={api} />);
    expect(await screen.findByText("正在评审")).toBeInTheDocument();
    expect(screen.getByText("评审后补充执行")).toBeInTheDocument();
    for (const label of ["正在安排", "已安排", "执行中", "需要你", "正在总结", "已完成", "处理失败", "已取消"]) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("有一项执行未完成")).toBeInTheDocument();
    expect(screen.getAllByText("progressing")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "移除这条卡片" }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("goal-COMPLETED"));
    expect(screen.queryByText("目标 COMPLETED")).not.toBeInTheDocument();
  });

  it("offers cancellation for an arranged goal so a stuck queue has a safe fallback", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-arranged-cancel", "排队 Workbench");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{
        agentCount: 0,
        workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
        canDelete: false,
        goalId: "goal-arranged-cancel",
        status: "ARRANGED",
        title: "卡住的排队任务",
        updatedAt: workbench.updatedAt,
        work: { active: 1, completed: 0, failed: 0, total: 1 },
      }],
      thinking: [],
      unassignedActions: [],
    });
    const cancel = vi.spyOn(api, "cancelJoiMessage").mockResolvedValue({ acceptedAt: workbench.updatedAt, canceled: true, inputId: "goal-arranged-cancel", status: "CONSUMED" });

    render(<JoiHome api={api} />);
    expect(await screen.findByText("已安排")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消这条任务" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("goal-arranged-cancel"));
  });

  it("explains a parked internal failure without presenting it as a cancellation", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-failure", "失败说明");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{
        agentCount: 0,
        workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
        canDelete: true,
        failure: { attempts: 8, executionStarted: false, reasonCode: "unsafe_reasoning_tool", suggestedAction: "RESTART_OR_UPDATE" },
        goalId: "goal-failure",
        status: "FAILED",
        title: "刚提交就停止的任务",
        updatedAt: workbench.updatedAt,
        work: { active: 0, completed: 0, failed: 0, total: 0 },
      }],
      thinking: [],
      unassignedActions: [],
    });

    render(<JoiHome api={api} />);
    expect(await screen.findByText("处理失败")).toBeInTheDocument();
    expect(screen.getByText(/已自动尝试 8 次，现已停止重试/u)).toBeInTheDocument();
    expect(screen.getByText(/尚未启动 Agent，也没有派发工作/u)).toBeInTheDocument();
    expect(screen.getByText(/重启或升级 joi 后重新提交/u)).toBeInTheDocument();
    expect(screen.getByText(/诊断编号：unsafe_reasoning_tool/u)).toBeInTheDocument();
    expect(screen.queryByText("已取消")).not.toBeInTheDocument();
  });

  it("offers a unified continue action on every terminal goal card and re-dispatches with optional supplementary text", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-retry", "继续工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    const makeGoal = (status: "CANCELED" | "COMPLETED" | "FAILED", goalId: string, title: string) => ({
      agentCount: 0,
      workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
      canDelete: status !== "FAILED",
      ...(status === "FAILED" ? { failure: { attempts: 8, executionStarted: false, reasonCode: "work_dispatch_failed", suggestedAction: "RETRY_OR_EXPORT_DIAGNOSTICS" as const } } : {}),
      ...(status === "COMPLETED" ? { completionSummary: "结果已汇总", completedAt: workbench.updatedAt } : {}),
      goalId,
      status,
      title,
      updatedAt: workbench.updatedAt,
      work: { active: 0, completed: 0, failed: status === "FAILED" ? 1 : 0, total: 1 },
    });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [
        makeGoal("FAILED", "goal-failed", "失败的目标"),
        makeGoal("CANCELED", "goal-canceled", "取消的目标"),
        makeGoal("COMPLETED", "goal-completed", "完成的目标"),
      ],
      thinking: [],
      unassignedActions: [],
    });
    const retry = vi.spyOn(api, "retryJoiMessage").mockResolvedValue({ acceptedAt: workbench.updatedAt, inputId: "goal-failed", status: "PENDING" });

    render(<JoiHome api={api} />);
    // Every terminal card exposes a continue toggle; running cards do not.
    expect(await screen.findByRole("button", { name: "继续「失败的目标」" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续「取消的目标」" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续「完成的目标」" })).toBeInTheDocument();
    const failedGoalActions = screen.getByRole("group", { name: "失败的目标 操作" });
    expect(failedGoalActions).toHaveClass("joi-goal-actions");
    expect(failedGoalActions.parentElement).toHaveClass("joi-goal-side");
    const failedGoalStatus = failedGoalActions.closest(".joi-goal-row")?.querySelector(".joi-goal-status");
    expect(failedGoalStatus).toHaveTextContent("处理失败");
    expect(failedGoalStatus?.parentElement).toHaveClass("joi-goal-side");
    const failedGoalTitle = failedGoalActions.closest(".joi-goal-card")?.querySelector(".joi-goal-title");
    expect(failedGoalTitle).toHaveTextContent("失败的目标");

    // Expanding the failed card shows the supplementary input and submits with text.
    fireEvent.click(screen.getByRole("button", { name: "继续「失败的目标」" }));
    expect(await screen.findByText(/问题处理好后，可以继续这条任务/u)).toBeInTheDocument();
    const supplementary = screen.getByLabelText("补充说明");
    fireEvent.change(supplementary, { target: { value: "已修复搭档技能，重新派发" } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("goal-failed", { text: "已修复搭档技能，重新派发" }));

    // The canceled card retries with an empty body (no text field).
    fireEvent.click(screen.getByRole("button", { name: "继续「取消的目标」" }));
    expect(await screen.findByText(/这条任务之前被取消了/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("goal-canceled", {}));
  });

  it("shows a result-drawer retry as arranging before the follow-up feed refresh completes", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-result-retry", "结果继续工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    const feed = {
      goals: [{
        agentCount: 0,
        canDelete: true,
        completionSummary: "已完成的结果",
        completedAt: workbench.updatedAt,
        goalId: "goal-result-retry",
        status: "COMPLETED" as const,
        title: "结果目标",
        updatedAt: workbench.updatedAt,
        workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
        work: { active: 0, completed: 1, failed: 0, total: 1 },
      }],
      thinking: [],
      unassignedActions: [],
    };
    let releaseRefresh: (() => void) | undefined;
    vi.spyOn(api, "joiHomeFeed")
      .mockResolvedValueOnce(feed)
      .mockImplementation(() => new Promise((resolve) => { releaseRefresh = () => resolve(feed); }));
    vi.spyOn(api, "retryJoiMessage").mockResolvedValue({ acceptedAt: workbench.updatedAt, inputId: "goal-result-retry", status: "PENDING" });

    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "打开「结果目标」的最终结果全文" }));
    const drawer = await screen.findByRole("dialog", { name: "结果继续工程 的最终结果" });
    fireEvent.change(within(drawer).getByLabelText("补充说明"), { target: { value: "补充后续要求" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "继续" }));
    expect(await screen.findByText("正在安排")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "queued" })).toBeInTheDocument();
    releaseRefresh?.();
  });

  it("shows a retry as arranging before the follow-up feed refresh completes", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-fast-retry", "即时反馈工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    const feed = {
      goals: [{
        agentCount: 0,
        workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
        canDelete: true,
        goalId: "goal-fast-retry",
        status: "FAILED" as const,
        title: "马上继续的目标",
        updatedAt: workbench.updatedAt,
        work: { active: 0, completed: 0, failed: 1, total: 1 },
      }],
      thinking: [],
      unassignedActions: [],
    };
    let releaseRefresh: (() => void) | undefined;
    vi.spyOn(api, "joiHomeFeed")
      .mockResolvedValueOnce(feed)
      .mockImplementation(() => new Promise((resolve) => { releaseRefresh = () => resolve(feed); }));
    vi.spyOn(api, "retryJoiMessage").mockResolvedValue({ acceptedAt: workbench.updatedAt, inputId: "goal-fast-retry", status: "PENDING" });

    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "继续「马上继续的目标」" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    expect(await screen.findByText("正在安排")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "queued" })).toBeInTheDocument();
    releaseRefresh?.();
  });

  it("shows an explicit submitting stage before the retry request is acknowledged", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-submit-gap", "提交反馈工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    const feed = {
      goals: [{
        agentCount: 0,
        workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
        canDelete: false,
        goalId: "goal-submit-gap",
        status: "FAILED" as const,
        title: "继续提交不能静默",
        updatedAt: workbench.updatedAt,
        work: { active: 0, completed: 0, failed: 1, total: 1 },
      }],
      thinking: [],
      unassignedActions: [],
    };
    vi.spyOn(api, "joiHomeFeed")
      .mockResolvedValueOnce(feed)
      .mockImplementation(() => new Promise(() => undefined));
    let acknowledge: ((accepted: JoiAcceptedMessageDto) => void) | undefined;
    vi.spyOn(api, "retryJoiMessage").mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));

    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "继续「继续提交不能静默」" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));

    expect(await screen.findByRole("status", { name: "正在提交继续请求" })).toBeInTheDocument();
    expect(screen.queryByText("正在安排")).not.toBeInTheDocument();

    await act(async () => {
      acknowledge?.({ acceptedAt: workbench.updatedAt, inputId: "goal-submit-gap", status: "PENDING" });
      await Promise.resolve();
    });
    expect(await screen.findByText("正在安排")).toBeInTheDocument();
  });

  it("clears the submitting stage and keeps retry actionable when the request is rejected", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-submit-rejected", "提交失败工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({
      goals: [{
        agentCount: 0,
        workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
        canDelete: false,
        goalId: "goal-submit-rejected",
        status: "FAILED" as const,
        title: "提交失败后仍可重试",
        updatedAt: workbench.updatedAt,
        work: { active: 0, completed: 0, failed: 1, total: 1 },
      }],
      thinking: [],
      unassignedActions: [],
    });
    let rejectRetry: ((reason: Error) => void) | undefined;
    vi.spyOn(api, "retryJoiMessage").mockImplementation(() => new Promise((_resolve, reject) => { rejectRetry = reject; }));

    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "继续「提交失败后仍可重试」" }));
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    expect(await screen.findByRole("status", { name: "正在提交继续请求" })).toBeInTheDocument();

    await act(async () => {
      rejectRetry?.(new ApiError("offline", "继续请求没有提交成功", 503));
      await Promise.resolve();
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("继续请求没有提交成功");
    expect(screen.queryByRole("status", { name: "正在提交继续请求" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeEnabled();
  });

  it("does not let an older polling response overwrite an optimistic retry", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-stale-retry", "防旧响应工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    const feed = {
      goals: [{
        agentCount: 0,
        workbench: { workbenchId: workbench.workbenchId, name: workbench.name },
        canDelete: true,
        goalId: "goal-stale-retry",
        status: "FAILED" as const,
        title: "防旧响应目标",
        updatedAt: workbench.updatedAt,
        work: { active: 0, completed: 0, failed: 1, total: 1 },
      }],
      thinking: [],
      unassignedActions: [],
    };
    let releaseOldPoll: (() => void) | undefined;
    vi.spyOn(api, "joiHomeFeed")
      .mockResolvedValueOnce(feed)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOldPoll = () => resolve(feed); }))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue(feed);
    vi.spyOn(api, "retryJoiMessage").mockResolvedValue({ acceptedAt: workbench.updatedAt, inputId: "goal-stale-retry", status: "PENDING" });

    const view = render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "继续「防旧响应目标」" }));
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    fireEvent.click(await screen.findByRole("button", { name: "继续" }));
    expect(await screen.findByText("正在安排")).toBeInTheDocument();
    await act(async () => { releaseOldPoll?.(); await Promise.resolve(); });
    expect(await screen.findByText("正在安排")).toBeInTheDocument();
    view.unmount();
  });

  it("binds uploaded files to one global joi input and ignores an empty submit", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    const upload = vi.spyOn(api, "uploadJoiAttachment").mockResolvedValue({
      attachmentId: "attachment-1", createdAt: "2026-07-28T10:00:00.000Z", filename: "brief.txt", mimeType: "text/plain", size: 5,
    });
    const send = vi.spyOn(api, "sendJoiMessage").mockResolvedValue({ acceptedAt: "2026-07-28T10:00:00.000Z", inputId: "input-file", status: "PENDING" });
    render(<JoiHome api={api} />);
    const composer = await screen.findByLabelText("给 joi 输入");
    fireEvent.submit(parentForm(composer));
    expect(send).not.toHaveBeenCalled();
    const fileInput = screen.getByLabelText("给 joi 添加附件");
    fireEvent.change(fileInput, { target: { files: null } });
    fireEvent.change(fileInput, { target: { files: [new File(["brief"], "brief.txt", { type: "text/plain" })] } });
    expect(screen.getByText("brief.txt")).toBeInTheDocument();
    fireEvent.change(composer, { target: { value: "按附件执行" } });
    fireEvent.submit(parentForm(composer));
    await waitFor(() => expect(upload).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith("按附件执行", { attachmentIds: ["attachment-1"] });
  });

  it("accepts attachments through drag-and-drop and paste and sends them with the message", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    let uploadCount = 0;
    const upload = vi.spyOn(api, "uploadJoiAttachment").mockImplementation((file) => {
      uploadCount += 1;
      return Promise.resolve({ attachmentId: `attachment-${String(uploadCount)}`, createdAt: "2026-07-28T10:00:00.000Z", filename: file.name, mimeType: file.type, size: file.size });
    });
    const send = vi.spyOn(api, "sendJoiMessage").mockResolvedValue({ acceptedAt: "2026-07-28T10:00:00.000Z", inputId: "input-drop", status: "PENDING" });
    render(<JoiHome api={api} />);
    const composer = await screen.findByLabelText("给 joi 输入");
    const form = parentForm(composer);

    fireEvent.drop(form, { dataTransfer: { files: [new File(["dropped"], "dropped.md", { type: "text/markdown" })] } });
    expect(screen.getByText("dropped.md")).toBeInTheDocument();
    fireEvent.drop(form, { dataTransfer: { files: [new File(["dropped"], "dropped.md", { type: "text/markdown" })] } });
    expect(screen.getByText("dropped.md")).toBeInTheDocument();
    expect(screen.queryByText("dropped.md、dropped.md")).not.toBeInTheDocument();

    fireEvent.paste(composer, { clipboardData: { files: [new File(["pixels"], "shot.png", { type: "image/png" })] } });
    expect(screen.getByText("dropped.md、shot.png")).toBeInTheDocument();

    fireEvent.change(composer, { target: { value: "按拖拽附件执行" } });
    fireEvent.submit(form);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledWith("按拖拽附件执行", { attachmentIds: ["attachment-1", "attachment-2"] });
  });

  it("rejects oversized files and enforces the 8-file cap with visible notices", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    render(<JoiHome api={api} />);
    const composer = await screen.findByLabelText("给 joi 输入");
    const form = parentForm(composer);

    const oversized = new File(["x"], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(oversized, "size", { value: 11 * 1024 * 1024 });
    fireEvent.drop(form, { dataTransfer: { files: [oversized] } });
    expect(screen.getByRole("alert").textContent).toContain("超过 10 MiB");
    expect(screen.queryByText("huge.bin")).not.toBeInTheDocument();

    const many = Array.from({ length: 9 }, (_, index) => new File([`f${String(index)}`], `file-${String(index)}.txt`, { type: "text/plain" }));
    fireEvent.drop(form, { dataTransfer: { files: many } });
    expect(screen.getByRole("alert").textContent).toContain("最多只能添加 8 个附件");
    expect(screen.getByText(/file-0\.txt/u)).toBeInTheDocument();
    expect(screen.queryByText(/file-8\.txt/u)).not.toBeInTheDocument();
  });

  it("nudges the home page to build two or three partners when the roster is thin", async () => {
    const api = new DigitalLifeApi("");
    const thin = snapshot([readySource]);
    thin.partners = [{
      capabilities: [], createdBy: "user", displayName: "Solo", engine: "pi-core", inFlightCount: 0, kind: "local-pi",
      knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner-solo", partnerRevisionId: "revision-solo",
      registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
    }];
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(thin);
    render(<JoiHome api={api} />);
    expect(await screen.findByText(/场景预设一键组建团队/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "看场景预设" })).toBeInTheDocument();
  });

  it("hides the partner nudge once at least two partners exist", async () => {
    const api = new DigitalLifeApi("");
    const enough = snapshot([readySource]);
    const one: PartnerDto = {
      capabilities: [], createdBy: "user", displayName: "Solo", engine: "pi-core", inFlightCount: 0, kind: "local-pi",
      knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner-solo", partnerRevisionId: "revision-solo",
      registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
    };
    enough.partners = [one, { ...one, displayName: "Duo", partnerId: "partner-duo", partnerRevisionId: "revision-duo" }];
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(enough);
    render(<JoiHome api={api} />);
    expect(await screen.findByLabelText("给 joi 输入")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "看场景预设" })).not.toBeInTheDocument();
  });

  it("shows an actionable clarification message keyed by the reason code", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "clarify-1", status: "CLARIFICATION_REQUIRED" },
      { acceptedAt: "2026-08-01T00:00:01.000Z", clarificationReasonCode: "workbench_creation_unavailable", inputId: "clarify-2", status: "CLARIFICATION_REQUIRED" },
      { acceptedAt: "2026-08-01T00:00:02.000Z", clarificationReasonCode: "workbench_not_found", inputId: "clarify-3", status: "CLARIFICATION_REQUIRED" },
      { acceptedAt: "2026-08-01T00:00:03.000Z", clarificationPrompt: "搭档配置暂不可用，请先检查设置。", clarificationReasonCode: "work_dispatch_failed", inputId: "clarify-4", status: "CLARIFICATION_REQUIRED" },
    ] });
    render(<JoiHome api={api} />);
    expect(await screen.findByText(/没法定位这条输入属于哪个上下文/u)).toBeInTheDocument();
    expect(screen.getByText(/想新建一个工作台来承接/u)).toBeInTheDocument();
    expect(screen.getByText(/指向的工作台已不存在/u)).toBeInTheDocument();
    expect(screen.getByText("搭档配置暂不可用，请先检查设置。")).toBeInTheDocument();
  });

  it("keeps a large workbench choice list bounded and searchable", async () => {
    const api = new DigitalLifeApi("");
    const workbenches = Array.from({ length: 20 }, (_, index) => workbenchDto(`workbench-${String(index)}`, `工作台 ${String(index)}`));
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches });
    vi.spyOn(api, "joiHomeFeed").mockResolvedValue({ goals: [], thinking: [], unassignedActions: [{
      acceptedAt: "2026-08-01T00:00:00.000Z",
      clarificationReasonCode: "workbench_selection_invalid",
      inputId: "large-workbench-choice",
      status: "CLARIFICATION_REQUIRED",
    }] });
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({
      acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "large-workbench-choice", status: "PENDING",
    });

    render(<JoiHome api={api} />);

    const search = await screen.findByLabelText("搜索工作台");
    const list = screen.getByRole("group", { name: "选择一个工作台继续" });
    expect(list).toHaveClass("joi-clarify-workbench-list");
    expect(within(list).getAllByRole("button")).toHaveLength(20);
    fireEvent.change(search, { target: { value: "工作台 17" } });
    expect(screen.getByRole("button", { name: /工作台 17/u })).toBeInTheDocument();
    expect(within(list).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /工作台 17/u }));
    await waitFor(() => expect(clarify).toHaveBeenCalledWith("large-workbench-choice", { workbenchId: "workbench-17" }));
  });

  it("does not ask the user to assert completion for an unrecoverable historical review", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [{
      acceptedAt: "2026-08-01T00:00:00.000Z",
      clarificationPrompt: "历史评审记录无法安全恢复。",
      clarificationReasonCode: "harness_review_unrecoverable",
      inputId: "history-review-1",
      status: "CLARIFICATION_REQUIRED",
    }] });

    render(<JoiHome api={api} />);
    expect(await screen.findByText("已交给 joi 自动校正")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认完成并收官" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("补充信息")).not.toBeInTheDocument();
  });

  it("offers available partner cards and resumes with a stable partner id without free text", async () => {
    const api = new DigitalLifeApi("");
    const ready: PartnerDto = {
      capabilities: ["code"], createdBy: "user", description: "适合代码分析", displayName: "代码搭档", engine: "pi-core",
      inFlightCount: 0, kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner-ready",
      partnerRevisionId: "revision-ready", registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
    };
    const blocked: PartnerDto = {
      ...ready, configuration: { reasonCodes: ["skill_missing"], status: "ACTION_REQUIRED" }, displayName: "待修复搭档",
      partnerId: "partner-blocked", partnerRevisionId: "revision-blocked",
    };
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), partners: [ready, blocked] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [{
      acceptedAt: "2026-08-01T00:00:00.000Z", clarificationPrompt: "选择一个搭档继续原任务。",
      clarificationReasonCode: "partner_selection_required", inputId: "partner-choice", status: "CLARIFICATION_REQUIRED",
    }] });
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({
      acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "partner-choice", status: "PENDING",
    });

    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /代码搭档/u }));

    expect(clarify).toHaveBeenCalledWith("partner-choice", { partnerId: "partner-ready" });
    expect(screen.queryByRole("button", { name: /待修复搭档/u })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("补充信息")).not.toBeInTheDocument();
  });

  it("offers one-click recovery for a waiting Work whose original question linkage was lost", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [{
      acceptedAt: "2026-08-01T00:00:00.000Z",
      clarificationPrompt: "检测到一项等待中的原工作。",
      clarificationReasonCode: "partner_waiting_recovery_required",
      inputId: "waiting-recovery",
      status: "CLARIFICATION_REQUIRED",
      workbenchId: "workbench-recovery",
    }] });
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({
      acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "waiting-recovery", status: "PENDING",
    });

    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "继续原工作" }));

    expect(clarify).toHaveBeenCalledWith("waiting-recovery", { actionChoice: "RESUME" });
    expect(screen.queryByLabelText("补充信息")).not.toBeInTheDocument();
  });

  it("shows authorization repair as an explicit one-click recovery instead of a blank input", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [{
      acceptedAt: "2026-08-01T00:00:00.000Z",
      clarificationReasonCode: "partner_auth_required",
      inputId: "waiting-auth",
      status: "CLARIFICATION_REQUIRED",
      workbenchId: "workbench-auth",
    }] });
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({
      acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "waiting-auth", status: "PENDING",
    });

    render(<JoiHome api={api} />);
    expect(await screen.findByText(/需要重新授权/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续原工作" }));

    expect(clarify).toHaveBeenCalledWith("waiting-auth", { actionChoice: "RESUME" });
    expect(screen.queryByLabelText("补充信息")).not.toBeInTheDocument();
  });

  it("shows partner kind hints when descriptions are absent", async () => {
    const api = new DigitalLifeApi("");
    const local: PartnerDto = {
      capabilities: [], createdBy: "user", displayName: "本地搭档", engine: "pi-core", inFlightCount: 0,
      kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner-local",
      partnerRevisionId: "revision-local", registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
    };
    const remote: PartnerDto = {
      ...local, displayName: "远程搭档", kind: "a2a", partnerId: "partner-remote", partnerRevisionId: "revision-remote",
    };
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), partners: [local, remote] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [{
      acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "partner_selection_required",
      inputId: "partner-kind-hints", status: "CLARIFICATION_REQUIRED",
    }] });

    render(<JoiHome api={api} />);

    expect(await screen.findByText("本地搭档", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("远程搭档", { selector: "span" })).toBeInTheDocument();
  });

  it("explains how to recover when no partner can be selected", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), partners: [] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [{
      acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "partner_selection_required",
      inputId: "no-partner-choice", status: "CLARIFICATION_REQUIRED",
    }] });

    render(<JoiHome api={api} />);

    expect(await screen.findByText("当前没有可用搭档。请先到「搭档」页修复或创建搭档。")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "选择一个搭档继续任务" })).not.toBeInTheDocument();
  });

  it("offers scenario and partner-page exits from the thin-roster nudge", async () => {
    const api = new DigitalLifeApi("");
    const thin = snapshot([readySource]);
    thin.partners = [];
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(thin);
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    const nav = vi.fn();
    render(<JoiHome api={api} onNavigate={nav} />);
    fireEvent.click(await screen.findByRole("button", { name: "看场景预设" }));
    expect(nav).toHaveBeenCalledWith("agents", "scenarios");
    fireEvent.click(screen.getByRole("button", { name: "去搭档页创建" }));
    expect(nav).toHaveBeenCalledWith("agents", "partners");
  });

  it("removes a clarification card immediately after supplemental information succeeds", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbenchDto("workbench-1", "前端搭档")] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "clarify-x", status: "CLARIFICATION_REQUIRED" },
    ] });
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "clarify-x", status: "PENDING" });
    render(<JoiHome api={api} />);
    const reason = await screen.findByText(/没法定位这条输入属于哪个上下文/u);
    fireEvent.change(await screen.findByLabelText("补充信息"), { target: { value: "其实是登录模块" } });
    fireEvent.click(screen.getByRole("button", { name: "补充并继续" }));
    await waitFor(() => expect(clarify).toHaveBeenCalledWith("clarify-x", { text: "其实是登录模块" }));
    await waitFor(() => expect(reason).not.toBeInTheDocument());
  });

  it("shows joi workbench proposals instead of a manual creation form", async () => {
    const api = new DigitalLifeApi("");
    const existing = workbenchDto("workbench-existing", "已有工程");
    const created = workbenchDto("workbench-proposal", "AI 应用开发工作台");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [existing] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "proposal-1", status: "CLARIFICATION_REQUIRED", textPreview: "使用 Claude Code 开发 AI 应用并排查 monitor 问题" },
    ] });
    const create = vi.spyOn(api, "createWorkbench").mockResolvedValue(created);
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "proposal-1", status: "PENDING" });
    render(<JoiHome api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "新增工作台" }));
    expect(await screen.findByText("joi 建议了几个工作台方案")).toBeInTheDocument();
    expect(screen.queryByLabelText("工作台名称")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /AI 应用开发工作台/u }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "AI 应用开发工作台" })));
    await waitFor(() => expect(clarify).toHaveBeenCalledWith("proposal-1", { workbenchId: "workbench-proposal" }));
  });

  it("creates a new workbench from the clarification card and resumes the same input", async () => {
    const api = new DigitalLifeApi("");
    const existing = workbenchDto("workbench-existing", "已有工程");
    const created = workbenchDto("workbench-new", "新工作台");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [existing] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "create-workbench-1", status: "CLARIFICATION_REQUIRED" },
    ] });
    const create = vi.spyOn(api, "createWorkbench").mockResolvedValue(created);
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "create-workbench-1", status: "PENDING" });
    render(<JoiHome api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "新增工作台" }));
    expect(screen.queryByLabelText("工作台名称")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /AI 应用开发工作台/u }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      name: "AI 应用开发工作台",
      personaSummary: "关注 SDK/API 集成、应用开发和可验证交付，保持工程上下文连续。",
      projectLabel: "AI 应用开发",
      scopeSummary: "Claude Code、SDK、API 集成、应用开发与调试。",
    }));
    await waitFor(() => expect(clarify).toHaveBeenCalledWith("create-workbench-1", { workbenchId: "workbench-new" }));
    expect(clarify).not.toHaveBeenCalledWith("create-workbench-1", { text: "新增工作台" });
  });

  it("reuses a newly created workbench when the first clarification request fails", async () => {
    const api = new DigitalLifeApi("");
    const existing = workbenchDto("workbench-existing", "已有工程");
    const created = workbenchDto("workbench-new-retry", "新工作台");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [existing] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "create-workbench-retry", status: "CLARIFICATION_REQUIRED" },
    ] });
    const create = vi.spyOn(api, "createWorkbench").mockResolvedValue(created);
    const clarify = vi.spyOn(api, "clarifyJoiMessage")
      .mockRejectedValueOnce(new ApiError("offline", "暂时无法继续，请重试", 503))
      .mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "create-workbench-retry", status: "PENDING" });
    render(<JoiHome api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "新增工作台" }));
    fireEvent.click(screen.getByRole("button", { name: /当前任务 工作台/u }));

    expect(await screen.findByText("暂时无法继续，请重试")).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "新工作台" }));
    await waitFor(() => expect(clarify).toHaveBeenLastCalledWith("create-workbench-retry", { workbenchId: "workbench-new-retry" }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("uses a safe generic error when selecting a workbench cannot be submitted", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-submit-failure", "已有工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "submit-failure", status: "CLARIFICATION_REQUIRED" },
    ] });
    vi.spyOn(api, "clarifyJoiMessage").mockRejectedValue(new Error("offline"));
    render(<JoiHome api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "已有工程" }));
    expect(await screen.findByText("没能交给 joi，请重试。")).toBeInTheDocument();
  });

  it("keeps the joi proposals available until the user cancels them", async () => {
    const api = new DigitalLifeApi("");
    const workbench = workbenchDto("workbench-incomplete", "已有工程");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbench] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "create-workbench-incomplete", status: "CLARIFICATION_REQUIRED" },
    ] });
    render(<JoiHome api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "新增工作台" }));
    expect(await screen.findByText("joi 建议了几个工作台方案")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText("joi 建议了几个工作台方案")).not.toBeInTheDocument();
  });

  it("surfaces a clarification failure inline at the card", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbenchDto("workbench-1", "前端搭档")] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_not_found", inputId: "clarify-y", status: "CLARIFICATION_REQUIRED" },
    ] });
    vi.spyOn(api, "clarifyJoiMessage").mockRejectedValue(new ApiError("gone", "这条已经处理过了", 400));
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "前端搭档" }));
    expect(await screen.findByText("这条已经处理过了")).toBeInTheDocument();
  });

  it("renders a persisted joi question and sends the answer back to the same input", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [{
      acceptedAt: "2026-08-01T00:00:00.000Z", clarificationPrompt: "验收需要覆盖哪些浏览器？",
      clarificationReasonCode: "question_required", inputId: "question-1", status: "CLARIFICATION_REQUIRED",
    }] });
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "question-1", status: "PENDING" });
    render(<JoiHome api={api} />);

    expect(await screen.findByText("验收需要覆盖哪些浏览器？")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("你的回答"), { target: { value: "Chrome 和 Edge" } });
    fireEvent.click(screen.getByRole("button", { name: "回答并继续" }));
    await waitFor(() => expect(clarify).toHaveBeenCalledWith("question-1", { text: "Chrome 和 Edge" }));
  });

  it("binds a workspace from its clarification card and resumes the same input", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbenchDto("workbench-work", "发布工程")] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [{
      acceptedAt: "2026-08-01T00:00:00.000Z", workbenchId: "workbench-work", clarificationReasonCode: "workbench_workspace_not_ready",
      inputId: "workspace-1", status: "CLARIFICATION_REQUIRED",
    }] });
    const bind = vi.spyOn(api, "bindWorkbenchWorkspace").mockResolvedValue({ displayName: "release", kind: "BOUND", status: "READY" });
    const clarify = vi.spyOn(api, "clarifyJoiMessage").mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", workbenchId: "workbench-work", inputId: "workspace-1", status: "PENDING" });
    render(<JoiHome api={api} />);

    expect(await screen.findByText("joi 需要你确认")).toBeInTheDocument();
    expect(bind).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "选择工作目录" }));
    await waitFor(() => expect(bind).toHaveBeenCalledWith("workbench-work"));
    expect(clarify).toHaveBeenCalledWith("workspace-1", { workbenchId: "workbench-work" });
  });

  it("removes an unassigned clarification from the minimal home after cancellation succeeds", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({ ...snapshot([readySource]), workbenches: [workbenchDto("workbench-1", "前端搭档")] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages")
      .mockResolvedValueOnce({ items: [
        { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_selection_invalid", inputId: "cancel-1", status: "CLARIFICATION_REQUIRED" },
      ] })
      .mockResolvedValue({ items: [
        { acceptedAt: "2026-08-01T00:00:00.000Z", canceled: true, inputId: "cancel-1", status: "CONSUMED" },
      ] });
    const cancel = vi.spyOn(api, "cancelJoiMessage").mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", canceled: true, inputId: "cancel-1", status: "CONSUMED" });
    render(<JoiHome api={api} />);
    const cancelButton = await screen.findByRole("button", { name: "取消这条任务" });
    fireEvent.click(cancelButton);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("cancel-1"));
    await waitFor(() => expect(screen.queryByText(/没法定位这条输入属于哪个上下文/u)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "取消这条任务" })).not.toBeInTheDocument();
  });

  it("offers a persistent remove button only on finished or canceled cards", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:04.000Z", inputId: "done-1", status: "CONSUMED" },
      { acceptedAt: "2026-08-01T00:00:01.000Z", canceled: true, inputId: "canceled-1", status: "CONSUMED" },
      { acceptedAt: "2026-08-01T00:00:02.000Z", inputId: "live-1", status: "PENDING" },
      { acceptedAt: "2026-08-01T00:00:03.000Z", clarificationReasonCode: "question_required", inputId: "clarify-1", status: "CLARIFICATION_REQUIRED" },
    ] });
    const dismiss = vi.spyOn(api, "dismissJoiMessage").mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "done-1", status: "CONSUMED" });
    render(<JoiHome api={api} />);
    const buttons = await screen.findAllByRole("button", { name: "移除这条卡片" });
    expect(buttons).toHaveLength(2);
    const firstDismiss = buttons[0];
    if (firstDismiss === undefined) throw new Error("expected a dismiss button");
    fireEvent.click(firstDismiss);
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith("done-1"));
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "移除这条卡片" })).toHaveLength(1));
  });

  it("surfaces a dismiss failure inline at the card", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "done-2", status: "CONSUMED" },
    ] });
    vi.spyOn(api, "dismissJoiMessage").mockRejectedValue(new ApiError("gone", "这条还在处理中", 400));
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "移除这条卡片" }));
    expect(await screen.findByText("这条还在处理中")).toBeInTheDocument();
  });

  it("surfaces a cancel failure inline at the card", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-08-01T00:00:00.000Z", clarificationReasonCode: "workbench_not_found", inputId: "cancel-2", status: "CLARIFICATION_REQUIRED" },
    ] });
    vi.spyOn(api, "cancelJoiMessage").mockRejectedValue(new ApiError("gone", "这条已经处理过了", 400));
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "取消这条任务" }));
    expect(await screen.findByText("这条已经处理过了")).toBeInTheDocument();
  });

  it("shows the validation reason, last-validated time and raw error on a degraded source card", async () => {
    const api = new DigitalLifeApi("");
    const degraded: ModelSourceDto = {
      ...readySource,
      displayName: "百炼 Token Plan",
      lastError: "400 {\"error\":{\"message\":\"bad model id\"}}",
      lastValidatedAt: "2026-08-02T14:59:30.000Z",
      reasonCode: "connection_error",
      sourceId: "source-degraded",
      status: "DEGRADED",
    };
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [readySource, degraded] });
    render(<ModelSourceManager api={api} />);
    expect(await screen.findByText(/无法连通所选接口/u)).toBeInTheDocument();
    expect(screen.getByText(/上次验证：/u)).toBeInTheDocument();
    expect(screen.getByText("查看原始报错")).toBeInTheDocument();
    expect(screen.getByText(/bad model id/u)).toBeInTheDocument();
  });

  it("renders a distinct reason sentence for each validation reason code", async () => {
    const api = new DigitalLifeApi("");
    const cases: [ModelSourceDto["status"], string, string][] = [
      ["NEEDS_AUTH", "auth_failed", "没有访问权限"],
      ["DEGRADED", "rate_limited", "接口限流或超载"],
      ["DEGRADED", "model_unavailable", "找不到这个 Model ID"],
      ["DEGRADED", "server_error", "服务端错误"],
      ["DEGRADED", "not_found", "资源不存在"],
      ["DEGRADED", "bad_request", "拒绝了请求参数"],
      ["DEGRADED", "connection_error", "无法连通所选接口"],
      ["DEGRADED", "timeout", "连接所选接口超时"],
      ["DEGRADED", "http_error", "可展开查看原始报错"],
      ["DEGRADED", "endpoint_unreachable", "joi 无法访问所选接口"],
    ];
    const items = cases.map((entry, index) => ({
      ...readySource, displayName: `源 ${String(index)}`, reasonCode: entry[1], sourceId: `source-r-${String(index)}`, status: entry[0],
    }));
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items });
    render(<ModelSourceManager api={api} />);
    for (const entry of cases) {
      expect(await screen.findByText(new RegExp(entry[2]))).toBeInTheDocument();
    }
  });
});
