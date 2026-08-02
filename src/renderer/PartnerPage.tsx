import { type ChangeEvent, type SyntheticEvent, useCallback, useEffect, useState } from "react";

import type { ModelSourceDto, PartnerDto, PartnerEngineDto, PartnerKnowledgeDocDto, ScenarioDto } from "../shared/joi";
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
  const [selectedSkills, setSelectedSkills] = useState<string[]>(partner?.skills ?? []);
  const [selectedTools, setSelectedTools] = useState<string[]>(partner?.tools ?? []);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "local-pi") return;
    let cancelled = false;
    const timer = setTimeout(() => void api.engineSkills(engine).then((page) => { if (!cancelled) setSkills(page.items); }).catch(() => { if (!cancelled) setSkills([]); }), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, engine, kind]);

  const handleEngineChange = (next: PartnerEngineDto) => {
    setEngine(next);
    setSelectedTools([]);
    setSelectedSkills([]);
  };

  const submitLocal = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const description = textValue(form.get("description"));
    const engineModelId = textValue(form.get("engineModelId"));
    const modelIdOverride = textValue(form.get("modelIdOverride"));
    const modelSourceId = textValue(form.get("modelSourceId"));
    const prompt = textValue(form.get("prompt"));
    const fields = {
      displayName: fieldName(form.get("displayName")),
      skills: selectedSkills,
      tools: selectedTools,
      ...(description === undefined ? {} : { description }),
      ...(engine === "pi-core" ? {} : { engine }),
      ...(engine === "pi-core" ? (modelIdOverride === undefined ? {} : { modelIdOverride }) : (engineModelId === undefined ? {} : { engineModelId })),
      ...(engine === "pi-core" ? (modelSourceId === undefined ? {} : { modelSourceId }) : {}),
      ...(prompt === undefined ? {} : { prompt }),
    };
    try {
      if (partner === null) {
        const created = await api.createPartner({ ...fields, kind: "local-pi" });
        onDone("搭档已登记。可以继续补充知识库，再交给 joi。", created.partnerId);
      } else {
        await api.updatePartner(partner.partnerId, fields);
        onDone("修改已保存为新的搭档 revision。");
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
  const localEngineReason = engine !== "pi-core" && engineStatus !== undefined && !engineStatus.available ? (engineStatus.reason ?? "未检测到该本地引擎。") : null;
  const header = partner === null
    ? <header className="page-title-row"><div><p className="eyebrow">添加搭档</p><h1>这位搭档从哪里来？</h1><p>本机搭档在 joi 身边干活，远端搭档通过 A2A 协议协作。</p></div><button className="button ghost" onClick={() => onDone("已返回搭档列表。")} type="button">返回</button></header>
    : <header className="page-title-row"><div><p className="eyebrow">编辑搭档</p><h1>{partner.displayName}</h1><p>修改会登记为新的 revision；正在路上的工作仍按旧 revision 完成。</p></div><button className="button ghost" onClick={() => onDone("已返回搭档列表。")} type="button">返回</button></header>;

  return <div className="partner-editor">
    {header}
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
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
          <label>名称<input defaultValue={partner?.displayName} name="displayName" required /></label>
          <label>描述（给 joi 做参考）<textarea defaultValue={partner?.description} name="description" placeholder="一句话说清它擅长什么、什么时候该找它" rows={3} /></label>
          <label>搭档提示词<textarea name="prompt" placeholder={partner === null ? "交给它工作时附带的工作提示，仅本机保存" : "留空保持当前提示词"} rows={3} /></label>
        </div>
        <div className="kb-field"><span className="kb-field-label">知识库</span>{partner !== null && partner.kind === "local-pi" ? <KnowledgeDocList api={api} onChanged={() => undefined} partnerId={partner.partnerId} /> : <small>保存搭档后即可附加 md 文档。</small>}</div>
        <div className="skill-field"><span className="kb-field-label">技能（点选，按引擎扫描本机已安装技能）</span>
          {skills.length === 0 ? <small className="field-hint">当前引擎还没有可点选的技能。</small> : <div className="chip-group">{skills.map((skill) => <label className="chip" key={skill.id}><input checked={selectedSkills.includes(skill.id)} onChange={() => setSelectedSkills((current) => toggle(current, skill.id))} type="checkbox" />{skill.displayName}</label>)}</div>}
        </div>
        <button className="button primary" type="submit">{partner === null ? "保存搭档" : "保存修改"}</button>
      </div>
      <div className="tab-panel" style={tab === "advanced" ? undefined : { display: "none" }}>
        <label>搭档引擎<select name="engine" onChange={(event) => handleEngineChange(event.target.value as PartnerEngineDto)} value={engine}>
          {ENGINE_ORDER.map((id) => { const status = engineStatuses[id]; const suffix = id === "pi-core" ? "" : status === undefined ? "" : status.available ? "（已检测到）" : "（未检测到）"; return <option key={id} value={id}>{ENGINE_LABELS[id]}{suffix}</option>; })}
        </select></label>
        {localEngineReason === null ? null : <p className="inline-notice warning" role="status">{localEngineReason} 安装并登录后即可使用，或改回 Pi core。</p>}
        {engine === "pi-core" ? <>
          <label>模型名<input defaultValue={partner?.modelIdOverride} name="modelIdOverride" placeholder="留空使用全局首选模型" /></label>
          <label>供应商<span className="picker-field"><select defaultValue={partner?.modelSourceId ?? ""} name="modelSourceId"><option value="">跟随全局首选大模型网络</option>{sources.map((source) => <option key={source.sourceId} value={source.sourceId}>{source.displayName}（{source.kind}）</option>)}</select><button className="button ghost" onClick={() => onManageProviders?.()} type="button">管理大模型网络</button></span></label>
        </> : <>
          <label>模型名（可选覆盖）<input defaultValue={partner?.engineModelId} name="engineModelId" placeholder="留空使用本机 Claude/Codex 自己的配置" /></label>
          <p className="field-hint">本地 {ENGINE_LABELS[engine]} 使用你本机的登录、转发或订阅配置运行，joi 不注入密钥。</p>
        </>}
        <div className="tool-field"><span className="kb-field-label">工具白名单（不勾选 = 不限制）</span>
          {(engineStatus?.tools.length ?? 0) === 0 ? <small className="field-hint">该引擎暂无可选工具。</small> : <div className="chip-group">{(engineStatus?.tools ?? []).map((tool) => <label className="chip" key={tool}><input checked={selectedTools.includes(tool)} onChange={() => setSelectedTools((current) => toggle(current, tool))} type="checkbox" />{tool}</label>)}</div>}
        </div>
        <button className="button primary" type="submit">{partner === null ? "保存搭档" : "保存修改"}</button>
      </div>
    </form>}
  </div>;
}

function ScenarioGrid({ api, onPick }: { api: DigitalLifeApi; onPick: (scenario: ScenarioDto) => void }) {
  const [scenarios, setScenarios] = useState<ScenarioDto[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => void api.scenarios().then((page) => setScenarios(page.items)).catch(() => setScenarios([])), 0);
    return () => clearTimeout(timer);
  }, [api]);
  if (scenarios.length === 0) return <p className="field-hint">还没有可用的场景预设。</p>;
  return <div className="scenario-group">{scenarios.map((scenario) => <button className="scenario-card" key={scenario.id} onClick={() => onPick(scenario)} type="button"><strong>{scenario.title}</strong><span>{scenario.blurb}</span></button>)}</div>;
}

export function PartnerPage({ api, onManageProviders, onNavigate, tab, onTabChange }: { api: DigitalLifeApi; onManageProviders?: () => void; onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void; tab?: "partners" | "scenarios"; onTabChange?: (tab: "partners" | "scenarios") => void }) {
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [sources, setSources] = useState<ModelSourceDto[]>([]);
  const [engineStatuses, setEngineStatuses] = useState<Record<string, EngineStatus>>({});
  const [view, setView] = useState<PartnerView>({ mode: "grid" });
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [partnerPage, sourcePage, enginePage] = await Promise.all([
      api.listPartners(),
      api.listModelSources(),
      api.engineCatalog().catch(() => null),
    ]);
    setPartners(partnerPage.items);
    setSources(sourcePage.items.filter((source) => source.status === "READY"));
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
  const pickScenario = (scenario: ScenarioDto) => {
    setNotice(null);
    void api.sendJoiMessage(scenario.prompt)
      .then(() => { setNotice(`已把「${scenario.title}」交给 joi，正在组建团队…`); onNavigate?.("joi"); })
      .catch(() => setNotice("场景没发送成功，请重试。"));
  };
  if (view.mode === "editor") {
    return <section className="partner-manager page-section">
      <PartnerEditor api={api} engineStatuses={engineStatuses} onDone={finishEdit} {...(onManageProviders === undefined ? {} : { onManageProviders })} partner={view.partner} sources={sources} />
    </section>;
  }
  return <section className="partner-manager page-section">
    <header className="page-title-row"><div><p className="eyebrow">joi 的统一搭档目录</p><h1>搭档</h1><p>用场景预设一键组建团队，或手动登记搭档的描述、提示词、知识库和工作路径。</p></div><button className="button primary" onClick={() => { setNotice(null); setView({ mode: "editor", partner: null }); }} type="button">添加搭档</button></header>
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
    <div className="tab-row" role="tablist">
      <button aria-selected={currentTab === "scenarios"} className={currentTab === "scenarios" ? "selected" : ""} onClick={() => onTabChange?.("scenarios")} role="tab" type="button">场景预设</button>
      <button aria-selected={currentTab === "partners"} className={currentTab === "partners" ? "selected" : ""} onClick={() => onTabChange?.("partners")} role="tab" type="button">搭档目录</button>
    </div>
    {currentTab === "scenarios" ? <>
      <p className="field-hint">选一个场景，joi 会据此判断要创建哪几位搭档、各自职责与默认提示词，并挑选合适的模型源（引擎用 Pi core）。点击即交给 joi，无需补充。</p>
      <ScenarioGrid api={api} onPick={pickScenario} />
    </> : <>
      {partners.length === 0 ? <div className="plain-empty"><h2>还没有搭档</h2><p>先建立 2-3 个工作搭档（本机或远端 A2A），joi 才能把你的想法派出去；也可以切到上方「场景预设」一键组建团队。</p><button className="button primary" onClick={() => setView({ mode: "editor", partner: null })} type="button">添加第一个搭档</button></div> : null}
      {partners.length > 0 && partners.length < 2 ? <p className="inline-notice warning">建议先建立 2-3 个工作搭档，joi 才有得挑、有得换；也可切到「场景预设」一键组建。</p> : null}
      <div className="partner-grid">{partners.map((partner) => <article className="partner-card" key={partner.partnerId}>
        <div className="partner-card-head"><strong>{partner.displayName}</strong>{partner.createdBy === "joi" ? <span className="badge-joi">joi 创建</span> : null}<span className="engine-badge">{partner.kind === "local-pi" ? "本机" : "远端 A2A"} · {ENGINE_LABELS[partner.engine]}</span></div>
        {partner.description === undefined ? <p className="partner-card-desc muted">还没有描述。补一句，joi 才知道什么时候该找它。</p> : <p className="partner-card-desc">{partner.description}</p>}
        <small>{[...partner.skills, ...partner.capabilities].join(" · ") || "尚未声明能力"}{partner.knowledgeDocCount > 0 ? ` · ${String(partner.knowledgeDocCount)} 篇知识库` : ""}</small>
        {partner.status === "DISABLED" && partner.inFlightCount > 0 ? <small>正在排空 {String(partner.inFlightCount)} 项在途工作</small> : null}
        <div className="partner-card-actions">
          <label className="switch"><input aria-label={`启用或停用 ${partner.displayName}`} checked={partner.status === "ACTIVE"} onChange={() => void api.setPartnerEnabled(partner.partnerId, partner.status !== "ACTIVE").then(() => load()).catch(() => setNotice("搭档状态没切成。"))} type="checkbox" /><span>{partner.status === "ACTIVE" ? "已启用" : "已停用"}</span></label>
          <button className="button ghost" onClick={() => void api.duplicatePartner(partner.partnerId).then(() => load()).then(() => setNotice("已基于这个搭档复制出新搭档。")).catch(() => setNotice("搭档没能复制。"))} type="button">复制</button>
          <button className="button ghost" onClick={() => { setNotice(null); setView({ mode: "editor", partner }); }} type="button">编辑</button>
          {partner.status === "DISABLED" ? <button className="button danger-text" disabled={partner.inFlightCount > 0} onClick={() => void api.deletePartner(partner.partnerId).then(() => load()).catch(() => setNotice("搭档还不能删除。"))} type="button">删除搭档</button> : null}
        </div>
      </article>)}</div>
    </>}
  </section>;
}
