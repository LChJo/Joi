// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, DigitalLifeApi } from "../../src/renderer/api.js";
import { PartnerPage } from "../../src/renderer/PartnerPage.js";
import type { PartnerDto, ScenarioPackDto } from "../../src/shared/joi.js";

const coder: PartnerDto = {
  capabilities: ["code"], createdBy: "user", description: "写代码的搭档", displayName: "Local Coder",
  engine: "pi-core", inFlightCount: 0, kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN",
  partnerId: "partner-1", partnerRevisionId: "revision-1", promptConfigured: true, registryRevision: 1, skills: ["typescript"],
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
  it.each(["new","existing"])("CHAT-43 groups browser permissions in one default-off switch for a %s partner",async mode => {
    const api = new DigitalLifeApi("");
    const partner = { ...coder,skills: [],toolPolicyMode: "ALL" as const,tools: [] };
    mockCatalog(api,mode === "new" ? [] : [partner]);
    vi.spyOn(api,"engineCatalog").mockResolvedValue({ items: [{ available: true,id: "pi-core",tools: ["read","edit","browser_snapshot","browser_click"] }] });
    const create = vi.spyOn(api,"createPartner").mockResolvedValue(coder);
    const update = vi.spyOn(api,"updatePartner").mockResolvedValue(coder);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button",{ name: mode === "new" ? "添加搭档" : "编辑" }));
    if (mode === "new") fireEvent.change(screen.getByLabelText("名称"),{ target: { value: "Browser helper" } });
    fireEvent.click(screen.getByRole("tab",{ name: "高级" }));
    const tools = await screen.findByRole("group",{ name: "工具白名单" });
    expect(within(tools).getByRole("checkbox",{ name: "read" })).toBeChecked();
    const browser = within(tools).getByRole("switch",{ name: "Agent Browser" });
    expect(browser).not.toBeChecked();
    expect(within(tools).getAllByRole("switch")).toHaveLength(1);
    expect(within(tools).queryByRole("checkbox",{ name: /^browser_/ })).not.toBeInTheDocument();
    fireEvent.click(browser);
    expect(within(tools).getByRole("checkbox",{ name: "read" })).toBeChecked();
    expect(browser).toBeChecked();
    expect(screen.getByText("自定义权限：已开启 3 项。")).toBeInTheDocument();
    fireEvent.click(browser);expect(browser).not.toBeChecked();
    expect(within(tools).getByRole("checkbox",{ name: "read" })).toBeChecked();
    fireEvent.click(browser);expect(browser).toBeChecked();
    fireEvent.click(screen.getByRole("button",{ name: mode === "new" ? "保存搭档" : "保存修改" }));
    await waitFor(() => expect(mode === "new" ? create : update).toHaveBeenCalled());
    expect(mode === "new" ? create.mock.calls[0]?.[0] : update.mock.calls[0]?.[1]).toMatchObject({ toolPolicyMode: "CUSTOM",tools: ["read","edit","browser_snapshot","browser_click"] });
  });

  it.each(["off","partial","on"])("CHAT-43 restores the browser family %s without widening saved permissions",async selection => {
    const api = new DigitalLifeApi("");
    const tools = ["read",...(selection === "off" ? [] : selection === "partial" ? ["browser_snapshot"] : ["browser_snapshot","browser_click"])];
    const partner = { ...coder,skills: [],toolPolicyMode: "CUSTOM" as const,tools };
    mockCatalog(api,[partner]);
    vi.spyOn(api,"engineCatalog").mockResolvedValue({ items: [{ available: true,id: "pi-core",tools: ["read","edit","browser_snapshot","browser_click"] }] });
    const update = vi.spyOn(api,"updatePartner").mockResolvedValue(partner);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button",{ name: "编辑" }));
    fireEvent.click(screen.getByRole("tab",{ name: "高级" }));
    const browser = await screen.findByRole("switch",{ name: "Agent Browser" });
    expect(browser).toHaveProperty("checked",selection === "on");
    if (selection === "on") fireEvent.click(browser);
    fireEvent.click(screen.getByRole("button",{ name: "保存修改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-1",expect.objectContaining({ tools: ["read"] })));
  });

  it.each([true,false])("CHAT-41 filters retired tool selections only when the current catalog is known (%s)",async catalogAvailable => {
    const api = new DigitalLifeApi("");
    const partner = { ...coder,skills: [],toolPolicyMode: "CUSTOM" as const,tools: ["read","openwiki_search"] };
    mockCatalog(api,[partner]);
    if (!catalogAvailable) vi.spyOn(api,"engineCatalog").mockRejectedValue(new Error("Synthetic catalog unavailable"));
    const update = vi.spyOn(api,"updatePartner").mockResolvedValue(partner);
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button",{ name: "编辑" }));
    fireEvent.click(screen.getByRole("button",{ name: "保存修改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-1",expect.objectContaining({ tools: catalogAvailable ? ["read"] : partner.tools })));
  });

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
      description: "写文档的搭档", displayName: "Writer", engine: "pi-core", kind: "local-pi", skills: [], toolPolicyMode: "ALL", tools: [],
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

  it("sends the engine when a partner is switched away from Codex back to Pi core", async () => {
    const api = new DigitalLifeApi("");
    const codexPartner: PartnerDto = {
      ...coder, engine: "codex", engineModelId: "gpt-6-sol", partnerId: "partner-codex",
      partnerRevisionId: "revision-codex", skills: [], tools: [],
    };
    mockCatalog(api, [codexPartner]);
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue({ ...codexPartner, engine: "pi-core" });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    fireEvent.change(screen.getByLabelText("搭档引擎"), { target: { value: "pi-core" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    // The update endpoint keeps the current engine when the payload omits the field, so a
    // payload without `engine` silently pinned the partner to its previous engine.
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-codex", expect.objectContaining({ engine: "pi-core" })));
  });

  it("reveals a configured prompt only after an explicit click and appends new instructions", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "engineSkills").mockResolvedValue({ items: [{ displayName: "TypeScript", id: "typescript" }] });
    const reveal = vi.fn().mockResolvedValue({ prompt: "先核对事实。" });
    Object.assign(api, { revealPartnerPrompt: reveal });
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue({ ...coder, registryRevision: 2 });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));

    expect(screen.queryByDisplayValue("先核对事实。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看提示词" }));
    expect(await screen.findByDisplayValue("先核对事实。")).toBeInTheDocument();
    expect(reveal).toHaveBeenCalledWith("partner-1");

    fireEvent.click(screen.getByRole("radio", { name: "追加" }));
    fireEvent.change(screen.getByLabelText("追加内容"), { target: { value: "再列出反证。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-1", expect.objectContaining({
      prompt: "再列出反证。", promptMode: "APPEND",
    })));
  });

  it("replaces a revealed prompt and reports reveal failures without leaking private errors", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "engineSkills").mockResolvedValue({ items: [{ displayName: "TypeScript", id: "typescript" }] });
    const reveal = vi.fn()
      .mockResolvedValueOnce({ prompt: "旧提示词" })
      .mockRejectedValueOnce(new Error("private database path"));
    Object.assign(api, { revealPartnerPrompt: reveal });
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue({ ...coder, registryRevision: 2 });
    const { unmount } = render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "查看提示词" }));
    const editor = await screen.findByLabelText("替换内容");
    fireEvent.change(editor, { target: { value: "新提示词" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("partner-1", expect.objectContaining({
      prompt: "新提示词", promptMode: "REPLACE",
    })));

    unmount();
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "查看提示词" }));
    expect(await screen.findByText("提示词没能读取，请重试。")).toBeInTheDocument();
    expect(screen.queryByText("private database path")).not.toBeInTheDocument();
  });

  it("does not rewrite a prompt when it was only revealed", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [coder]);
    vi.spyOn(api, "engineSkills").mockResolvedValue({ items: [{ displayName: "TypeScript", id: "typescript" }] });
    Object.assign(api, { revealPartnerPrompt: vi.fn().mockResolvedValue({ prompt: "保持原样" }) });
    const update = vi.spyOn(api, "updatePartner").mockResolvedValue({ ...coder, registryRevision: 2 });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "查看提示词" }));
    expect(await screen.findByLabelText("替换内容")).toHaveValue("保持原样");
    const save = screen.getByRole("button", { name: "保存修改" });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("prompt");
    expect(update.mock.calls[0]?.[1]).not.toHaveProperty("promptMode");
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

  it("labels engine options by detection status and shows Codex permission controls instead of tools", async () => {
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
    expect(within(screen.getByRole("group", { name: "工具白名单" })).getAllByRole("checkbox").every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText("全部工具已开启。关闭任意工具会切换为自定义权限。")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搭档引擎"), { target: { value: "codex" } });
    expect(await screen.findByText(/codex 未在 PATH 中找到/u)).toBeInTheDocument();
    expect(screen.getByText("Codex 权限")).toBeInTheDocument();
    expect(screen.getByLabelText("Codex 工作区权限")).toHaveValue("workspace-write");
    expect(screen.getByLabelText("Codex 网页搜索")).toHaveValue("live");
    expect(screen.getByText("允许网络访问").closest("label")?.querySelector("input")).toBeChecked();
    expect(screen.queryByText("apply_patch")).not.toBeInTheDocument();
  });

  it("submits explicit safe Codex permissions", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    const create = vi.spyOn(api, "createPartner").mockResolvedValue({
      ...coder, codexPermissions: { approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "read-only", webSearchMode: "live" },
      displayName: "Codex worker", engine: "codex", partnerId: "partner-codex", partnerRevisionId: "revision-codex", skills: [], tools: [],
    });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "添加搭档" }));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Codex worker" } });
    fireEvent.click(screen.getByRole("tab", { name: "高级" }));
    fireEvent.change(screen.getByLabelText("搭档引擎"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Codex 工作区权限"), { target: { value: "read-only" } });
    fireEvent.change(screen.getByLabelText("Codex 网页搜索"), { target: { value: "live" } });
    fireEvent.click(screen.getByRole("button", { name: "保存搭档" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      codexPermissions: { approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "read-only", webSearchMode: "live" },
      displayName: "Codex worker",
      engine: "codex",
      tools: [],
    })));
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

  it("renders programming, research and built-in Skills as suites without flat scenario cards", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    vi.spyOn(api, "scenarios").mockResolvedValue({ items: [{
      blurb: "旧平铺入口", id: "implement-feature", prompt: "旧提示词",
      roles: [{ id: "coder", prompt: "编码", title: "编码搭档" }], source: "builtin", title: "旧平铺功能卡",
    }] });
    const suite = (id: string, title: string): ScenarioPackDto => ({
      blurb: `${title}说明`, definitionVersion: 1, id, installedRoleCount: 0,
      source: { license: "内置", repository: "joi/builtin", revision: "builtin1" },
      status: "NOT_INSTALLED", teams: [], title, totalRoleCount: 0,
    });
    vi.spyOn(api, "scenarioPacks").mockResolvedValue({ items: [
      suite("programming", "编程套件"),
      suite("research-analysis", "调研分析套件"),
      suite("builtin-skills", "内置 Skills 套件"),
    ] });

    render(<PartnerPage api={api} onTabChange={() => undefined} tab="scenarios" />);

    expect(await screen.findByRole("button", { name: /编程套件/u })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /调研分析套件/u })).toBeInTheDocument();
    const skillsSuite = screen.getByRole("button", { name: /内置 Skills 套件/u });
    expect(skillsSuite).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /旧平铺功能卡/u })).not.toBeInTheDocument();
    fireEvent.click(skillsSuite);
    expect(screen.getByRole("button", { name: "暂无可安装项" })).toBeDisabled();
  });

  it("reports a safe failure when the suite catalog cannot be loaded", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, []);
    vi.spyOn(api, "scenarioPacks").mockRejectedValue(new Error("private catalog failure"));
    render(<PartnerPage api={api} onTabChange={() => undefined} tab="scenarios" />);
    expect(await screen.findByText("场景套件没能读取，请稍后重试。")).toBeInTheDocument();
    expect(screen.queryByText("private catalog failure")).not.toBeInTheDocument();
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

  it("offers real availability tests for Codex and Claude Code and shows safe invocation outcomes", async () => {
    const api = new DigitalLifeApi("");
    const codex = { ...coder, displayName: "Local Codex", engine: "codex" as const, engineModelId: "gpt-5.6-codex", partnerId: "partner-codex", partnerRevisionId: "revision-codex" };
    const claude = { ...coder, displayName: "Local Claude", engine: "claude-code" as const, partnerId: "partner-claude", partnerRevisionId: "revision-claude" };
    mockCatalog(api, [codex, claude]);
    const test = vi.spyOn(api, "testPartnerModel")
      .mockResolvedValueOnce({ modelId: "gpt-5.6-codex", partnerId: "partner-codex", status: "READY", testedAt: "2026-08-30T03:00:00.000Z" })
      .mockResolvedValueOnce({ partnerId: "partner-claude", reasonCode: "partner_cli_probe_timed_out", status: "FAILED", testedAt: "2026-08-30T03:01:00.000Z" });
    render(<PartnerPage api={api} />);

    const buttons = await screen.findAllByRole("button", { name: "测试可用性" });
    expect(buttons).toHaveLength(2);
    const [codexButton, claudeButton] = buttons;
    if (codexButton === undefined || claudeButton === undefined) throw new Error("expected both local CLI test buttons");
    fireEvent.click(codexButton);
    expect(await screen.findByText("搭档可用")).toBeInTheDocument();
    expect(test).toHaveBeenCalledWith("partner-codex");

    fireEvent.click(claudeButton);
    expect(await screen.findByText("搭档调用超时")).toBeInTheDocument();
    expect(test).toHaveBeenCalledWith("partner-claude");
  });

  it("shows native Claude authentication guidance without requiring an environment API key", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [{ ...coder, engine: "claude-code", partnerId: "partner-claude" }]);
    vi.spyOn(api, "testPartnerModel").mockResolvedValue({ partnerId: "partner-claude", reasonCode: "partner_cli_auth_required", status: "FAILED", testedAt: "2026-09-18T03:00:00.000Z" });
    render(<PartnerPage api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "测试可用性" }));
    expect(await screen.findByText("Claude Code 认证失败，请检查本机 Claude 的登录或凭据配置")).toBeInTheDocument();
  });

  it("maps local CLI probe failures to safe actionable messages", async () => {
    const api = new DigitalLifeApi("");
    const codex = { ...coder, displayName: "Local Codex", engine: "codex" as const, partnerId: "partner-codex", partnerRevisionId: "revision-codex" };
    mockCatalog(api, [codex]);
    vi.spyOn(api, "testPartnerModel")
      .mockResolvedValueOnce({ partnerId: "partner-codex", reasonCode: "partner_cli_auth_required", status: "FAILED", testedAt: "2026-08-30T03:00:00.000Z" })
      .mockResolvedValueOnce({ partnerId: "partner-codex", reasonCode: "partner_cli_model_unsupported", status: "FAILED", testedAt: "2026-08-30T03:01:00.000Z" })
      .mockResolvedValueOnce({ partnerId: "partner-codex", reasonCode: "partner_cli_rate_limited", status: "FAILED", testedAt: "2026-08-30T03:02:00.000Z" })
      .mockResolvedValueOnce({ partnerId: "partner-codex", reasonCode: "partner_cli_provider_unavailable", status: "FAILED", testedAt: "2026-08-30T03:03:00.000Z" })
      .mockResolvedValueOnce({ partnerId: "partner-codex", reasonCode: "partner_cli_process_failed", status: "FAILED", testedAt: "2026-08-30T03:04:00.000Z" })
      .mockResolvedValueOnce({ partnerId: "partner-codex", reasonCode: "partner_cli_store_failed", status: "FAILED", testedAt: "2026-08-30T03:05:00.000Z" });
    render(<PartnerPage api={api} />);

    const button = await screen.findByRole("button", { name: "测试可用性" });
    fireEvent.click(button);
    expect(await screen.findByText("Codex 尚未登录，请先完成登录")).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText("当前本地 CLI 或账户不支持这个模型，请更新 CLI 或检查模型权限")).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText("调用过于频繁，请稍后重试")).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText("模型服务暂时不可用，请稍后重试")).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText("本地搭档进程启动失败")).toBeInTheDocument();
    fireEvent.click(button);
    expect(await screen.findByText("本地会话记录失败")).toBeInTheDocument();
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

  it("warns about a partner pinned to a source that is not READY, with no validation stamp", async () => {
    const api = new DigitalLifeApi("");
    mockCatalog(api, [{ ...coder, displayName: "Pinned Coder", modelSourceId: "source-draft" }]);
    // Editing a source resets it to DRAFT and clears `lastValidatedAt`, which is how a pinned
    // partner silently becomes undispatched. The card has to say so before a run is wasted.
    vi.spyOn(api, "listModelSources").mockResolvedValue({ items: [{
      accessMode: "token-plan", activeModel: { capability: "release-tested", id: "qwen3.8-max", revisionId: "model-1" },
      activeSourceRevisionId: "source-revision-1", credential: { configured: true, version: 1 }, displayName: "百炼 Token Plan",
      kind: "qwen", order: 0, primary: true, protocol: "anthropic", sourceId: "source-draft", status: "DRAFT",
    }] });
    render(<PartnerPage api={api} />);

    expect(await screen.findByText("供应商尚未就绪")).toBeInTheDocument();
    expect(screen.getByText("百炼 Token Plan · qwen3.8-max")).toBeInTheDocument();
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
