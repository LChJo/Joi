import { type ChangeEvent, type SyntheticEvent, useCallback, useEffect, useState } from "react";

import type { CodexPermissionsDto, ModelSourceDto, PartnerDto, PartnerEngineDto, PartnerKnowledgeDocDto, PartnerModelTestDto, ScenarioPackDto, ScenarioPackRoleStateDto, ToolPolicyModeDto } from "../shared/joi";
import { ApiError, type DigitalLifeApi } from "./api";

type PartnerView = { mode: "grid" } | { mode: "editor"; partner: PartnerDto | null };
interface EngineStatus { available: boolean; reason?: string; tools: string[]; }
interface SkillOption { displayName: string; id: string; }

const ENGINE_ORDER: PartnerEngineDto[] = ["pi-core", "claude-code", "codex"];
const ENGINE_LABELS: Record<PartnerEngineDto, string> = { "claude-code": "Claude Code", codex: "Codex", "pi-core": "Pi core" };

function textValue(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function fieldName(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function configurationMessage(reasonCodes: readonly string[]): string {
  if (reasonCodes.includes("partner_skill_requires_read")) return "Pi core 挂载 Skill 时必须启用 read 工具。";
  if (reasonCodes.includes("partner_skill_ref_invalid") || reasonCodes.includes("partner_skill_not_available") || reasonCodes.includes("partner_skill_not_found")) {
    return "有技能引用已失效，请重新选择本机已安装的技能。";
  }
  if (reasonCodes.includes("partner_skill_collision")) return "选中的技能名称发生冲突，请只保留一个来源。";
  if (reasonCodes.includes("partner_skill_environment_invalid")) return "技能的环境声明无效，请重新选择有效版本。";
  return "搭档配置需要修复后才能派发。";
}

function modelTestMessage(result: PartnerModelTestDto, engine: PartnerEngineDto): string {
  if (result.status === "READY") return engine === "pi-core" ? "模型可用" : "搭档可用";
  if (result.reasonCode === "partner_model_override_not_ready") return "模型名与供应商当前模型不一致";
  if (result.reasonCode === "partner_model_source_not_ready") return "供应商尚未就绪";
  if (result.reasonCode === "partner_cli_probe_timed_out") return "搭档调用超时";
  if (result.reasonCode === "partner_cli_auth_required") return engine === "claude-code" ? "Claude Code 认证失败，请检查本机 Claude 的登录或凭据配置" : `${ENGINE_LABELS[engine]} 尚未登录，请先完成登录`;
  if (result.reasonCode === "partner_cli_model_unsupported") return "当前本地 CLI 或账户不支持这个模型，请更新 CLI 或检查模型权限";
  if (result.reasonCode === "partner_cli_rate_limited") return "调用过于频繁，请稍后重试";
  if (result.reasonCode === "partner_cli_provider_unavailable") return "模型服务暂时不可用，请稍后重试";
  if (result.reasonCode === "partner_cli_process_failed") return "本地搭档进程启动失败";
  if (result.reasonCode === "partner_cli_store_failed") return "本地会话记录失败";
  if (result.reasonCode === "engine_unavailable") return "本地引擎未就绪";
  return engine === "pi-core" ? "模型连接失败" : "搭档调用失败";
}

function PartnerModelStatus({ engine, result }: { engine: PartnerEngineDto; result: PartnerModelTestDto | "TESTING" | undefined }) {
  const modelManaged = engine === "pi-core";
  if (result === "TESTING") return <div className="partner-model-status" role="status"><span>{modelManaged ? "正在测试模型…" : "正在真实调用搭档…"}</span></div>;
  if (result === undefined) return <div className="partner-model-status" role="status"><span>{modelManaged ? "模型状态尚未测试" : "搭档可用性尚未测试"}</span></div>;
  const detail = [result.sourceDisplayName, result.modelId].filter(Boolean).join(" · ");
  return <div className="partner-model-status" role="status">
    <span>{modelTestMessage(result, engine)}</span>
    <small>{detail}{detail === "" ? "" : " · "}{new Date(result.testedAt).toLocaleString("zh-CN")}</small>
  </div>;
}

function persistedModelTest(partner: PartnerDto, sources: ModelSourceDto[]): PartnerModelTestDto | undefined {
  const ordered = [...sources].filter((source) => source.status !== "DISABLED").sort((left, right) => left.order - right.order);
  const source = partner.modelSourceId === undefined
    ? ordered.find((candidate) => candidate.status === "READY") ?? ordered[0]
    : sources.find((candidate) => candidate.sourceId === partner.modelSourceId);
  if (source?.lastValidatedAt === undefined) return undefined;
  const modelMismatch = partner.modelIdOverride !== undefined && partner.modelIdOverride !== source.activeModel.id;
  return {
    modelId: partner.modelIdOverride ?? source.activeModel.id,
    partnerId: partner.partnerId,
    ...(modelMismatch ? { reasonCode: "partner_model_override_not_ready" } : source.reasonCode === undefined ? {} : { reasonCode: source.reasonCode }),
    sourceDisplayName: source.displayName,
    sourceId: source.sourceId,
    status: source.status === "READY" && !modelMismatch ? "READY" : "FAILED",
    testedAt: source.lastValidatedAt,
  };
}

function KnowledgeDocList({ api, onChanged, partnerId }: { api: DigitalLifeApi; onChanged: () => void; partnerId: string }) {
  const [docs, setDocs] = useState<PartnerKnowledgeDocDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => setDocs((await api.listKnowledgeDocs(partnerId)).items), [api, partnerId]);
  useEffect(() => { const timer = setTimeout(() => void load().catch(() => setBusy("没能读取知识库。")), 0); return () => clearTimeout(timer); }, [load]);
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    for (const file of files) {
      setBusy(`正在导入 ${file.name}…`);
      try { await api.uploadKnowledgeDoc(partnerId, file); }
      catch (error) { setBusy(failureMessage(error, "知识库文档没导入成功。")); await load().catch(() => undefined); return; }
    }
    setBusy(null);
    await load().catch(() => undefined);
    onChanged();
  };
  return <div className="kb-doc-list">
    {docs.map((doc) => <div className="kb-doc-row" key={doc.docId}><span>{doc.filename} · {(doc.bytes / 1024).toFixed(1)} KiB</span><button className="button ghost" onClick={() => void api.deleteKnowledgeDoc(partnerId, doc.docId).then(load).then(onChanged).catch(() => setBusy("知识库文档没移除。"))} type="button">移除</button></div>)}
    <label className="kb-upload">附加 md 文档（≤8 篇，每篇 ≤256 KiB）<input accept=".md,.txt" aria-label="附加知识库文档" multiple onChange={(event) => void upload(event)} type="file" /></label>
    {busy === null ? null : <small className="kb-busy">{busy}</small>}
  </div>;
}

function PartnerEditor({ api, engineStatuses, onDone, onManageProviders, partner, sources }: {
  api: DigitalLifeApi;
  engineStatuses: Record<string, EngineStatus>;
  onDone: (message: string, partnerId?: string) => void;
  onManageProviders?: () => void;
  partner: PartnerDto | null;
  sources: ModelSourceDto[];
}) {
  const [kind, setKind] = useState<"local-pi" | "a2a">(partner?.kind ?? "local-pi");
  const [tab, setTab] = useState<"advanced" | "basic">("basic");
  const [engine, setEngine] = useState<PartnerEngineDto>(partner?.engine ?? "pi-core");
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [loadedSkillCatalogKey, setLoadedSkillCatalogKey] = useState<string | null>(null);
  const initialSelectedSkills = partner?.skills ?? [];
  const [selectedSkills, setSelectedSkills] = useState<string[]>(partner?.skills ?? []);
  const [selectedTools, setSelectedTools] = useState<string[]>(partner?.tools ?? []);
  const [toolPolicyMode, setToolPolicyMode] = useState<ToolPolicyModeDto>(partner?.toolPolicyMode ?? (partner === null || partner.tools.length === 0 ? "ALL" : "CUSTOM"));
  const [codexPermissions, setCodexPermissions] = useState<CodexPermissionsDto>(partner?.codexPermissions ?? {
    approvalPolicy: "never",
    networkAccessEnabled: true,
    sandboxMode: "workspace-write",
    webSearchMode: "live",
  });
  const [modelIdOverride, setModelIdOverride] = useState(partner?.modelIdOverride ?? "");
  const [modelSourceId, setModelSourceId] = useState(partner?.modelSourceId ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptMode, setPromptMode] = useState<"APPEND" | "REPLACE">("REPLACE");
  const [promptTouched, setPromptTouched] = useState(false);
  const [promptRevealState, setPromptRevealState] = useState<"failed" | "hidden" | "loading" | "visible">("hidden");
  const [revealedPrompt, setRevealedPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "local-pi") return;
    let cancelled = false;
    const catalogKey = `${kind}:${engine}`;
    const timer = setTimeout(() => void api.engineSkills(engine)
      .then((page) => { if (!cancelled) { setSkills(page.items); setLoadedSkillCatalogKey(catalogKey); } })
      .catch(() => { if (!cancelled) { setSkills([]); setLoadedSkillCatalogKey(catalogKey); } }), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, engine, kind]);

  const handleEngineChange = (next: PartnerEngineDto) => {
    setEngine(next);
    setSelectedTools([]);
    setToolPolicyMode("ALL");
    setSelectedSkills([]);
  };

  const revealPrompt = async () => {
    if (partner === null) return;
    setPromptRevealState("loading");
    try {
      const result = await api.revealPartnerPrompt(partner.partnerId);
      setRevealedPrompt(result.prompt);
      setPromptDraft(result.prompt ?? "");
      setPromptMode("REPLACE");
      setPromptTouched(false);
      setPromptRevealState("visible");
    } catch {
      setPromptRevealState("failed");
    }
  };

  const selectPromptMode = (next: "APPEND" | "REPLACE") => {
    setPromptMode(next);
    setPromptDraft(next === "REPLACE" ? (revealedPrompt ?? "") : "");
    setPromptTouched(false);
  };

  const submitLocal = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const description = textValue(form.get("description"));
    const engineModelId = textValue(form.get("engineModelId"));
    const normalizedModelId = modelIdOverride.trim();
    const normalizedSourceId = modelSourceId.trim();
    const prompt = partner === null ? textValue(form.get("prompt")) : promptTouched ? textValue(promptDraft) : undefined;
    const fields = {
      displayName: fieldName(form.get("displayName")),
      // Always carry the engine. The registry derives it from the payload
      // (`input.engine ?? current.engine`), so omitting it for Pi core silently kept the
      // partner's previous engine: switching Codex/Claude Code back to Pi core never stuck.
      engine,
      skills: selectedSkills,
      ...(engine === "codex" ? {} : { toolPolicyMode }),
      tools: selectedTools,
      ...(engine === "codex" ? { codexPermissions } : {}),
      ...(description === undefined ? {} : { description }),
      ...(prompt === undefined ? {} : { prompt }),
    };
    try {
      if (partner === null) {
        const created = await api.createPartner({
          ...fields,
          ...(engine === "pi-core"
            ? {
              ...(normalizedModelId === "" ? {} : { modelIdOverride: normalizedModelId }),
              ...(normalizedSourceId === "" ? {} : { modelSourceId: normalizedSourceId }),
            }
            : engineModelId === undefined ? {} : { engineModelId }),
          kind: "local-pi",
        });
        onDone("搭档已登记。可以继续补充知识库，再交给 joi。", created.partnerId);
      } else {
        await api.updatePartner(partner.partnerId, {
          ...fields,
          ...(prompt === undefined ? {} : { promptMode }),
          ...(engine === "pi-core"
            ? {
              modelIdOverride: normalizedModelId === "" ? null : normalizedModelId,
              modelSourceId: normalizedSourceId === "" ? null : normalizedSourceId,
            }
            : { engineModelId: engineModelId ?? null }),
        });
        onDone("修改已保存为新的搭档 revision。", partner.partnerId);
      }
    } catch (error) { setNotice(failureMessage(error, "搭档没保存成功。")); }
  };

  const submitA2a = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const agent = await api.addAgent(fieldName(form.get("cardUrl")), fieldName(form.get("token")));
      onDone("远端搭档已登记，可以继续补充描述和知识库。", `partner_${agent.agentConnectionId}`);
    } catch (error) { setNotice(failureMessage(error, "远端搭档没登记成功。")); }
  };

  const engineStatus = engineStatuses[engine];
  const availableSkillIds = new Set(skills.map((skill) => skill.id));
  const skillsLoading = kind === "local-pi" && loadedSkillCatalogKey !== `${kind}:${engine}`;
  const invalidSelectedSkills = kind !== "local-pi" || skillsLoading ? [] : selectedSkills.filter((skill) => !availableSkillIds.has(skill));
  const missingReadForSkills = engine === "pi-core" && selectedSkills.length > 0 && toolPolicyMode === "CUSTOM" && !selectedTools.includes("read");
  const skillSelectionChanged = selectedSkills.length !== initialSelectedSkills.length
    || selectedSkills.some((skill, index) => initialSelectedSkills[index] !== skill);
  const persistedConfigurationNeedsSkillChange = partner?.configuration?.reasonCodes.some((code) => code.startsWith("partner_skill_") && code !== "partner_skill_requires_read") ?? false;
  const unchangedPersistedConfiguration = partner?.configuration?.status === "ACTION_REQUIRED"
    && persistedConfigurationNeedsSkillChange && !skillSelectionChanged && !missingReadForSkills;
  const cannotSave = (skillsLoading && selectedSkills.length > 0) || invalidSelectedSkills.length > 0 || missingReadForSkills || unchangedPersistedConfiguration;
  const skillContent = skillsLoading
    ? <small className="field-hint">正在读取当前引擎的已安装技能……</small>
    : skills.length === 0
      ? <small className="field-hint">当前引擎还没有可点选的技能。</small>
      : <div className="chip-group">{skills.map((skill) => <label className="chip" key={skill.id}><input checked={selectedSkills.includes(skill.id)} onChange={() => setSelectedSkills((current) => toggle(current, skill.id))} type="checkbox" />{skill.displayName}</label>)}</div>;
  const localEngineReason = engine !== "pi-core" && engineStatus !== undefined && !engineStatus.available ? (engineStatus.reason ?? "未检测到该本地引擎。") : null;
  const header = partner === null
    ? <header className="page-title-row"><div><p className="eyebrow">添加搭档</p><h1>这位搭档从哪里来？</h1><p>本机搭档在 joi 身边干活，远端搭档通过 A2A 协议协作。</p></div><button className="button ghost" onClick={() => onDone("已返回搭档列表。")} type="button">返回</button></header>
    : <header className="page-title-row"><div><p className="eyebrow">编辑搭档</p><h1>{partner.displayName}</h1><p>修改会登记为新的 revision；正在路上的工作仍按旧 revision 完成。</p></div><button className="button ghost" onClick={() => onDone("已返回搭档列表。")} type="button">返回</button></header>;

  return <div className="partner-editor">
    {header}
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
    {partner?.configuration?.status === "ACTION_REQUIRED" ? <p className="inline-notice warning" role="alert">{configurationMessage(partner.configuration.reasonCodes)}</p> : null}
    {partner === null ? <div className="mode-cards">
      <button aria-pressed={kind === "local-pi"} className={`mode-card ${kind === "local-pi" ? "selected" : ""}`} onClick={() => setKind("local-pi")} type="button"><strong>本地搭档</strong><span>在本机运行的搭档，joi 直接派发工作给它。</span></button>
      <button aria-pressed={kind === "a2a"} className={`mode-card ${kind === "a2a" ? "selected" : ""}`} onClick={() => setKind("a2a")} type="button"><strong>远端 A2A</strong><span>通过 Agent Card 接入的远端智能体，适合跨设备协作。</span></button>
    </div> : null}
    {partner !== null && partner.kind === "a2a" ? <p className="inline-notice info">远端搭档的能力来自 Agent Card；这里只补充 joi 的本地参考。</p> : null}
    {partner === null && kind === "a2a" ? <form className="partner-form" onSubmit={(event) => void submitA2a(event)}>
      <label>远端 Agent Card URL<input name="cardUrl" required type="url" /></label>
      <label>远端 Bearer Token<input autoComplete="off" name="token" type="password" /></label>
      <button className="button primary" type="submit">登记远端搭档</button>
    </form> : <form className="partner-form partner-editor-form" onSubmit={(event) => void submitLocal(event)}>
      <div className="tab-row" role="tablist">
        <button aria-selected={tab === "basic"} className={tab === "basic" ? "selected" : ""} onClick={() => setTab("basic")} role="tab" type="button">基础</button>
        <button aria-selected={tab === "advanced"} className={tab === "advanced" ? "selected" : ""} onClick={() => setTab("advanced")} role="tab" type="button">高级</button>
      </div>
      <div className="tab-panel" style={tab === "basic" ? undefined : { display: "none" }}>
        <div className="partner-basic-grid">
          <label>名称<input defaultValue={partner?.displayName} name="displayName" placeholder="能力聚类名称，如：编码搭档" required /></label>
          <label>描述（给 joi 做参考）<textarea defaultValue={partner?.description} name="description" placeholder="能力范围：一句话说清它擅长什么；不要重复工作区环境" rows={3} /></label>
          {partner === null ? <label>搭档提示词<textarea name="prompt" placeholder="交给它工作时附带的工作提示，仅本机保存" rows={5} /></label> : <div className="prompt-editor-field">
            <div className="prompt-editor-heading">
              <span>搭档提示词</span>
              <button className="button ghost" disabled={promptRevealState === "loading"} onClick={() => void revealPrompt()} type="button">{promptRevealState === "loading" ? "读取中…" : promptRevealState === "visible" ? "重新读取" : "查看提示词"}</button>
            </div>
            <small className="field-hint">{partner.promptConfigured ? "已配置，正文默认隐藏；查看后可替换或追加。" : "尚未配置提示词；查看后可新增。"}</small>
            {promptRevealState === "failed" ? <p className="inline-notice warning" role="alert">提示词没能读取，请重试。</p> : null}
            {promptRevealState === "visible" ? <>
              <div aria-label="提示词修改方式" className="prompt-mode-row" role="radiogroup">
                <label><input checked={promptMode === "REPLACE"} name="promptMode" onChange={() => selectPromptMode("REPLACE")} type="radio" />替换</label>
                <label><input checked={promptMode === "APPEND"} name="promptMode" onChange={() => selectPromptMode("APPEND")} type="radio" />追加</label>
              </div>
              {promptMode === "APPEND" && revealedPrompt !== null ? <label>当前提示词<textarea aria-label="当前提示词" readOnly rows={5} value={revealedPrompt} /></label> : null}
              <label>{promptMode === "APPEND" ? "追加内容" : "替换内容"}<textarea
                aria-label={promptMode === "APPEND" ? "追加内容" : "替换内容"}
                onChange={(event) => { setPromptDraft(event.target.value); setPromptTouched(true); }}
                placeholder={promptMode === "APPEND" ? "输入要追加到当前提示词末尾的内容" : "输入完整的新提示词"}
                rows={6}
                value={promptDraft}
              /></label>
              <small className="field-hint">{promptMode === "APPEND" ? "保存后会用一个空行连接当前提示词与追加内容。" : "保存后会以这里的完整内容替换当前提示词。未改动则保持原内容。"}</small>
            </> : null}
          </div>}
        </div>
        <div className="kb-field"><span className="kb-field-label">知识库</span>{partner !== null && partner.kind === "local-pi" ? <KnowledgeDocList api={api} onChanged={() => undefined} partnerId={partner.partnerId} /> : <small>保存搭档后即可附加 md 文档。</small>}</div>
        <div className="skill-field"><span className="kb-field-label">技能（可选；按引擎扫描本机已安装技能）</span>
          <small className="field-hint">不勾选表示不向搭档挂载 skill。</small>
          {invalidSelectedSkills.length > 0 ? <div className="inline-notice warning" role="alert">
            <span>{configurationMessage(["partner_skill_ref_invalid"])} 先移除失效引用：</span>
            <div className="chip-group">{invalidSelectedSkills.map((skill) => <button className="chip" key={skill} onClick={() => setSelectedSkills((current) => current.filter((item) => item !== skill))} type="button">{skill} ×</button>)}</div>
          </div> : null}
          {skillContent}
        </div>
        <button className="button primary" disabled={cannotSave} type="submit">{partner === null ? "保存搭档" : "保存修改"}</button>
      </div>
      <div className="tab-panel" style={tab === "advanced" ? undefined : { display: "none" }}>
        <label>搭档引擎<select name="engine" onChange={(event) => handleEngineChange(event.target.value as PartnerEngineDto)} value={engine}>
          {ENGINE_ORDER.map((id) => { const status = engineStatuses[id]; const suffix = id === "pi-core" ? "" : status === undefined ? "" : status.available ? "（已检测到）" : "（未检测到）"; return <option key={id} value={id}>{ENGINE_LABELS[id]}{suffix}</option>; })}
        </select></label>
        {localEngineReason === null ? null : <p className="inline-notice warning" role="status">{localEngineReason} 按提示完成本机配置后即可使用，或改回 Pi core。</p>}
        {engine === "pi-core" ? <>
          <label>模型名<input name="modelIdOverride" onChange={(event) => setModelIdOverride(event.target.value)} placeholder="留空使用全局首选模型" value={modelIdOverride} /></label>
          <label>供应商<span className="picker-field"><select name="modelSourceId" onChange={(event) => {
            const nextSourceId = event.target.value;
            setModelSourceId(nextSourceId);
            const selected = sources.find((source) => source.sourceId === nextSourceId);
            setModelIdOverride(selected?.activeModel.id ?? "");
          }} value={modelSourceId}><option value="">跟随全局首选大模型网络</option>{sources.map((source) => <option disabled={source.status !== "READY"} key={source.sourceId} value={source.sourceId}>{source.displayName}（{source.kind}）{source.status === "READY" ? "" : " · 未就绪"}</option>)}</select><button className="button ghost" onClick={() => onManageProviders?.()} type="button">管理大模型网络</button></span></label>
        </> : <>
          <label>模型名（可选覆盖）<input defaultValue={partner?.engineModelId} name="engineModelId" placeholder="留空使用本机 Claude/Codex 自己的配置" /></label>
          <p className="field-hint">{engine === "claude-code"
            ? "Claude Code 使用本机 Claude 的配置与认证，并调用你安装的 Claude 可执行文件。保存后可测试可用性。"
            : "Codex 使用你本机 Codex CLI 的登录与配置；模型名会原样传递。"}</p>
        </>}
        {engine === "codex" ? <div className="tool-field"><span className="kb-field-label">Codex 权限</span>
          <label>工作区权限<select aria-label="Codex 工作区权限" onChange={(event) => setCodexPermissions((current) => ({ ...current, sandboxMode: event.target.value as CodexPermissionsDto["sandboxMode"] }))} value={codexPermissions.sandboxMode}>
            <option value="workspace-write">可写工作区</option><option value="read-only">只读</option>
          </select></label>
          <label>网页搜索<select aria-label="Codex 网页搜索" onChange={(event) => setCodexPermissions((current) => ({ ...current, webSearchMode: event.target.value as CodexPermissionsDto["webSearchMode"] }))} value={codexPermissions.webSearchMode}>
            <option value="disabled">关闭</option><option value="cached">缓存结果</option><option value="live">实时搜索</option>
          </select></label>
          <label className="tool-choice"><input checked={codexPermissions.networkAccessEnabled} onChange={(event) => setCodexPermissions((current) => ({ ...current, networkAccessEnabled: event.target.checked }))} type="checkbox" /><span>允许网络访问</span></label>
          <small className="field-hint">审批策略固定为 never；不提供 danger-full-access。</small>
        </div> : <div className="tool-field"><span className="kb-field-label">工具权限</span>
          <div className="button-row"><button className="button ghost" onClick={() => { setToolPolicyMode("ALL"); setSelectedTools([]); }} type="button">全部开启</button><button className="button ghost" onClick={() => { setToolPolicyMode("CUSTOM"); setSelectedTools([]); }} type="button">全部关闭</button></div>
          {(engineStatus?.tools.length ?? 0) === 0 ? <small className="field-hint">该引擎暂无可选工具。</small> : <div aria-label="工具白名单" className="tool-choice-grid" role="group">{(engineStatus?.tools ?? []).map((tool) => <label className="tool-choice" key={tool}><input checked={toolPolicyMode === "ALL" || selectedTools.includes(tool)} onChange={() => {
            if (toolPolicyMode === "ALL") {
              setToolPolicyMode("CUSTOM");
              setSelectedTools((engineStatus?.tools ?? []).filter((candidate) => candidate !== tool));
            } else setSelectedTools((current) => toggle(current, tool));
          }} type="checkbox" /><span>{tool}</span></label>)}</div>}
          <small className="field-hint">{toolPolicyMode === "ALL" ? "全部工具已开启。关闭任意工具会切换为自定义权限。" : `自定义权限：已开启 ${String(selectedTools.length)} 项。`}</small>
        </div>}
        {missingReadForSkills ? <p className="inline-notice warning" role="alert">已选择 Skill 且收窄了工具白名单，请启用 read 后再保存。</p> : null}
        <button className="button primary" disabled={cannotSave} type="submit">{partner === null ? "保存搭档" : "保存修改"}</button>
      </div>
    </form>}
  </div>;
}

function ScenarioGrid({ api }: { api: DigitalLifeApi }) {
  const [packs, setPacks] = useState<ScenarioPackDto[]>([]);
  const [expandedPackId, setExpandedPackId] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [packNotice, setPackNotice] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "failed">("loading");
  const loadPacks = useCallback(async () => {
    try {
      setPacks((await api.scenarioPacks()).items);
      setCatalogState("ready");
    } catch {
      setPacks([]);
      setCatalogState("failed");
    }
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => void loadPacks(), 0);
    return () => clearTimeout(timer);
  }, [loadPacks]);
  const install = (packId: string, teamIds?: string[]) => {
    const key = teamIds?.[0] ?? "full";
    setInstalling(`${packId}:${key}`);
    setPackNotice(null);
    void api.installScenarioPack(packId, teamIds).then(async (result) => {
      const created = result.outcomes.filter((item) => item.outcome === "CREATED").length;
      const reused = result.outcomes.filter((item) => item.outcome === "REUSED").length;
      const actionRequired = result.outcomes.filter((item) => item.outcome === "ACTION_REQUIRED").length;
      setPackNotice(`预设包已处理：新建 ${String(created)} 位，复用 ${String(reused)} 位${actionRequired === 0 ? "" : `，${String(actionRequired)} 位需要处理`}。`);
      await loadPacks();
    }).catch((error: unknown) => setPackNotice(failureMessage(error, "预设包没安装成功，请稍后重试。")))
      .finally(() => setInstalling(null));
  };
  if (catalogState === "loading") return <div aria-label="正在读取场景套件" className="scenario-pack-loading"><span /><span /><span /></div>;
  if (catalogState === "failed") return <p className="inline-notice warning" role="alert">场景套件没能读取，请稍后重试。</p>;
  if (packs.length === 0) return <div className="plain-empty"><h2>还没有场景套件</h2><p>你仍可手动添加搭档；套件目录恢复后会显示在这里。</p></div>;
  return <div className="scenario-catalog">
    <section aria-label="场景套件" className="scenario-pack-group">
      {packNotice === null ? null : <p className="inline-notice info" role="status">{packNotice}</p>}
      {packs.map((pack) => {
        const expanded = expandedPackId === pack.id;
        const fullKey = `${pack.id}:full`;
        return <article className="scenario-pack" key={pack.id}>
          <button aria-expanded={expanded} className="scenario-pack-summary" onClick={() => setExpandedPackId(expanded ? null : pack.id)} type="button">
            <span><strong>{pack.title}</strong><small>{pack.blurb}</small></span>
            <span className={`scenario-pack-state ${pack.status.toLowerCase()}`}>{pack.totalRoleCount === 0 ? "暂无可用项" : `${String(pack.installedRoleCount)}/${String(pack.totalRoleCount)} 位`} · {packStatusLabel(pack.status)}</span>
          </button>
          {expanded ? <div className="scenario-pack-body">
            <div className="scenario-pack-meta"><span>来源 {pack.source.repository}@{pack.source.revision}</span><span>{pack.source.license}</span></div>
            {pack.teams.length === 0 ? <div className="scenario-pack-empty"><strong>还没有可安装的 Skill</strong><p>在本机安装 Skill 后重新打开此页，最近使用的能力会自动出现在这里。</p></div> : <div className="scenario-team-grid">{pack.teams.map((team) => {
              const teamKey = `${pack.id}:${team.id}`;
              return <article className="scenario-team" key={team.id}>
                <div><strong>{team.title}</strong><p>{team.blurb}</p></div>
                <div aria-label={`${team.title} 搭档`} className="scenario-role-list">{team.roles.map((role) => <span className="scenario-role" key={role.id} title={role.reasonCode}><span>{role.title}</span><small className={`role-state ${role.status.toLowerCase()}`}>{roleStateLabel(role.status)}</small></span>)}</div>
                <button className="button ghost" disabled={installing !== null} onClick={() => install(pack.id, [team.id])} type="button">{installing === teamKey ? "安装中…" : `安装${team.title}`}</button>
              </article>;
            })}</div>}
            <button className="button primary" disabled={installing !== null || pack.totalRoleCount === 0} onClick={() => install(pack.id)} type="button">{installing === fullKey ? "安装中…" : pack.totalRoleCount === 0 ? "暂无可安装项" : "安装完整套件"}</button>
          </div> : null}
        </article>;
      })}
    </section>
  </div>;
}

function packStatusLabel(status: ScenarioPackDto["status"]): string {
  if (status === "NOT_INSTALLED") return "未安装";
  if (status === "ACTIVE") return "已启用";
  if (status === "OUTDATED") return "有更新";
  return "需要处理";
}

function roleStateLabel(status: ScenarioPackRoleStateDto): string {
  if (status === "NOT_INSTALLED") return "未安装";
  if (status === "ACTIVE") return "已启用";
  if (status === "DISABLED") return "已停用";
  if (status === "OUTDATED") return "有更新";
  return "需要处理";
}

export function PartnerPage({ api, onManageProviders, tab, onTabChange }: { api: DigitalLifeApi; onManageProviders?: () => void; tab?: "partners" | "scenarios"; onTabChange?: (tab: "partners" | "scenarios") => void }) {
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [sources, setSources] = useState<ModelSourceDto[]>([]);
  const [engineStatuses, setEngineStatuses] = useState<Record<string, EngineStatus>>({});
  const [view, setView] = useState<PartnerView>({ mode: "grid" });
  const [notice, setNotice] = useState<string | null>(null);
  const [modelTests, setModelTests] = useState<Record<string, PartnerModelTestDto | "TESTING">>({});
  const load = useCallback(async () => {
    const [partnerPage, sourcePage, enginePage] = await Promise.all([
      api.listPartners(),
      api.listModelSources(),
      api.engineCatalog().catch(() => null),
    ]);
    setPartners(partnerPage.items);
    setSources(sourcePage.items);
    const statuses: Record<string, EngineStatus> = {};
    for (const item of enginePage?.items ?? []) statuses[item.id] = { available: item.available, tools: item.tools, ...(item.reason === undefined ? {} : { reason: item.reason }) };
    setEngineStatuses(statuses);
    return partnerPage.items;
  }, [api]);
  useEffect(() => { const timer = setTimeout(() => void load().catch(() => setNotice("没能读取统一搭档目录。")), 0); return () => clearTimeout(timer); }, [load]);
  const finishEdit = (message: string, partnerId?: string) => {
    setNotice(message);
    if (partnerId === undefined) { setView({ mode: "grid" }); return; }
    void load().then((items) => {
      const target = items.find((item) => item.partnerId === partnerId);
      setView(target === undefined ? { mode: "grid" } : { mode: "editor", partner: target });
    }).catch(() => setView({ mode: "grid" }));
  };
  const currentTab = tab ?? "partners";
  const testPartnerModel = (partnerId: string) => {
    setModelTests((current) => ({ ...current, [partnerId]: "TESTING" }));
    void api.testPartnerModel(partnerId)
      .then((result) => setModelTests((current) => ({ ...current, [partnerId]: result })))
      .catch(() => setModelTests((current) => ({
        ...current,
        [partnerId]: { partnerId, reasonCode: "partner_model_test_failed", status: "FAILED", testedAt: new Date().toISOString() },
      })));
  };
  if (view.mode === "editor") {
    return <section className="partner-manager page-section">
      <PartnerEditor api={api} engineStatuses={engineStatuses} key={view.partner?.partnerRevisionId ?? "new"} onDone={finishEdit} {...(onManageProviders === undefined ? {} : { onManageProviders })} partner={view.partner} sources={sources} />
    </section>;
  }
  return <section className="partner-manager page-section">
    <header className="page-title-row"><div><p className="eyebrow">joi 的统一搭档目录</p><h1>搭档</h1><p>按套件组建一支可复用的协作团队，或手动登记搭档的描述、提示词与知识库。</p></div><button className="button primary" onClick={() => { setNotice(null); setView({ mode: "editor", partner: null }); }} type="button">添加搭档</button></header>
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
    <div className="tab-row" role="tablist">
      <button aria-selected={currentTab === "scenarios"} className={currentTab === "scenarios" ? "selected" : ""} onClick={() => onTabChange?.("scenarios")} role="tab" type="button">场景预设</button>
      <button aria-selected={currentTab === "partners"} className={currentTab === "partners" ? "selected" : ""} onClick={() => onTabChange?.("partners")} role="tab" type="button">搭档目录</button>
    </div>
    {currentTab === "scenarios" ? <>
      <p className="field-hint">展开套件后可安装一个子团队，也可一次安装完整套件。重复安装会复用现有搭档，不覆盖你的修改。</p>
      <ScenarioGrid api={api} />
    </> : <>
      {partners.length === 0 ? <div className="plain-empty"><h2>还没有搭档</h2><p>先建立 2-3 个工作搭档（本机或远端 A2A），joi 才能把你的想法派出去；也可以切到上方「场景预设」一键组建团队。</p><button className="button primary" onClick={() => setView({ mode: "editor", partner: null })} type="button">添加第一个搭档</button></div> : null}
      {partners.length > 0 && partners.length < 2 ? <p className="inline-notice warning">建议先建立 2-3 个工作搭档，joi 才有得挑、有得换；也可切到「场景预设」一键组建。</p> : null}
      <div className="partner-grid">{partners.map((partner) => <article className="partner-card" key={partner.partnerId}>
        <div className="partner-card-head"><strong>{partner.displayName}</strong>{partner.createdBy === "joi" ? <span className="badge-joi">joi 创建</span> : null}<span className="engine-badge">{partner.kind === "local-pi" ? "本机" : "远端 A2A"} · {ENGINE_LABELS[partner.engine]}</span></div>
        {partner.description === undefined ? <p className="partner-card-desc muted">还没有描述。补一句，joi 才知道什么时候该找它。</p> : <p className="partner-card-desc">{partner.description}</p>}
        {partner.configuration?.status === "ACTION_REQUIRED" ? <p className="inline-notice warning" role="alert">{configurationMessage(partner.configuration.reasonCodes)}</p> : null}
        <small>{[...partner.skills, ...partner.capabilities].join(" · ") || "尚未声明能力"}{partner.knowledgeDocCount > 0 ? ` · ${String(partner.knowledgeDocCount)} 篇知识库` : ""}</small>
        {partner.status === "DISABLED" && partner.inFlightCount > 0 ? <small>正在排空 {String(partner.inFlightCount)} 项在途工作</small> : null}
        {partner.kind === "local-pi" ? <PartnerModelStatus engine={partner.engine} result={modelTests[partner.partnerId] ?? (partner.engine === "pi-core" ? persistedModelTest(partner, sources) : undefined)} /> : null}
        <div className="partner-card-actions">
          <label className="switch"><input aria-label={`启用或停用 ${partner.displayName}`} checked={partner.status === "ACTIVE"} onChange={() => void api.setPartnerEnabled(partner.partnerId, partner.status !== "ACTIVE").then(() => load()).catch(() => setNotice("搭档状态没切成。"))} type="checkbox" /><span>{partner.status === "ACTIVE" ? "已启用" : "已停用"}</span></label>
          <button className="button ghost" onClick={() => void api.duplicatePartner(partner.partnerId).then(() => load()).then(() => setNotice("已基于这个搭档复制出新搭档。")).catch(() => setNotice("搭档没能复制。"))} type="button">复制</button>
          {partner.kind === "local-pi" ? <button className="button ghost" disabled={modelTests[partner.partnerId] === "TESTING"} onClick={() => testPartnerModel(partner.partnerId)} type="button">{partner.engine === "pi-core" ? "测试模型" : "测试可用性"}</button> : null}
          <button className="button ghost" onClick={() => { setNotice(null); setView({ mode: "editor", partner }); }} type="button">编辑</button>
          {partner.status === "DISABLED" ? <button className="button danger-text" disabled={partner.inFlightCount > 0} onClick={() => void api.deletePartner(partner.partnerId).then(() => load()).catch(() => setNotice("搭档还不能删除。"))} type="button">删除搭档</button> : null}
        </div>
      </article>)}</div>
    </>}
  </section>;
}
