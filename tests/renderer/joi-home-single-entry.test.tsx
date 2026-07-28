// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";
import { JoiHome, ModelSourceManager, PartnerManager } from "../../src/renderer/JoiHome.js";
import type { JoiSnapshotDto, ModelSourceDto } from "../../src/shared/joi.js";

const readySource: ModelSourceDto = {
  activeModel: { capability: "release-tested", id: "deepseek-chat", revisionId: "model-1" },
  activeSourceRevisionId: "source-revision-1",
  credential: { configured: true, version: 1 },
  displayName: "DeepSeek",
  kind: "deepseek",
  order: 0,
  primary: true,
  sourceId: "source-1",
  status: "READY",
};

function snapshot(modelSources: ModelSourceDto[]): JoiSnapshotDto {
  const configured = modelSources.some((source) => source.status === "READY");
  return { avatars: [], modelSources, partners: [], runtime: { configured, status: configured ? "READY" : "NOT_CONFIGURED" }, work: [] };
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

  it("saves and validates a direct source before opening the composer", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "joiSnapshot").mockResolvedValueOnce(snapshot([])).mockResolvedValue(snapshot([readySource]));
    const create = vi.spyOn(api, "createModelSource").mockResolvedValue({ ...readySource, status: "DRAFT" });
    vi.spyOn(api, "validateModelSource").mockResolvedValue(readySource);
    render(<JoiHome api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "连接 Kimi" }));
    fireEvent.change(screen.getByLabelText("Model ID（可选，高级设置）"), { target: { value: "kimi-custom" } });
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key" } });
    fireEvent.submit(parentForm(screen.getByLabelText("API Key")));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ apiKey: "test-key", kind: "kimi", modelId: "kimi-custom" }));
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
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "本机" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://127.0.0.1:11434/v1" } });
    fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "local-model" } });
    fireEvent.submit(parentForm(screen.getByLabelText("API Key（本机 localhost 可留空）")));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", displayName: "本机", kind: "generic-openai", modelId: "local-model" }));
    expect(await screen.findByText(/还没有通过检查/)).toBeInTheDocument();
  });

  it("manages redacted source ordering, validation, disable and deletion", async () => {
    const api = new DigitalLifeApi("");
    const backup = { ...readySource, activeModel: { ...readySource.activeModel, id: "kimi-k2.5" }, baseUrl: "https://api.moonshot.cn/v1", displayName: "Kimi", kind: "kimi" as const, order: 1, primary: false, sourceId: "source-2" };
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [readySource, backup] });
    const order = vi.spyOn(api, "orderModelSources").mockResolvedValue({ items: [{ ...backup, order: 0, primary: true }, { ...readySource, order: 1, primary: false }] });
    const validate = vi.spyOn(api, "validateModelSource").mockResolvedValueOnce(readySource).mockRejectedValueOnce(new Error("offline"));
    const update = vi.spyOn(api, "updateModelSource").mockResolvedValue({ ...readySource, status: "DISABLED" });
    const remove = vi.spyOn(api, "deleteModelSource").mockResolvedValue(undefined);
    render(<ModelSourceManager api={api} />);
    expect(await screen.findByText("DeepSeek")).toBeInTheDocument();
    const kimi = screen.getByText("Kimi").closest("article");
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

  it("manages local Pi partners through the unified redacted registry", async () => {
    const api = new DigitalLifeApi("");
    const partner = { capabilities: ["code"], displayName: "Local Coder", kind: "local-pi" as const, partnerId: "partner-1", partnerRevisionId: "revision-1", registryRevision: 1, skills: ["typescript"], status: "ACTIVE" as const, tools: ["read", "edit"] };
    const disabled = { ...partner, capabilities: [], skills: [], status: "DISABLED" as const, tools: [] };
    vi.spyOn(api, "listPartners").mockResolvedValueOnce({ items: [partner] }).mockResolvedValue({ items: [disabled] });
    const create = vi.spyOn(api, "createPartner").mockResolvedValue(partner);
    const disable = vi.spyOn(api, "disablePartner").mockResolvedValue(disabled);
    render(<PartnerManager api={api} />);
    expect(await screen.findByText("Local Coder")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    await waitFor(() => expect(disable).toHaveBeenCalledWith("partner-1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "停用" })).not.toBeInTheDocument());
    expect(screen.getByText("尚未声明能力")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加搭档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Writer" } });
    fireEvent.change(screen.getByLabelText("能力标签（逗号分隔）"), { target: { value: "code, review" } });
    fireEvent.change(screen.getByLabelText("Skills（逗号分隔）"), { target: { value: "typescript" } });
    fireEvent.change(screen.getByLabelText("工具 allowlist（逗号分隔）"), { target: { value: "read, edit" } });
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "D:\\work\\writer" } });
    fireEvent.change(screen.getByLabelText("搭档提示词"), { target: { value: "只修改任务范围内的文件" } });
    fireEvent.submit(parentForm(screen.getByLabelText("名称")));
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      capabilities: ["code", "review"], displayName: "Writer", kind: "local-pi", prompt: "只修改任务范围内的文件",
      skills: ["typescript"], tools: ["read", "edit"], workspaceRef: "D:\\work\\writer",
    }));
  });

  it("onboards remote A2A partners through the existing card and bearer path", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "listPartners").mockResolvedValue({ items: [] });
    const addAgent = vi.spyOn(api, "addAgent").mockResolvedValue({
      agentConnectionId: "agent-remote", credentialVersion: 1, name: "Remote Researcher", readiness: true,
      skills: ["research"], status: "ACTIVE", updatedAt: "2026-07-28T10:00:00.000Z",
    });
    render(<PartnerManager api={api} />);
    expect(await screen.findByRole("heading", { name: "还没有搭档" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加搭档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Remote Researcher" } });
    fireEvent.change(screen.getByLabelText("类型"), { target: { value: "a2a" } });
    fireEvent.change(screen.getByLabelText("远端 Agent Card URL"), { target: { value: "https://agent.test/card.json" } });
    fireEvent.change(screen.getByLabelText("远端 Bearer Token"), { target: { value: "secret" } });
    fireEvent.submit(parentForm(screen.getByLabelText("名称")));
    await waitFor(() => expect(addAgent).toHaveBeenCalledWith("https://agent.test/card.json", "secret"));
    expect(await screen.findByText(/搭档列表已先更新/)).toBeInTheDocument();
  });

  it("keeps an unavailable Partner registry explicit and empty", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "listPartners").mockRejectedValue(new Error("offline"));
    render(<PartnerManager api={api} />);
    expect(await screen.findByText("没能读取统一搭档列表。")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "还没有搭档" })).toBeInTheDocument();
  });
});
