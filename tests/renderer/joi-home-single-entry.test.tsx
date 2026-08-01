// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";
import { JoiHome, ModelSourceManager } from "../../src/renderer/JoiHome.js";
import type { JoiSnapshotDto, ModelSourceDto, PartnerDto } from "../../src/shared/joi.js";

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
  return { avatarChanges: [], avatars: [], modelSources, partners: [], runtime: { configured, status: configured ? "READY" : "NOT_CONFIGURED" }, work: [] };
}

function parentForm(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Expected a parent form.");
  return form;
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
    const send = vi.spyOn(api, "sendJoiMessage")
      .mockResolvedValueOnce({ acceptedAt: "2026-07-28T10:00:00.000Z", inputId: "input-1", status: "PENDING" })
      .mockResolvedValueOnce({ acceptedAt: "2026-07-28T10:00:01.000Z", inputId: "input-2", status: "PENDING" });
    render(<JoiHome api={api} />);
    const composer = await screen.findByLabelText("给 joi 输入");
    fireEvent.change(composer, { target: { value: "先研究方案" } });
    fireEvent.submit(parentForm(composer));
    await waitFor(() => expect(send).toHaveBeenCalledWith("先研究方案"));
    fireEvent.change(composer, { target: { value: "同时整理风险" } });
    fireEvent.submit(parentForm(composer));
    await waitFor(() => expect(send).toHaveBeenCalledWith("同时整理风险"));
    expect(await screen.findAllByText("输入已保存")).toHaveLength(2);
  });

  it("shows Joi-proposed Avatar changes and requires an explicit user decision", async () => {
    const api = new DigitalLifeApi("");
    const pending = {
      createdAt: "2026-07-28T10:00:00.000Z", kind: "MERGE" as const, reason: "同一工程上下文",
      requestId: "change-1", sourceAvatarId: "avatar-old", status: "PENDING" as const, targetAvatarId: "avatar-current",
    };
    vi.spyOn(api, "joiSnapshot")
      .mockResolvedValueOnce({ ...snapshot([readySource]), avatarChanges: [pending] })
      .mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    const decide = vi.spyOn(api, "decideAvatarChange").mockResolvedValue({ ...pending, status: "CONFIRMED" });
    render(<JoiHome api={api} />);
    expect(await screen.findByText("joi 建议合并 Avatar")).toBeInTheDocument();
    expect(screen.getByText("同一工程上下文")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认合并" }));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("change-1", "CONFIRM"));
    await waitFor(() => expect(screen.queryByText("joi 建议合并 Avatar")).not.toBeInTheDocument());
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

  it("renders persisted message stages, active work and all activity kinds without message bodies", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue({
      ...snapshot([readySource]),
      work: [{ avatarId: "avatar-1", status: "RUNNING", title: "整理迁移", workId: "work-1" }],
    });
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [
      { acceptedAt: "2026-07-28T10:00:00.000Z", inputId: "pending", status: "PENDING" },
      { acceptedAt: "2026-07-28T10:00:01.000Z", inputId: "routed", status: "ROUTED" },
      { acceptedAt: "2026-07-28T10:00:02.000Z", inputId: "consumed", status: "CONSUMED" },
      { acceptedAt: "2026-07-28T10:00:03.000Z", inputId: "clarify", status: "CLARIFICATION_REQUIRED" },
    ] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [
      { activityId: "message", kind: "MESSAGE", occurredAt: "2026-07-28T10:00:00.000Z", status: "PENDING" },
      { activityId: "turn", kind: "TURN", occurredAt: "2026-07-28T10:00:01.000Z", status: "RUNNING" },
      { activityId: "work", kind: "WORK", occurredAt: "2026-07-28T10:00:02.000Z", status: "RUNNING", workId: "work-1" },
      { activityId: "result", kind: "PARTNER_RESULT", occurredAt: "2026-07-28T10:00:03.000Z", status: "COMPLETED", workId: "work-1" },
    ] });

    render(<JoiHome api={api} />);
    expect(await screen.findByText("整理迁移")).toBeInTheDocument();
    expect(await screen.findByText("输入已保存")).toBeInTheDocument();
    for (const stage of ["joi 已归类", "工作已安排", "需要你确认"]) expect(screen.getByText(stage)).toBeInTheDocument();
    for (const label of ["输入状态", "joi 正在思考", "工作状态", "搭档结果"]) expect(screen.getByText(label)).toBeInTheDocument();
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
    expect(send).toHaveBeenCalledWith("按附件执行", ["attachment-1"]);
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
    expect(await screen.findByText(/建立 2-3 个工作搭档/u)).toBeInTheDocument();
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
    expect(screen.queryByText(/建立 2-3 个工作搭档/u)).not.toBeInTheDocument();
  });

  it("prefills the composer from a scenario preset without auto-sending", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValue(snapshot([readySource]));
    vi.spyOn(api, "listJoiMessages").mockResolvedValue({ items: [] });
    vi.spyOn(api, "listJoiActivity").mockResolvedValue({ items: [] });
    vi.spyOn(api, "scenarios").mockResolvedValue({ items: [
      { blurb: "先把它说清楚", id: "plan-big-goal", prompt: "规划提示词正文", source: "builtin", title: "规划一个大目标" },
      { blurb: "本机技能起点", id: "skill:claude-code/demo", prompt: "技能提示词正文", source: "skill", title: "演示技能" },
    ] });
    const send = vi.spyOn(api, "sendJoiMessage").mockResolvedValue({ acceptedAt: "2026-08-01T00:00:00.000Z", inputId: "input-x", status: "PENDING" });
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /规划一个大目标/u }));
    const composer = await screen.findByLabelText("给 joi 输入");
    await waitFor(() => expect(composer).toHaveValue("规划提示词正文"));
    expect(screen.getByText("来自本机技能")).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });
});
