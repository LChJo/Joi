// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";
import { PartnerPage } from "../../src/renderer/PartnerPage.js";
import type { PartnerDto, ScenarioPackDto } from "../../src/shared/joi.js";

const coder: PartnerDto = {
  capabilities: ["code"], createdBy: "user", description: "写代码的搭档", displayName: "Local Coder",
  engine: "pi-core", inFlightCount: 0, kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN",
  partnerId: "partner-1", partnerRevisionId: "revision-1", registryRevision: 1, skills: ["typescript"],
  status: "ACTIVE", tools: ["read"],
};

function mockCatalog(api: DigitalLifeApi, partners: PartnerDto[]) {
  vi.spyOn(api, "listPartners").mockResolvedValue({ items: partners });
  vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [] });
  vi.spyOn(api, "engineCatalog").mockResolvedValue({ items: [
    { available: true, id: "pi-core", tools: ["read", "edit"] },
    { available: true, id: "claude-code", tools: ["Bash", "Read"] },
    { available: true, id: "codex", tools: ["shell", "apply_patch"] },
  ] });
  vi.spyOn(api, "engineSkills").mockResolvedValue({ items: [] });
}

describe("partner page", () => {
  it("renders partner cards with description, engine badge and a badge for joi-created partners", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder, { ...coder, createdBy: "joi", description: "joi 自己登记的搭档", displayName: "Joi Made", partnerId: "partner-2", partnerRevisionId: "revision-2" }, { ...coder, description: "带知识库的搭档", displayName: "Doced", knowledgeDocCount: 2, partnerId: "partner-3", partnerRevisionId: "revision-3" }]);
    render(<PartnerPage api={api} />);
    expect(await screen.findByText("Local Coder")).toBeInTheDocument();
    expect(screen.getByText("写代码的搭档")).toBeInTheDocument();
    expect(screen.getByText("joi 创建")).toBeInTheDocument();
    expect(screen.getByText(/2 篇知识库/u)).toBeInTheDocument();
    expect(screen.getAllByText("本机 · Pi core")).toHaveLength(3);
  });

  it("surfaces legacy Skill refs before dispatch and blocks saving until they are removed", async () => {
    const api = new DigitalLifeApi("");
    const legacy = {
      ...coder,
      configuration: { reasonCodes: ["partner_skill_ref_invalid"], status: "ACTION_REQUIRED" as const },
      partnerId: "partner-legacy",
      partnerRevisionId: "revision-legacy",
      skills: ["技能调试"],
    };
    mockCatalog(api, [legacy]);
    vi.spyOn(api, "engineSkills").mockResolvedValue({ items: [{ displayName: "有效技能", id: "agents/valid" }] });
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue({ ...legacy, skills: [] });
    render(<PartnerPage api={api} />);
    expect(await screen.findByText("有技能引用已失效，请重新选择本机已安装的技能。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    const save = await screen.findByRole("button", { name: "保存修改" });
    expect(await screen.findByText("有效技能")).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "技能调试 ×" }));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-legacy", expect.objectContaining({ skills: [] })));
  });

  it("maps every safe configuration reason to a repair instruction", async () => {
    const api = new DigitalLifeApi("");
    const reasons = [
      ["partner_skill_requires_read", "Pi core 挂载 Skill 时必须启用 read 工具。"],
      ["partner_skill_collision", "选中的技能名称发生冲突，请只保留一个来源。"],
      ["partner_skill_environment_invalid", "技能的环境声明无效，请重新选择有效版本。"],
      ["partner_configuration_invalid", "搭档配置需要修复后才能派发。"],
    ] as const;
    mockCatalog(api, reasons.map(([reasonCode], index) => ({
      ...coder,
      configuration: { reasonCodes: [reasonCode], status: "ACTION_REQUIRED" as const },
      displayName: `Needs repair ${String(index)}`,
      partnerId: `partner-repair-${String(index)}`,
      partnerRevisionId: `revision-repair-${String(index)}`,
      skills: [],
    })));
    render(<PartnerPage api={api} />);
    for (const [, message] of reasons) expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("requires read for a narrowed Pi tool list before allowing a Skill revision", async () => {
    const api = new DigitalLifeApi("");
    const partner = {
      ...coder,
      configuration: { reasonCodes: ["partner_skill_requires_read"], status: "ACTION_REQUIRED" as const },
      partnerId: "partner-read-required",
      partnerRevisionId: "revision-read-required",
      skills: ["agents/valid"],
      tools: ["edit"],
    };
    mockCatalog(api, [partner]);
    vi.spyOn(api, "engineSkills").mockResolvedValue({ items: [{ displayName: "有效技能", id: "agents/valid" }] });
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue({ ...partner, tools: ["read", "edit"] });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    const save = await screen.findByRole("button", { name: "保存修改" });
    expect(save).toBeDisabled();
    fireEvent.click(within(screen.getByRole("group", { name: "工具白名单" })).getByText("read"));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-read-required", expect.objectContaining({ tools: ["edit", "read"] })));
  });

  it("shows the empty state and nudges users to create two or three partners", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    render(<PartnerPage api={api} />);
    expect(await screen.findByRole("heading", { name: "还没有搭档" })).toBeInTheDocument();
    expect(screen.getByText(/先建立 2-3 个工作搭档/u)).toBeInTheDocument();
  });

  it("suggests building more partners while only one exists", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    render(<PartnerPage api={api} />);
    expect(await screen.findByText(/建议先建立 2-3 个工作搭档/u)).toBeInTheDocument();
  });

  it("toggles the enabled state and duplicates a partner from its card", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    const setEnabled = vi.spyOn(api, "setPartnerEnabled").mockResolvedValue({ ...coder, status: "DISABLED" });
    const duplicate = vi.spyOn(api, "duplicatePartner").mockResolvedValue({ ...coder, displayName: "Local Coder（副本）", partnerId: "partner-copy" });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByLabelText("启用或停用 Local Coder"));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith("partner-1", false));
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("partner-1"));
  });

  it("gates deletion behind drain state exactly like the DRAIN policy", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [{ ...coder, inFlightCount: 1, status: "DISABLED" }]);
    render(<PartnerPage api={api} />);
    expect(await screen.findByText("正在排空 1 项在途工作")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除搭档" })).toBeDisabled();
  });

  it("creates a local partner from the basic tab with redacted optional fields omitted", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    const create = vi.spyOn(api, "createPartner").mockResolvedValue(coder);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Writer" } });
    fireEvent.change(screen.getByLabelText("描述（给 joi 做参考）"), { target: { value: "写文档的搭档" } });
    fireEvent.click(screen.getByRole("button", { name: "保存搭档" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      description: "写文档的搭档", displayName: "Writer", kind: "local-pi", skills: [], tools: [],
    }));
  });

  it("updates description and advanced model fields through the tabbed editor", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "listModelSources").mockResolvedValue({
      items: [{
        accessMode: "api", activeModel: { capability: "release-tested", id: "kimi-k2.5", revisionId: "model-1" },
        activeSourceRevisionId: "source-revision-1", credential: { configured: true, version: 1 }, displayName: "Kimi",
        kind: "kimi", order: 0, primary: true, protocol: "openai", sourceId: "source-1", status: "READY",
      }],
    });
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue({ ...coder, description: "擅长重构" });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("描述（给 joi 做参考）"), { target: { value: "擅长重构" } });
    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    expect(screen.getByText("Kimi（kimi）")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("模型名"), { target: { value: "kimi-k2.5" } });
    fireEvent.change(screen.getByLabelText("搭档引擎"), { target: { value: "pi-core" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-1", expect.objectContaining({
      description: "擅长重构", displayName: "Local Coder", modelIdOverride: "kimi-k2.5",
    })));
  });

  it("onboards remote A2A partners through the card and bearer branch", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    const addAgent = vi.spyOn(api, "addAgent").mockResolvedValue({
      agentConnectionId: "agent-remote", credentialVersion: 1, name: "Remote Researcher", readiness: true,
      skills: ["research"], status: "ACTIVE", updatedAt: "2026-07-28T10:00:00.000Z",
    });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));
    fireEvent.click(screen.getByRole("button", { name: /远端 A2A/u }));
    fireEvent.change(screen.getByLabelText("远端 Agent Card URL"), { target: { value: "https://agent.test/card.json" } });
    fireEvent.change(screen.getByLabelText("远端 Bearer Token"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "登记远端搭档" }));
    await waitFor(() => expect(addAgent).toHaveBeenCalledWith("https://agent.test/card.json", "secret"));
  });

  it("lists and removes knowledge documents inside the editor", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "listKnowledgeDocs").mockResolvedValue({
      items: [{ bytes: 2048, createdAt: "2026-07-28T10:00:00.000Z", docId: "doc-1", filename: "guide.md", sha256: "a".repeat(64) }],
    });
    const remove = vi.spyOn(api, "deleteKnowledgeDoc").mockResolvedValue(undefined);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(await screen.findByText(/guide\.md/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("partner-1", "doc-1"));
  });

  it("keeps an unavailable partner registry explicit", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "listPartners").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [] });
    render(<PartnerPage api={api} />);
    expect(await screen.findByText("没能读取统一搭档目录。")).toBeInTheDocument();
  });

  it("explains failures of card actions with actionable notices", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [{ ...coder, status: "DISABLED" }]);
    vi.spyOn(api, "setPartnerEnabled").mockRejectedValue(new Error("toggle failed"));
    vi.spyOn(api, "duplicatePartner").mockRejectedValue(new Error("dup failed"));
    vi.spyOn(api, "deletePartner").mockRejectedValue(new Error("delete failed"));
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByLabelText("启用或停用 Local Coder"));
    expect(await screen.findByText("搭档状态没切成。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    expect(await screen.findByText("搭档没能复制。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除搭档" }));
    expect(await screen.findByText("搭档还不能删除。")).toBeInTheDocument();
  });

  it("reports create and a2a onboarding failures inside the editor", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    vi.spyOn(api, "createPartner").mockRejectedValue(new ApiError("partner_description_invalid", "描述太长。", 400));
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Writer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存搭档" }));
    expect(await screen.findByText("描述太长。")).toBeInTheDocument();

    vi.spyOn(api, "addAgent").mockRejectedValue(new Error("card unreachable"));
    fireEvent.click(screen.getByRole("button", { name: /远端 A2A/u }));
    fireEvent.change(screen.getByLabelText("远端 Agent Card URL"), { target: { value: "https://agent.test/card.json" } });
    fireEvent.click(screen.getByRole("button", { name: "登记远端搭档" }));
    expect(await screen.findByText("远端搭档没登记成功。")).toBeInTheDocument();
  });

  it("explains knowledge upload and removal failures without losing the editor", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "listKnowledgeDocs")
      .mockResolvedValueOnce({ items: [{ bytes: 10, createdAt: "2026-07-28T10:00:00.000Z", docId: "doc-1", filename: "guide.md", sha256: "b".repeat(64) }] })
      .mockResolvedValue({ items: [] });
    vi.spyOn(api, "uploadKnowledgeDoc").mockRejectedValue(new ApiError("partner_kb_too_many", "知识库已满。", 400));
    vi.spyOn(api, "deleteKnowledgeDoc").mockRejectedValue(new Error("remove failed"));
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(await screen.findByText(/guide\.md/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(await screen.findByText("知识库文档没移除。")).toBeInTheDocument();
    const input = screen.getByLabelText("附加知识库文档");
    fireEvent.change(input, { target: { files: null } });
    fireEvent.change(input, { target: { files: [new File(["x"], "extra.md")] } });
    expect(await screen.findByText("知识库已满。")).toBeInTheDocument();
  });

  it("reports knowledge load failures inside the editor", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "listKnowledgeDocs").mockRejectedValue(new Error("kb offline"));
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(await screen.findByText("没能读取知识库。")).toBeInTheDocument();
  });

  it("shows the optional model override when editing a local CLI partner", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [{ ...coder, engine: "claude-code", engineModelId: "claude-sonnet" }]);
    render(<PartnerPage api={api} />);
    expect(await screen.findByText("本机 · Claude Code")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    expect(screen.getByLabelText("模型名（可选覆盖）")).toBeInTheDocument();
  });

  it("edits a remote A2A partner with the card-origin notice", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [{ ...coder, kind: "a2a" }]);
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue(coder);
    render(<PartnerPage api={api} />);
    expect(await screen.findByText("远端 A2A · Pi core")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByText(/远端搭档的能力来自 Agent Card/u)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("描述（给 joi 做参考）"), { target: { value: "远端研究员" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-1", expect.objectContaining({ description: "远端研究员" })));
  });

  it("creates a global partner template without cwd while cards fall back for bare partners", async () => {
    const api = new DigitalLifeApi("");
    const bare: PartnerDto = {
      capabilities: [], createdBy: "user", displayName: "Bare", engine: "pi-core", inFlightCount: 0,
      kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner-bare",
      partnerRevisionId: "revision-bare", registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
    };
    mockCatalog(api, [bare]);
    vi.spyOn(api, "listModelSources").mockResolvedValue({
      items: [{
        accessMode: "api", activeModel: { capability: "release-tested", id: "kimi-k2.5", revisionId: "model-1" },
        activeSourceRevisionId: "source-revision-1", credential: { configured: true, version: 1 }, displayName: "Kimi",
        kind: "kimi", order: 0, primary: true, protocol: "openai", sourceId: "source-1", status: "READY",
      }],
    });
    const create = vi.spyOn(api, "createPartner").mockResolvedValue(coder);
    render(<PartnerPage api={api} />);
    expect(await screen.findByText("还没有描述。补一句，joi 才知道什么时候该找它。")).toBeInTheDocument();
    expect(screen.getByText("尚未声明能力")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加搭档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Writer" } });
    fireEvent.change(screen.getByLabelText("搭档提示词"), { target: { value: "只写文档" } });
    expect(screen.queryByLabelText("工作路径（cwd）")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    fireEvent.change(screen.getByLabelText("供应商"), { target: { value: "source-1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存搭档" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      displayName: "Writer", modelSourceId: "source-1", prompt: "只写文档",
    })));
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("workspaceRef");
  });

  it("labels engine options by detection status, warns on an undetected local engine and lists its tools", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "engineCatalog").mockResolvedValue({ items: [
      { available: true, id: "pi-core", tools: ["read", "edit"] },
      { available: true, id: "claude-code", tools: ["Bash"] },
      { available: false, id: "codex", reason: "codex 未在 PATH 中找到，无法使用本地 Codex 引擎。", tools: ["shell", "apply_patch"] },
    ] });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));
    fireEvent.click(await screen.findByRole("tab", { name: "高级" }));
    expect(await screen.findByRole("option", { name: "Claude Code（已检测到）" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Codex（未检测到）" })).toBeInTheDocument();
    expect(screen.getByText("read")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搭档引擎"), { target: { value: "codex" } });
    expect(await screen.findByText(/codex 未在 PATH 中找到/u)).toBeInTheDocument();
    expect(screen.getByText("apply_patch")).toBeInTheDocument();
  });

  it("switches back to the basic tab and leaves the add editor without saving", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    fireEvent.click(screen.getByRole("tab", { name: "基础" }));
    expect(screen.getByLabelText("名称")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));
    expect(await screen.findByRole("heading", { name: "这位搭档从哪里来？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(await screen.findByRole("heading", { name: "搭档" })).toBeInTheDocument();
  });

  it("returns to the grid from the editor and can switch add modes both ways", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(await screen.findByRole("heading", { name: "搭档" })).toBeInTheDocument();
    expect(screen.getByText("已返回搭档列表。")).toBeInTheDocument();
  });

  it("opens the editor from the empty state and switches between local and a2a modes", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加第一个搭档" }));
    expect(await screen.findByRole("heading", { name: "这位搭档从哪里来？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /远端 A2A/u }));
    expect(screen.getByLabelText("远端 Agent Card URL")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /本地搭档/u }));
    expect(screen.getByLabelText("名称")).toBeInTheDocument();
  });

  it("opens the created partner in the editor so knowledge can be attached", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "createPartner").mockResolvedValue(coder);
    vi.spyOn(api, "listKnowledgeDocs").mockResolvedValue({ items: [] });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Local Coder" } });
    fireEvent.click(screen.getByRole("button", { name: "保存搭档" }));
    expect(await screen.findByRole("heading", { name: "Local Coder" })).toBeInTheDocument();
    expect(screen.getByLabelText("附加知识库文档")).toBeInTheDocument();
  });

  it("returns to the grid with the success notice when the refresh after creation fails", async () => {
    const api = new DigitalLifeApi("");
    vi.spyOn(api, "listPartners").mockResolvedValueOnce({ items: [] }).mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [] });
    vi.spyOn(api, "createPartner").mockResolvedValue(coder);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Writer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存搭档" }));
    expect(await screen.findByRole("heading", { name: "搭档" })).toBeInTheDocument();
    expect(screen.getByText(/搭档已登记/u)).toBeInTheDocument();
  });

  it("selects skills and tools via chips and jumps to provider management without a cwd field", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    vi.spyOn(api, "engineSkills").mockResolvedValue({ items: [{ id: "claude-code/demo-skill", displayName: "Demo Skill" }] });
    const manage = vi.fn();
    render(<PartnerPage api={api} onManageProviders={manage} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));

    expect(await screen.findByText("Demo Skill")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Demo Skill"));
    fireEvent.click(screen.getByText("Demo Skill"));

    expect(screen.queryByLabelText("工作路径")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    const toolChoices = await screen.findByRole("group", { name: "工具白名单" });
    expect(toolChoices).toHaveClass("tool-choice-grid");
    const readChoice = within(toolChoices).getByText("read").closest("label");
    expect(readChoice).toHaveClass("tool-choice");
    fireEvent.click(within(toolChoices).getByText("read"));
    fireEvent.click(within(toolChoices).getByText("read"));
    fireEvent.click(screen.getByRole("button", { name: "管理大模型网络" }));
    expect(manage).toHaveBeenCalledOnce();
  });

  it("creates the selected scenario roles as partners from the scenarios tab", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    vi.spyOn(api, "scenarios").mockResolvedValue({ items: [
      {
        blurb: "组建审查团队", id: "review-code", prompt: "审查场景提示词",
        roles: [
          { id: "correctness", prompt: "正确性提示词", title: "正确性审查搭档" },
          { id: "maintainability", prompt: "可维护性提示词", title: "可维护性审查搭档" },
        ],
        source: "builtin", title: "审查一段代码",
      },
    ] });
    const create = vi.spyOn(api, "createScenarioPartners").mockResolvedValue({ items: [coder] });
    render(<PartnerPage api={api} onTabChange={() => undefined} tab="scenarios" />);
    fireEvent.click(await screen.findByRole("button", { name: /审查一段代码/u }));
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    const secondBox = boxes[1];
    if (secondBox === undefined) throw new Error("expected a second role checkbox");
    fireEvent.click(secondBox);
    fireEvent.click(screen.getByRole("button", { name: "创建所选搭档" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("review-code", ["correctness"]));
    expect(await screen.findByText(/已创建 1 位搭档/u)).toBeInTheDocument();
  });

  it("expands the AI Berkshire package and installs a team without manual role input", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    vi.spyOn(api, "scenarios").mockResolvedValue({ items: [] });
    const initial: ScenarioPackDto = {
      blurb: "完整价值投资协作套件", definitionVersion: 1, id: "ai-berkshire-value-research",
      installedRoleCount: 0, source: { license: "MIT", repository: "xbtlin/ai-berkshire", revision: "2760dc48" },
      status: "NOT_INSTALLED", title: "AI Berkshire 价值研究套件", totalRoleCount: 15,
      teams: [{
        blurb: "把证据整理为长篇研究", id: "research-publishing", title: "研究发布",
        roles: [
          { blurb: "写作", id: "longform-writer", roleId: "longform-writer", status: "NOT_INSTALLED", title: "长篇研究作者" },
          { blurb: "审校", id: "editorial-reviewer", roleId: "editorial-reviewer", status: "NOT_INSTALLED", title: "编辑与读者评审" },
        ],
      }],
    };
    const active: ScenarioPackDto = {
      ...initial, installedRoleCount: 2, status: "ACTIVE",
      teams: initial.teams.map((team) => ({ ...team, roles: team.roles.map((role) => ({ ...role, partnerId: `partner-${role.id}`, status: "ACTIVE" as const })) })),
    };
    vi.spyOn(api, "scenarioPacks").mockResolvedValueOnce({ items: [initial] }).mockResolvedValue({ items: [active] });
    const install = vi.spyOn(api, "installScenarioPack").mockResolvedValueOnce({
      installedRoleCount: 2,
      outcomes: [
        { outcome: "CREATED", partnerId: "partner-longform", roleId: "longform-writer" },
        { outcome: "REUSED", partnerId: "partner-editor", roleId: "editorial-reviewer" },
      ],
      packId: initial.id, status: "ACTIVE",
    }).mockRejectedValueOnce(new ApiError("scenario_pack_action_required", "套件配置需要处理。", 400));

    render(<PartnerPage api={api} onTabChange={() => undefined} tab="scenarios" />);
    fireEvent.click(await screen.findByRole("button", { name: /AI Berkshire 价值研究套件/u }));
    expect(screen.getByText("长篇研究作者")).toBeInTheDocument();
    expect(screen.getAllByText("未安装").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "安装研究发布" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith(initial.id, ["research-publishing"]));
    expect(await screen.findByText(/新建 1 位，复用 1 位/u)).toBeInTheDocument();
    expect((await screen.findAllByText("已启用")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "安装完整套件" }));
    await waitFor(() => expect(install).toHaveBeenLastCalledWith(initial.id, undefined));
    expect(await screen.findByText("套件配置需要处理。")).toBeInTheDocument();
  });

  it("reports a failure when scenario partner creation fails", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    vi.spyOn(api, "scenarios").mockResolvedValue({ items: [
      {
        blurb: "组建诊断团队", id: "diagnose-bug", prompt: "诊断场景提示词",
        roles: [{ id: "reproducer", prompt: "复现提示词", title: "复现搭档" }],
        source: "builtin", title: "诊断一个 Bug",
      },
    ] });
    vi.spyOn(api, "createScenarioPartners").mockRejectedValue(new ApiError("offline", "创建失败", 503));
    render(<PartnerPage api={api} onTabChange={() => undefined} tab="scenarios" />);
    fireEvent.click(await screen.findByRole("button", { name: /诊断一个 Bug/u }));
    fireEvent.click(await screen.findByRole("button", { name: "创建所选搭档" }));
    expect(await screen.findByText("场景搭档没创建成功，请重试。")).toBeInTheDocument();
  });

  it("switches between the scenarios and partners tabs", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    const setTab = vi.fn();
    render(<PartnerPage api={api} onTabChange={setTab} tab="partners" />);
    fireEvent.click(await screen.findByRole("tab", { name: "场景预设" }));
    expect(setTab).toHaveBeenCalledWith("scenarios");
    fireEvent.click(screen.getByRole("tab", { name: "搭档目录" }));
    expect(setTab).toHaveBeenCalledWith("partners");
  });

  it("synchronizes the editable model name when the provider changes and reloads the saved revision", async () => {
    const api = new DigitalLifeApi("");
    const revised = { ...coder, modelIdOverride: "gpt-5.6-sol-sub", modelSourceId: "source-ready", partnerRevisionId: "revision-2", registryRevision: 2 };
    vi.spyOn(api, "listPartners").mockResolvedValueOnce({ items: [coder] }).mockResolvedValue({ items: [revised] });
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [{
      accessMode: "api", activeModel: { capability: "release-tested", id: "gpt-5.6-sol-sub", revisionId: "model-1" },
      activeSourceRevisionId: "source-revision-1", credential: { configured: true, version: 1 }, displayName: "gpt-sub",
      kind: "generic-openai", order: 0, primary: true, protocol: "openai", sourceId: "source-ready", status: "READY",
    }] });
    vi.spyOn(api, "engineCatalog").mockResolvedValue({ items: [] });
    vi.spyOn(api, "engineSkills").mockResolvedValue({ items: [{ displayName: "TypeScript", id: "typescript" }] });
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue(revised);
    render(<PartnerPage api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(await screen.findByText("TypeScript")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    fireEvent.change(screen.getByLabelText("供应商"), { target: { value: "source-ready" } });
    expect(screen.getByLabelText("模型名")).toHaveValue("gpt-5.6-sol-sub");
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-1", expect.objectContaining({
      modelIdOverride: "gpt-5.6-sol-sub", modelSourceId: "source-ready",
    })));
    expect(await screen.findByRole("heading", { name: "Local Coder" })).toBeInTheDocument();
  });

  it("tests a Pi partner model from its status area and shows the persisted safe result", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "testPartnerModel").mockResolvedValue({
      modelId: "gpt-5.6-sol-sub", partnerId: "partner-1", sourceDisplayName: "gpt-sub", sourceId: "source-ready",
      status: "READY", testedAt: "2026-08-25T08:00:00.000Z",
    });
    render(<PartnerPage api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "测试模型" }));
    expect(await screen.findByText(/模型可用/u)).toBeInTheDocument();
    expect(screen.getByText(/gpt-sub · gpt-5\.6-sol-sub/u)).toBeInTheDocument();
  });

  it("shows a safe actionable reason when a Pi partner model test fails", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "testPartnerModel").mockResolvedValue({
      modelId: "DeepSeek-V4-Pro", partnerId: "partner-1", reasonCode: "partner_model_override_not_ready",
      sourceDisplayName: "gpt-sub", sourceId: "source-ready", status: "FAILED", testedAt: "2026-08-25T08:00:00.000Z",
    });
    render(<PartnerPage api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "测试模型" }));
    expect(await screen.findByText("模型名与供应商当前模型不一致")).toBeInTheDocument();
  });

  it("restores persisted provider validation status and detects a stale partner override", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [
      { ...coder, displayName: "Ready Coder", modelIdOverride: "gpt-5.6-sol-sub", modelSourceId: "source-ready" },
      { ...coder, displayName: "Stale Coder", modelIdOverride: "DeepSeek-V4-Pro", modelSourceId: "source-ready", partnerId: "partner-2", partnerRevisionId: "revision-2" },
    ]);
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [{
      accessMode: "api", activeModel: { capability: "release-tested", id: "gpt-5.6-sol-sub", revisionId: "model-1" },
      activeSourceRevisionId: "source-revision-1", credential: { configured: true, version: 1 }, displayName: "gpt-sub",
      kind: "generic-openai", lastValidatedAt: "2026-08-25T08:00:00.000Z", order: 0, primary: true,
      protocol: "openai", sourceId: "source-ready", status: "READY",
    }] });
    render(<PartnerPage api={api} />);

    expect((await screen.findAllByText("模型可用")).length).toBeGreaterThan(0);
    expect(screen.getByText("模型名与供应商当前模型不一致")).toBeInTheDocument();
  });

  it("maps model-source readiness failures and rejected requests to safe card states", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "testPartnerModel")
      .mockResolvedValueOnce({
        partnerId: "partner-1", reasonCode: "partner_model_source_not_ready", status: "FAILED",
        testedAt: "2026-08-25T08:00:00.000Z",
      })
      .mockRejectedValueOnce(new Error("private failure"));
    render(<PartnerPage api={api} />);

    const button = await screen.findByRole("button", { name: "测试模型" });
    fireEvent.click(button);
    expect(await screen.findByText("供应商尚未就绪")).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText("模型连接失败")).toBeInTheDocument();
    expect(screen.queryByText("private failure")).not.toBeInTheDocument();
  });

});
