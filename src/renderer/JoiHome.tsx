import { type SyntheticEvent, useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { MODEL_SOURCE_CHOICES, type AgentConversationPageDto, type AvatarAgentCardDto, type AvatarDetailDto, type AvatarDto, type JoiAcceptedMessageDto, type JoiGoalCardDto, type JoiHomeFeedDto, type JoiSnapshotDto, type ModelSourceAccessModeDto, type ModelSourceKindDto, type ModelSourceProtocolDto } from "../shared/joi";
import { ApiError, type DigitalLifeApi } from "./api";

export function ModelSourceSetup({ api, changed }: { api: DigitalLifeApi; changed: () => Promise<void> }) {
  const [selected, setSelected] = useState<ModelSourceKindDto | null>(null);
  const [selectedAccessMode, setSelectedAccessMode] = useState<ModelSourceAccessModeDto | null>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<ModelSourceProtocolDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null || selectedAccessMode === null || selectedProtocol === null) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => {
      const field = form.get(key);
      return typeof field === "string" ? field : "";
    };
    setBusy(true); setNotice("正在检查连接，这可能产生极少量模型费用…");
    try {
      const source = await api.createModelSource({
        accessMode: selectedAccessMode,
        apiKey: value("apiKey"),
        kind: selected,
        protocol: selectedProtocol,
        ...(selected === "generic-openai" ? {
          baseUrl: value("baseUrl"), displayName: value("displayName"), modelId: value("modelId"),
        } : value("modelId").trim() === "" ? {} : { modelId: value("modelId") }),
      });
      const validated = await api.validateModelSource(source.sourceId);
      setNotice(validated.status === "READY" ? "已连接，joi 可以开始思考了。" : modelSourceReasonText(validated.reasonCode));
      await changed();
      if (validated.status === "READY") { setSelected(null); setSelectedAccessMode(null); setSelectedProtocol(null); }
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "连接没检查成功，草稿仍可稍后重试。");
    } finally {
      setBusy(false);
    }
  };
  const selectedChoice = MODEL_SOURCE_CHOICES.find((choice) => choice.kind === selected);
  const selectedOption = selectedChoice?.options.find((option) => option.accessMode === selectedAccessMode);
  const chooseProvider = (kind: ModelSourceKindDto) => {
    const choice = MODEL_SOURCE_CHOICES.find((candidate) => candidate.kind === kind);
    const defaultAccessMode = choice?.options.length === 1 ? choice.options[0].accessMode : null;
    const defaultProtocol = choice?.options.length === 1 && choice.options[0].protocols.length === 1
      ? choice.options[0].protocols[0].protocol
      : null;
    setSelected(kind);
    setSelectedAccessMode(defaultAccessMode);
    setSelectedProtocol(defaultProtocol);
    setNotice(null);
  };
  const chooseAccessMode = (accessMode: ModelSourceAccessModeDto) => {
    const option = selectedChoice?.options.find((candidate) => candidate.accessMode === accessMode);
    setSelectedAccessMode(accessMode);
    setSelectedProtocol(option?.protocols.length === 1 ? option.protocols[0].protocol : null);
  };
  const cancel = () => { setSelected(null); setSelectedAccessMode(null); setSelectedProtocol(null); setNotice(null); };
  return <section className="joi-network-gate" aria-labelledby="joi-network-title">
    <p className="eyebrow">第一次见面</p>
    <h1 id="joi-network-title">joi需要链接到大模型网络</h1>
    <p>选一个你已有账号的主流模型网络。密钥加密保存在本机，不会在页面再次显示。</p>
    <div className="model-source-choices">{MODEL_SOURCE_CHOICES.map((choice) => <button className={selected === choice.kind ? "selected" : ""} key={choice.kind} onClick={() => chooseProvider(choice.kind)} type="button">连接 {choice.label}</button>)}</div>
    {selectedChoice !== undefined && selectedAccessMode === null ? <section className="model-source-access-picker" aria-label={`${selectedChoice.label} 接入方案`}>
      <h2>{selectedChoice.label} 的接入方案</h2>
      <div className="model-source-access-choices">{selectedChoice.options.map((option) => <button aria-label={option.label} key={option.accessMode} onClick={() => chooseAccessMode(option.accessMode)} type="button"><strong>{option.label}</strong><span>{option.description}</span></button>)}</div>
      <button className="button ghost" onClick={cancel} type="button">取消</button>
    </section> : null}
    {selectedOption !== undefined && selectedProtocol === null ? <section className="model-source-protocol-picker" aria-label={`${selectedOption.label} 接口协议`}>
      <h2>{selectedOption.label} 的接口协议</h2>
      <div className="model-source-protocol-choices">{selectedOption.protocols.map((option) => <button aria-label={option.label} key={option.protocol} onClick={() => setSelectedProtocol(option.protocol)} type="button"><strong>{option.label}</strong><span>{option.description}</span></button>)}</div>
      <button className="button ghost" onClick={cancel} type="button">取消</button>
    </section> : null}
    {selected !== null && selectedAccessMode !== null && selectedProtocol !== null ? <form className="model-source-form" onSubmit={(event) => void submit(event)}>
      <h2>{selectedOption?.label ?? selectedChoice?.label} · {protocolLabel(selectedProtocol)}</h2>
      {selectedAccessMode === "coding-plan" || selectedAccessMode === "token-plan" ? <p className="inline-notice warning">订阅套餐仅适合个人交互使用，请确认你的使用符合厂商条款。</p> : null}
      {selected === "kimi" && selectedAccessMode === "coding-plan" ? <p className="model-source-hint">K3 的 Model ID 是 k3，不是 kimi-k3；留空则使用所有会员可用的 kimi-for-coding。</p> : null}
      {selected === "generic-openai" ? <>
        <label>显示名称<input name="displayName" required /></label>
        <label>Base URL<input name="baseUrl" placeholder="https://api.example.com/v1" required type="url" /></label>
        <label>Model ID<input name="modelId" required /></label>
      </> : <label>Model ID（可选，高级设置）<input name="modelId" placeholder="留空使用推荐模型" /></label>}
      <label>API Key{selected === "generic-openai" ? "（本机 localhost 可留空）" : ""}<input autoComplete="off" name="apiKey" required={selected !== "generic-openai"} type="password" /></label>
      <div className="row-actions"><button className="button primary" disabled={busy} type="submit">{busy ? "正在检查…" : "保存并验证"}</button><button className="button ghost" onClick={cancel} type="button">取消</button></div>
    </form> : null}
    {notice === null ? null : <p className="inline-notice info" role="status">{notice}</p>}
  </section>;
}

function modelSourceReasonText(reasonCode: string | undefined): string {
  if (reasonCode === "auth_failed") return "API Key 与所选接入方案不匹配，或没有访问权限。请确认 Key 和套餐类型后再验证。";
  if (reasonCode === "rate_limited") return "接口限流或超载，请稍后重试或检查套餐额度。";
  if (reasonCode === "model_unavailable") return "所选接口找不到这个 Model ID。请留空使用推荐模型，或填写该套餐支持的模型。";
  if (reasonCode === "server_error") return "接口返回服务端错误（5xx），服务可能暂时不可用，请稍后重试。";
  if (reasonCode === "not_found") return "接口地址或资源不存在（404），请确认接入方案/协议与该套餐匹配。";
  if (reasonCode === "bad_request") return "接口拒绝了请求参数（400），请检查 Model ID 与协议是否与该套餐匹配。";
  if (reasonCode === "connection_error") return "无法连通所选接口（DNS/连接/TLS 失败），请检查网络、代理与接口可用性。";
  if (reasonCode === "timeout") return "连接所选接口超时，请检查网络或稍后重试。";
  if (reasonCode === "http_error") return "接口返回了错误响应，可展开查看原始报错。";
  return "joi 无法访问所选接口。请检查网络、服务状态和套餐余额后再验证。";
}

function accessModeLabel(accessMode: ModelSourceAccessModeDto): string {
  if (accessMode === "coding-plan") return "Coding Plan";
  if (accessMode === "token-plan") return "Token Plan";
  if (accessMode === "custom") return "自定义接口";
  return "API";
}

function modelSourceStatusLabel(status: JoiSnapshotDto["modelSources"][number]["status"]): string {
  if (status === "DRAFT") return "草稿";
  if (status === "VALIDATING") return "正在验证";
  if (status === "READY") return "可用";
  if (status === "DEGRADED") return "暂时异常";
  if (status === "NEEDS_AUTH") return "需要重新连接";
  return "已停用";
}

function protocolLabel(protocol: ModelSourceProtocolDto): string {
  return protocol === "anthropic" ? "Anthropic-compatible" : "OpenAI-compatible";
}

export function ModelSourceManager({ api }: { api: DigitalLifeApi }) {
  const [sources, setSources] = useState<JoiSnapshotDto["modelSources"]>([]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSources((await api.listModelSources()).items); }
    catch { setNotice("没能读取模型网络设置。"); }
  }, [api]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  const reorder = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= sources.length) return;
    const ids = sources.map((source) => source.sourceId);
    const current = ids[index]; const replacement = ids[target];
    if (current === undefined || replacement === undefined) return;
    ids[index] = replacement; ids[target] = current;
    setSources((await api.orderModelSources(ids)).items);
  };
  const saveEdit = async (event: SyntheticEvent<HTMLFormElement>, source: JoiSnapshotDto["modelSources"][number]) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const apiKey = field("apiKey");
    const body = {
      ...(apiKey === "" ? {} : { apiKey }),
      modelId: field("modelId"),
      ...(source.kind === "generic-openai" ? {
        baseUrl: field("baseUrl"), displayName: field("displayName"),
      } : {}),
    };
    try {
      await api.updateModelSource(source.sourceId, body);
      setEditing(null);
      setNotice("修改已保存为草稿 revision，请验证后启用。");
      await load();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "模型网络修改未保存。");
    }
  };
  return <section className="model-source-manager">
    <header><div><h2>大模型网络</h2><p>主源和备用源按这里的顺序使用。页面不会显示已保存的密钥。</p></div><button className="button quiet" onClick={() => setAdding((value) => !value)} type="button">{adding ? "收起" : "添加网络"}</button></header>
    {adding ? <ModelSourceSetup api={api} changed={async () => { await load(); setAdding(false); }} /> : null}
    <div className="model-source-list">{sources.map((source, index) => <article className="model-source-item" key={source.sourceId}>
      <div className="model-source-summary"><div className="model-source-heading"><strong>{source.displayName}</strong><span className={`model-source-status ${source.status.toLowerCase()}`}>{modelSourceStatusLabel(source.status)}</span></div><span className="model-source-meta">{source.primary ? "主源" : `备用 ${String(index)}`} · {accessModeLabel(source.accessMode)} · {protocolLabel(source.protocol)}</span><small>模型：{source.activeModel.id}</small>{source.baseUrl === undefined ? null : <small>{source.baseUrl}</small>}{source.status === "DEGRADED" || source.status === "NEEDS_AUTH" ? <><span className="model-source-reason">⚠ {modelSourceReasonText(source.reasonCode)}</span>{source.lastValidatedAt === undefined ? null : <small>上次验证：{new Date(source.lastValidatedAt).toLocaleString()}</small>}{source.lastError === undefined ? null : <details className="model-source-error"><summary>查看原始报错</summary><pre>{source.lastError}</pre></details>}</> : null}</div>
      <div aria-label={`${source.displayName} 操作`} className="row-actions model-source-actions" role="group"><button aria-label={`编辑 ${source.displayName}`} className="button ghost" onClick={() => setEditing(source.sourceId)} type="button">编辑</button><button className="button ghost" disabled={index === 0} onClick={() => void reorder(index, -1)} type="button">上移</button><button className="button ghost" disabled={index === sources.length - 1} onClick={() => void reorder(index, 1)} type="button">下移</button><button className="button quiet" onClick={() => void api.validateModelSource(source.sourceId).then(load).catch(() => setNotice("验证没有通过。"))} type="button">验证</button><button className="button ghost" onClick={() => void api.updateModelSource(source.sourceId, { disabled: true }).then(load)} type="button">停用</button><button className="button danger-text" onClick={() => void api.deleteModelSource(source.sourceId).then(load)} type="button">删除</button></div>
      {editing === source.sourceId ? <form className="model-source-form" onSubmit={(event) => void saveEdit(event, source)}>
        {source.kind === "generic-openai" ? <><label>编辑显示名称<input defaultValue={source.displayName} name="displayName" required /></label><label>编辑 Base URL<input defaultValue={source.baseUrl} name="baseUrl" required type="url" /></label></> : null}
        <label>编辑 Model ID<input defaultValue={source.activeModel.id} name="modelId" required /></label>
        <label>替换 API Key（留空则保留）<input autoComplete="off" name="apiKey" type="password" /></label>
        <div className="row-actions"><button className="button primary" type="submit">保存修改</button><button className="button ghost" onClick={() => setEditing(null)} type="button">取消</button></div>
      </form> : null}
    </article>)}</div>
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
  </section>;
}

function AgentMessageStream({ agent, api, avatarId, live = false }: {
  agent: AvatarAgentCardDto;
  api: DigitalLifeApi;
  avatarId: string;
  live?: boolean;
}) {
  const [page, setPage] = useState<AgentConversationPageDto | null>(null);
  const [paged, setPaged] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setPage(await api.agentConversation(avatarId, agent.agentId, { limit: 50 })); setNotice(null); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "没能读取 Agent 对话。"); }
  }, [agent.agentId, api, avatarId]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (!live || paged) return undefined;
    const interval = setInterval(() => void load().catch(() => undefined), 2_500);
    return () => clearInterval(interval);
  }, [live, load, paged]);
  const loadMore = async () => {
    if (page?.nextCursor === undefined) return;
    const next = await api.agentConversation(avatarId, agent.agentId, { cursor: page.nextCursor, limit: 50 });
    setPaged(true);
    setPage({ ...next, items: [...page.items, ...next.items] });
  };
  return <>
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
    {page === null ? <p className="content-state">正在整理对话…</p> : <div className="agent-message-stream">{page.items.length === 0 ? <p className="plain-empty">这位 Agent 还没有可展示的执行消息。</p> : page.items.map((entry) => <article className={`agent-message ${entry.role.toLowerCase()} ${entry.kind.toLowerCase()}`} key={entry.entryId}>
      <header><strong>{entry.role === "USER" ? "任务" : entry.role === "AGENT" ? agent.partnerName : entry.role === "TOOL" ? "工具" : "系统"}</strong><time>{new Date(entry.createdAt).toLocaleString()}</time></header>
      {entry.kind === "TOOL_CALL" ? <div className="agent-tool-block"><span>调用工具</span><code>{entry.toolName ?? "tool"}</code>{entry.text === undefined ? null : <pre>{entry.text}</pre>}</div>
        : entry.kind === "TOOL_RESULT" ? <div className="agent-tool-block result"><span>{entry.toolName ?? "工具结果"}</span><pre>{entry.text ?? ""}</pre></div>
          : entry.kind === "ARTIFACT" ? <div className="agent-artifact"><strong>{entry.artifact?.name ?? "产物"}</strong><span>{entry.artifact?.mimeType ?? "文件"} · {String(entry.artifact?.size ?? 0)} B</span></div>
            : <ReactMarkdown components={{
              a: ({ href, children }) => href !== undefined && /^https?:\/\//iu.test(href) ? <a href={href} rel="noreferrer" target="_blank">{children}</a> : <span>{children}</span>,
              img: ({ alt }) => <span className="agent-remote-image">[图片{alt === undefined ? "" : `：${alt}`}]</span>,
            }} remarkPlugins={[remarkGfm]} skipHtml>{entry.text ?? ""}</ReactMarkdown>}
    </article>)}</div>}
    {page?.nextCursor === undefined ? null : <button className="button ghost agent-load-more" onClick={() => void loadMore()} type="button">加载更早记录</button>}
  </>;
}

function AgentConversation({ agent, api, avatarId, onBack }: {
  agent: AvatarAgentCardDto;
  api: DigitalLifeApi;
  avatarId: string;
  onBack: () => void;
}) {
  return <section className="agent-conversation" aria-label={`${agent.partnerName} 对话`}>
    <header className="agent-detail-header"><button className="button ghost" onClick={onBack} type="button">返回 Agent 列表</button><div><p className="eyebrow">只读执行记录</p><h2>{agent.partnerName}</h2><span>{agent.transport} · {agent.sessionPolicy} · {agent.status}</span></div></header>
    <AgentMessageStream agent={agent} api={api} avatarId={avatarId} />
  </section>;
}

export function AvatarManager({ api, initialAvatarId }: { api: DigitalLifeApi; initialAvatarId?: string }) {
  const [avatars, setAvatars] = useState<AvatarDto[]>([]);
  const [detail, setDetail] = useState<AvatarDetailDto | null>(null);
  const [agents, setAgents] = useState<AvatarAgentCardDto[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AvatarAgentCardDto | null>(null);
  const [tab, setTab] = useState<"agents" | "context">("agents");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => setAvatars((await api.listAvatars()).items), [api]);
  const loadAgents = useCallback(async (avatarId: string) => {
    try {
      const page = await api.listAvatarAgents(avatarId, { limit: 100 });
      setAgents(Array.isArray(page.items) ? page.items : []);
    }
    catch { setAgents([]); }
  }, [api]);
  const open = useCallback(async (avatarId: string) => {
    try {
      setDetail(await api.getAvatar(avatarId));
      setSelectedAgent(null); setTab("agents"); setNotice(null);
      await loadAgents(avatarId);
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "没能读取 Avatar 上下文。"); }
  }, [api, loadAgents]);
  useEffect(() => { const timer = setTimeout(() => void load().catch(() => setNotice("没能读取 Avatar 列表。")), 0); return () => clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (initialAvatarId === undefined) return;
    const timer = setTimeout(() => void open(initialAvatarId), 0);
    return () => clearTimeout(timer);
  }, [initialAvatarId, open]);
  useEffect(() => {
    if (detail === null || selectedAgent !== null) return undefined;
    const timer = setInterval(() => void loadAgents(detail.avatarId), 1_500);
    return () => clearInterval(timer);
  }, [detail, loadAgents, selectedAgent]);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    await api.createAvatar({ name: field("name"), personaSummary: field("personaSummary"), projectLabel: field("projectLabel"), scopeSummary: field("scopeSummary") });
    setAdding(false); setNotice("Avatar 已创建；之后的任务上下文仍由 joi 归属和管理。"); await load();
  };
  const saveDetail = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (detail === null) return;
    const form = new FormData(event.currentTarget);
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    const persona = field("persona");
    try {
      setDetail(await api.updateAvatar(detail.avatarId, { name: field("name"), ...(persona === "" ? {} : { persona }), projectLabel: field("projectLabel"), responsibility: field("responsibility") }));
      setNotice("Avatar 上下文已更新。"); await load();
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "Avatar 没保存成功。"); }
  };
  const workspaceAction = async (action: "bind" | "rebuild") => {
    if (detail === null) return;
    try {
      if (action === "bind") await api.bindAvatarWorkspace(detail.avatarId); else await api.rebuildAvatarWorkspace(detail.avatarId);
      await open(detail.avatarId); setTab("context");
      setNotice(action === "bind" ? "已绑定现有目录。" : "已重新排队创建受管目录。");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "工作区操作没有完成。"); }
  };
  const removeAgent = async (agent: AvatarAgentCardDto) => {
    if (detail === null) return;
    try { await api.deleteAvatarAgent(detail.avatarId, agent.agentId); await loadAgents(detail.avatarId); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "Agent 没有删除。"); }
  };
  if (detail !== null && selectedAgent !== null) return <AgentConversation agent={selectedAgent} api={api} avatarId={detail.avatarId} onBack={() => setSelectedAgent(null)} />;
  return <section className="partner-manager page-section">
    <header className="page-title-row"><div><p className="eyebrow">Avatar / Agent</p><h1>{detail?.name ?? "Avatar"}</h1><p>{detail === null ? "每个 Avatar 保存一个长期上下文，Agent 是它实际启动的工作者。" : "这里始终展示这个 Avatar 启动过且尚未删除的全部 Agent。"}</p></div>{detail === null ? <button className={adding ? "button quiet" : "button primary"} onClick={() => setAdding((value) => !value)} type="button">{adding ? "收起" : "创建 Avatar"}</button> : <button className="button ghost" onClick={() => { setDetail(null); setAgents([]); }} type="button">返回 Avatar 列表</button>}</header>
    {detail === null && adding ? <form className="partner-form" onSubmit={(event) => void submit(event)}><label>名称<input name="name" required /></label><label>工程名称<input name="projectLabel" required /></label><label>职责范围<textarea name="scopeSummary" required rows={4} /></label><label>人格摘要<textarea name="personaSummary" required rows={4} /></label><button className="button primary" type="submit">保存 Avatar</button></form> : null}
    {detail === null ? (avatars.length === 0 ? <div className="plain-empty"><h2>还没有 Avatar</h2><p>直接从首页告诉 joi 目标，它也可以按需要创建。</p></div> : <div className="avatar-catalog">{avatars.map((avatar) => <button className="avatar-catalog-card" key={avatar.avatarId} onClick={() => void open(avatar.avatarId)} type="button"><span className="avatar-orb">{avatar.name.slice(0, 1)}</span><strong>{avatar.name}</strong><span>{avatar.scopeSummary}</span><small>更新于 {new Date(avatar.updatedAt).toLocaleString()}</small><i>管理上下文</i></button>)}</div>) : <>
      <div className="avatar-detail-tabs" role="tablist"><button aria-selected={tab === "agents"} onClick={() => setTab("agents")} role="tab" type="button">Agent <span>{agents.length}</span></button><button aria-selected={tab === "context"} onClick={() => setTab("context")} role="tab" type="button">上下文设置</button></div>
      {tab === "agents" ? <div className="avatar-agent-list">{agents.length === 0 ? <div className="plain-empty"><h2>还没有 Agent</h2><p>当 joi 为这个 Avatar 安排实际工作后，Agent 会出现在这里。</p></div> : agents.map((agent) => <article className="avatar-agent-card" key={agent.agentId}><button aria-label={`查看 ${agent.partnerName} 详情`} className="avatar-agent-open" onClick={() => setSelectedAgent(agent)} type="button"><span className="agent-avatar">{agent.partnerName.slice(0, 1)}</span><span><strong>{agent.partnerName}</strong><small>{agent.transport} · {agent.engine} · {agent.sessionPolicy}</small></span><i className={`agent-status ${agent.status.toLowerCase()}`}>{agent.status}</i><time>{new Date(agent.lastActivityAt).toLocaleString()}</time></button>{agent.canDelete ? <button aria-label={`删除 ${agent.partnerName}`} className="button danger-text agent-delete" onClick={() => void removeAgent(agent)} type="button">删除</button> : null}</article>)}</div> : <div className="avatar-context-center">
        <form className="partner-form" onSubmit={(event) => void saveDetail(event)}><label>名称<input defaultValue={detail.name} name="name" required /></label><label>工程名称<input defaultValue={detail.projectLabel} name="projectLabel" required /></label><label>职责范围<textarea defaultValue={detail.responsibility} name="responsibility" required rows={4} /></label><label>提交新人格 revision（留空保持当前）<textarea name="persona" rows={4} /></label><button className="button primary" type="submit">保存上下文</button></form>
        <article className="context-card"><h3>工作区</h3><p><strong>{detail.workspace.displayName}</strong> · {detail.workspace.kind} · {detail.workspace.status}</p>{detail.workspace.failureReasonCode === undefined ? null : <small>{detail.workspace.failureReasonCode}</small>}<div className="row-actions"><button className="button ghost" onClick={() => void workspaceAction("bind")} type="button">绑定已有目录</button><button className="button ghost" onClick={() => void workspaceAction("rebuild")} type="button">重建受管目录</button></div></article>
        <article className="context-card"><h3>活跃工作</h3>{detail.activeWork.length === 0 ? <p>当前没有非终态工作。</p> : <ul>{detail.activeWork.map((work) => <li key={work.workId}>{work.title} · {work.status}</li>)}</ul>}</article>
        <article className="context-card"><h3>最近结果</h3>{detail.recentResults.length === 0 ? <p>还没有结果元数据。</p> : <ul>{detail.recentResults.map((item) => <li key={item.resultId}>{item.summary} · {item.status}{item.isLate ? " · 迟到" : ""}</li>)}</ul>}</article>
      </div>}
    </>}
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
  </section>;
}

function ClarificationActions({ api, avatarId, avatars, inputId, onResolved, prompt, reasonCode }: {
  api: DigitalLifeApi;
  avatarId: string | undefined;
  avatars: AvatarDto[];
  inputId: string;
  onResolved: () => void;
  prompt: string | undefined;
  reasonCode: string | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isQuestion = reasonCode === "question_required";
  const needsWorkspace = reasonCode === "avatar_workspace_not_ready";
  const needsAvatarChoice = reasonCode === "avatar_selection_invalid" || reasonCode === "avatar_creation_unavailable" || reasonCode === "avatar_not_found";
  const assignedAvatar = avatars.find((avatar) => avatar.avatarId === avatarId);
  const resolve = async (resolution: { avatarId?: string; text?: string }) => {
    setBusy(true); setNotice(null);
    try {
      await api.clarifyJoiMessage(inputId, resolution);
      setNotice("已交给 joi，正在重新安排…");
      setDraft("");
      onResolved();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "没能交给 joi，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const submitDraft = () => { void resolve({ text: draft.trim() }); };
  const chooseWorkspace = async () => {
    if (avatarId === undefined) {
      setNotice("这条任务还没有关联 Avatar，暂时不能选择工作目录。");
      return;
    }
    setBusy(true); setNotice(null);
    try {
      await api.bindAvatarWorkspace(avatarId);
      await api.clarifyJoiMessage(inputId, { avatarId });
      setNotice("工作目录已绑定，joi 正在继续安排…");
      onResolved();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "工作目录没有绑定成功，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return <div className="joi-clarify">
    <p className="joi-clarify-reason">{clarificationText(reasonCode, prompt, assignedAvatar?.name)}</p>
    {needsAvatarChoice && avatars.length === 0
      ? <p className="joi-clarify-hint">还没有可选的 Avatar；先补充细节，或到「Avatar」页创建后再点选。</p>
      : needsAvatarChoice ? <div className="joi-clarify-chips" role="group" aria-label="点选这条输入归属的 Avatar">{avatars.map((avatar) => <button className="joi-clarify-chip" disabled={busy} key={avatar.avatarId} onClick={() => void resolve({ avatarId: avatar.avatarId })} type="button">{avatar.name}</button>)}</div> : null}
    {needsWorkspace ? <div className="joi-clarify-workspace">
      <div><strong>{assignedAvatar?.name ?? "当前 Avatar"}</strong><span>选择后只保存安全的工作区标识，不会在页面或接口中暴露绝对路径。</span></div>
      <button className="button primary" disabled={busy || avatarId === undefined} onClick={() => void chooseWorkspace()} type="button">{busy ? "选择中…" : "选择工作目录"}</button>
    </div> : <div className="joi-clarify-add">
      <input aria-label={isQuestion ? "你的回答" : "补充信息"} disabled={busy} onChange={(event) => setDraft(event.target.value)} placeholder={isQuestion ? "输入回答，joi 会接着原任务继续…" : "补充细节，让 joi 接着这条输入往下做…"} value={draft} />
      <button className="button quiet" disabled={busy || draft.trim() === ""} onClick={submitDraft} type="button">{isQuestion ? "回答并继续" : "补充并继续"}</button>
    </div>}
    {notice === null ? null : <p className="inline-notice info" role="status">{notice}</p>}
  </div>;
}

function CancelInputButton({ api, inputId, onCanceled }: { api: DigitalLifeApi; inputId: string; onCanceled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    setBusy(true); setError(null);
    try {
      await api.cancelJoiMessage(inputId);
      onCanceled();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "没能取消这条任务，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return <span className="joi-feed-cancel-wrap"><button aria-label="取消这条任务" className="button quiet joi-feed-cancel" disabled={busy} onClick={() => void cancel()} type="button">{busy ? "取消中…" : "取消"}</button>{error === null ? null : <span className="joi-feed-cancel-error" role="status">{error}</span>}</span>;
}

function DismissInputButton({ api, inputId, onDismissed }: { api: DigitalLifeApi; inputId: string; onDismissed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = async () => {
    setBusy(true); setError(null);
    try {
      await api.dismissJoiMessage(inputId);
      onDismissed();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "没能移除这条卡片，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return <span className="joi-feed-cancel-wrap"><button aria-label="移除这条卡片" className="button quiet joi-feed-dismiss" disabled={busy} onClick={() => void dismiss()} type="button">{busy ? "移除中…" : "移除"}</button>{error === null ? null : <span className="joi-feed-cancel-error" role="status">{error}</span>}</span>;
}

function ComposerAvatarPicker({ avatars, onSelect, selected }: {
  avatars: AvatarDto[];
  onSelect: (avatarId: string | null) => void;
  selected: AvatarDto | undefined;
}) {
  const [open, setOpen] = useState(false);
  const choose = (avatarId: string | null) => { onSelect(avatarId); setOpen(false); };
  return <div className="joi-avatar-picker">
    <button aria-expanded={open} aria-haspopup="dialog" className="joi-avatar-button" onClick={() => setOpen((current) => !current)} type="button">
      {selected === undefined ? "joi 自主分发" : `分发给 ${selected.name}`}
    </button>
    {open ? <div aria-label="选择这条输入的分发方式" className="joi-avatar-menu" role="dialog">
      <strong>这条输入交给谁</strong>
      <span>不选择时由 joi 自主判断归属；选择后直接交给该 Avatar。</span>
      <div className="joi-avatar-options">
        <button className="button ghost" onClick={() => choose(null)} type="button">joi 自主分发（默认）</button>
        {avatars.map((avatar) => <button className="button ghost" key={avatar.avatarId} onClick={() => choose(avatar.avatarId)} type="button">{avatar.name}</button>)}
      </div>
      {avatars.length === 0 ? <small>还没有 Avatar。直接提交目标，joi 会按需建立上下文。</small> : null}
    </div> : null}
  </div>;
}

function legacyHomeFeed(messages: JoiAcceptedMessageDto[]): JoiHomeFeedDto {
  const unassignedActions = messages.filter((message) => message.status === "CLARIFICATION_REQUIRED" && message.avatarId === undefined);
  const goals: JoiGoalCardDto[] = messages.filter((message) => !unassignedActions.includes(message)).map((message) => ({
    agentCount: 0,
    avatar: { avatarId: message.avatarId ?? "", name: message.avatarId ?? "等待归属" },
    canDelete: message.status === "CONSUMED",
    ...(message.status === "CLARIFICATION_REQUIRED" ? { clarification: { ...(message.clarificationPrompt === undefined ? {} : { prompt: message.clarificationPrompt }), ...(message.clarificationReasonCode === undefined ? {} : { reasonCode: message.clarificationReasonCode }) } } : {}),
    goalId: message.inputId,
    status: message.canceled === true ? "CANCELED" : message.status === "CONSUMED" ? "COMPLETED" : message.status === "CLARIFICATION_REQUIRED" ? "NEEDS_ATTENTION" : message.status === "ROUTED" ? "ARRANGED" : "ARRANGING",
    title: message.textPreview ?? "正在安排的新目标",
    updatedAt: message.acceptedAt,
    work: { active: 0, completed: 0, failed: 0, total: 0 },
  }));
  const thinking = messages.filter((message) => message.status === "PENDING" || message.status === "ROUTED").map((message) => ({ goalId: message.inputId, phase: "progressing" as const, startedAt: message.acceptedAt, turnId: `legacy:${message.inputId}` }));
  return { goals, thinking, unassignedActions };
}

function goalStatusLabel(status: JoiGoalCardDto["status"]): string {
  if (status === "ARRANGING") return "正在安排";
  if (status === "ARRANGED") return "已安排";
  if (status === "RUNNING") return "执行中";
  if (status === "NEEDS_ATTENTION") return "需要你";
  if (status === "FINALIZING") return "正在总结";
  if (status === "COMPLETED") return "已完成";
  if (status === "FAILED") return "有失败";
  return "已取消";
}

function GoalProgress({ goal }: { goal: JoiGoalCardDto }) {
  const percent = goal.work.total === 0 ? (goal.status === "COMPLETED" ? 100 : 0) : Math.round((goal.work.completed / goal.work.total) * 100);
  return <span className="joi-goal-progress">
    <span aria-hidden="true" className="joi-goal-progress-track"><i className={goal.work.failed > 0 ? "failed" : ""} style={{ width: `${String(percent)}%` }} /></span>
    <i>{goal.agentCount} Agent · {goal.work.completed}/{goal.work.total} 工作完成{goal.work.failed > 0 ? ` · ${String(goal.work.failed)} 失败` : ""}</i>
  </span>;
}

function GoalDetail({ api, avatars, goal, onBack, onOpenAvatar, onResolved }: {
  api: DigitalLifeApi;
  avatars: AvatarDto[];
  goal: JoiGoalCardDto;
  onBack: () => void;
  onOpenAvatar?: (avatarId: string) => void;
  onResolved: () => void;
}) {
  const [agents, setAgents] = useState<AvatarAgentCardDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadAgents = useCallback(async () => {
    try {
      const page = await api.listAvatarAgents(goal.avatar.avatarId, { goalId: goal.goalId, limit: 100 });
      const items = Array.isArray(page.items) ? page.items : [];
      setAgents(items);
      setNotice(null);
      setSelectedAgentId((current) => current !== null && items.some((agent) => agent.agentId === current) ? current : (items[0]?.agentId ?? null));
    } catch {
      setNotice("没能读取这条目标的 Agent 列表。");
    }
  }, [api, goal.avatar.avatarId, goal.goalId]);
  useEffect(() => {
    const initial = setTimeout(() => void loadAgents(), 0);
    const interval = setInterval(() => void loadAgents().catch(() => undefined), 1_500);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [loadAgents]);
  const selectedAgent = agents.find((agent) => agent.agentId === selectedAgentId);
  return <section aria-label={`${goal.avatar.name} 的目标详情`} className="joi-goal-detail">
    <header className="joi-goal-detail-header">
      <button className="button ghost" onClick={onBack} type="button">返回信息流</button>
      <div className="joi-goal-detail-title">
        <p className="eyebrow">{goal.avatar.name}</p>
        <h1>{goal.title}</h1>
        <span className="joi-goal-detail-meta"><span className={`joi-goal-status ${goal.status.toLowerCase()}`}>{goalStatusLabel(goal.status)}</span><GoalProgress goal={goal} /></span>
      </div>
      {onOpenAvatar === undefined ? null : <button className="button quiet" onClick={() => onOpenAvatar(goal.avatar.avatarId)} type="button">管理 {goal.avatar.name} 上下文</button>}
    </header>
    {goal.completionSummary === undefined ? null : <article className="joi-goal-result"><h2>最终结果</h2><p>{goal.completionSummary}</p></article>}
    {goal.clarification === undefined ? null : <ClarificationActions api={api} avatarId={goal.avatar.avatarId} avatars={avatars} inputId={goal.goalId} onResolved={onResolved} prompt={goal.clarification.prompt} reasonCode={goal.clarification.reasonCode} />}
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
    <div className="joi-goal-detail-body">
      <aside aria-label="这条目标的 Agent 列表" className="joi-goal-agents">
        {agents.length === 0 ? <p className="plain-empty">joi 还没有为这条目标启动 Agent。</p> : agents.map((agent) => <button aria-pressed={agent.agentId === selectedAgentId} className={`joi-goal-agent ${agent.agentId === selectedAgentId ? "selected" : ""}`} key={agent.agentId} onClick={() => setSelectedAgentId(agent.agentId)} type="button">
          <span className="agent-avatar">{agent.partnerName.slice(0, 1)}</span>
          <span className="joi-goal-agent-copy"><strong>{agent.partnerName}</strong><small>{agent.transport} · {agent.engine}</small></span>
          <i className={`agent-status ${agent.status.toLowerCase()}`}>{agent.status}</i>
        </button>)}
      </aside>
      <div className="joi-goal-stream">
        {selectedAgent === undefined
          ? <p className="content-state">Agent 启动后，这里会直接展示它的执行数据流和结果。</p>
          : <AgentMessageStream agent={selectedAgent} api={api} avatarId={goal.avatar.avatarId} key={selectedAgent.agentId} live={selectedAgent.status === "RUNNING" || selectedAgent.status === "WAITING"} />}
      </div>
    </div>
  </section>;
}

function JoiComposer({ api, onNavigate, onOpenAvatar, snapshot }: {
  api: DigitalLifeApi;
  onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void;
  onOpenAvatar?: (avatarId: string) => void;
  snapshot: JoiSnapshotDto;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [targetAvatarId, setTargetAvatarId] = useState<string | null>(null);
  const targetAvatar = snapshot.avatars.find((avatar) => avatar.avatarId === targetAvatarId);
  const [feed, setFeed] = useState<JoiHomeFeedDto>({ goals: [], thinking: [], unassignedActions: [] });
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [avatarChanges, setAvatarChanges] = useState(snapshot.avatarChanges);
  const [error, setError] = useState<string | null>(null);
  const loadFeed = useCallback(async () => {
    try {
      const loaded = await api.joiHomeFeed();
      if (!Array.isArray(loaded.goals) || !Array.isArray(loaded.thinking) || !Array.isArray(loaded.unassignedActions)) throw new Error("joi_home_feed_invalid");
      setFeed(loaded);
    } catch {
      const messages = await api.listJoiMessages();
      if (!Array.isArray(messages.items)) throw new Error("joi_messages_invalid");
      setFeed(legacyHomeFeed(messages.items));
    }
  }, [api]);
  const refresh = useCallback(async () => {
    const state = await api.joiSnapshot();
    await loadFeed();
    setAvatarChanges(state.avatarChanges);
  }, [api, loadFeed]);
  useEffect(() => {
    const initial = setTimeout(() => void loadFeed().catch(() => undefined), 0);
    const interval = setInterval(() => void refresh().catch(() => undefined), 1_500);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearTimeout(initial); clearInterval(interval); clearInterval(clock); };
  }, [loadFeed, refresh]);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = text.trim();
    if (message === "") return;
    setText(""); setError(null);
    try {
      const uploaded = await Promise.all(files.map((file) => api.uploadJoiAttachment(file)));
      const saved = await api.sendJoiMessage(message, {
        ...(uploaded.length === 0 ? {} : { attachmentIds: uploaded.map((item) => item.attachmentId) }),
        ...(targetAvatar === undefined ? {} : { avatarId: targetAvatar.avatarId }),
      });
      setFiles([]);
      setFeed((current) => ({ ...current, thinking: [{ goalId: saved.inputId, phase: "progressing", startedAt: saved.acceptedAt, turnId: `pending:${saved.inputId}` }, ...current.thinking] }));
      void refresh().catch(() => undefined);
    } catch (reason) {
      setText(message);
      setError(reason instanceof ApiError ? reason.message : "输入没保存成功，请再试一次。");
    }
  };
  const visibleThinking = useMemo(() => feed.thinking.filter((item) => item.phase === "progressing" || Date.parse(item.expiresAt ?? "") > now), [feed.thinking, now]);
  const openGoal = feed.goals.find((goal) => goal.goalId === openGoalId);
  const dismissGoal = (goalId: string) => setFeed((current) => ({ ...current, goals: current.goals.filter((goal) => goal.goalId !== goalId) }));
  const dismissAction = (inputId: string) => setFeed((current) => ({ ...current, unassignedActions: current.unassignedActions.filter((item) => item.inputId !== inputId) }));
  return <section className="joi-home" aria-labelledby="joi-home-title">
    <header><h1 id="joi-home-title">现在想让 joi 做什么？</h1><p>你只管说目标。Avatar 归属、是否并发、找哪位搭档，都由 joi 判断和安排。</p></header>
    {avatarChanges.length === 0 ? null : <section className="joi-avatar-confirmations" aria-label="Avatar 变更确认"><h2>需要你确认</h2>{avatarChanges.map((change) => <article key={change.requestId}>
      <div><strong>{change.kind === "MERGE" ? "joi 建议合并 Avatar" : "joi 建议归档 Avatar"}</strong><span>{change.reason}</span><small>{change.kind === "MERGE" ? `${change.sourceAvatarId} → ${change.targetAvatarId ?? ""}` : change.sourceAvatarId}</small></div>
      <div className="row-actions"><button className="button ghost" onClick={() => void api.decideAvatarChange(change.requestId, "REJECT").then(refresh)} type="button">保留原样</button><button className="button danger-text" onClick={() => void api.decideAvatarChange(change.requestId, "CONFIRM").then(refresh)} type="button">{change.kind === "MERGE" ? "确认合并" : "确认归档"}</button></div>
    </article>)}</section>}
    {openGoal !== undefined ? <GoalDetail api={api} avatars={snapshot.avatars} goal={openGoal} onBack={() => setOpenGoalId(null)} {...(onOpenAvatar === undefined ? {} : { onOpenAvatar })} onResolved={() => void refresh().catch(() => undefined)} /> : <div aria-label="joi 信息流" className="joi-feed joi-feed-single">
      {visibleThinking.map((item) => <div className={`joi-thinking ${item.phase}`} key={item.turnId}><span className="joi-thinking-dot" /><strong>progressing</strong></div>)}
      {feed.unassignedActions.map((message) => <article className="joi-feed-item needs-you" key={message.inputId}><div className="joi-feed-head"><span className="joi-feed-stage">需要你确认</span><span className="joi-feed-head-right"><time className="joi-feed-time">{new Date(message.acceptedAt).toLocaleString()}</time><CancelInputButton api={api} inputId={message.inputId} onCanceled={() => dismissAction(message.inputId)} /></span></div>{message.textPreview === undefined ? null : <p className="joi-feed-text">{message.textPreview}</p>}<ClarificationActions api={api} avatarId={message.avatarId} avatars={snapshot.avatars} inputId={message.inputId} onResolved={() => dismissAction(message.inputId)} prompt={message.clarificationPrompt} reasonCode={message.clarificationReasonCode} /></article>)}
      {feed.goals.map((goal) => <article className={`joi-goal-card ${goal.status.toLowerCase()}`} key={goal.goalId}>
        <div className="joi-goal-row">
          <button className="joi-goal-open" disabled={goal.avatar.avatarId === ""} onClick={() => setOpenGoalId(goal.goalId)} type="button"><span className="avatar-orb">{goal.avatar.name.slice(0, 1)}</span><span className="joi-goal-copy"><small>{goal.avatar.name}</small><strong>{goal.title}</strong>{goal.completionSummary === undefined ? null : <span>{goal.completionSummary}</span>}<GoalProgress goal={goal} /></span></button>
          <div className="joi-goal-side"><span className={`joi-goal-status ${goal.status.toLowerCase()}`}>{goalStatusLabel(goal.status)}</span>{goal.status === "NEEDS_ATTENTION" || goal.canDelete ? <div className="joi-goal-actions">{goal.status === "NEEDS_ATTENTION" ? <CancelInputButton api={api} inputId={goal.goalId} onCanceled={() => void refresh().catch(() => undefined)} /> : null}{goal.canDelete ? <DismissInputButton api={api} inputId={goal.goalId} onDismissed={() => dismissGoal(goal.goalId)} /> : null}</div> : null}</div>
        </div>
        {goal.clarification === undefined ? null : <ClarificationActions api={api} avatarId={goal.avatar.avatarId} avatars={snapshot.avatars} inputId={goal.goalId} onResolved={() => void refresh().catch(() => undefined)} prompt={goal.clarification.prompt} reasonCode={goal.clarification.reasonCode} />}
      </article>)}
      {visibleThinking.length === 0 && feed.unassignedActions.length === 0 && feed.goals.length === 0 ? <p className="joi-feed-empty">这里很干净。告诉 joi 一个目标，正在推进的工作会暂时出现在这里。</p> : null}
    </div>}
    {snapshot.partners.length >= 2 ? null : <div className="inline-notice warning"><span>{snapshot.partners.length === 0 ? "当前还没有工作搭档。" : `当前只有 ${String(snapshot.partners.length)} 个工作搭档。`}可以先用场景预设一键组建团队，或去搭档页手动创建 2-3 个。</span><span className="row-actions"><button className="button ghost" onClick={() => onNavigate?.("agents", "scenarios")} type="button">看场景预设</button><button className="button ghost" onClick={() => onNavigate?.("agents", "partners")} type="button">去搭档页创建</button></span></div>}
    <form className="joi-composer" onSubmit={(event) => void submit(event)}>
      <label className="joi-composer-label" htmlFor="joi-input">给 joi 输入</label>
      <textarea autoFocus id="joi-input" onChange={(event) => setText(event.target.value)} placeholder="描述目标、补充想法，或继续上一段对话…" rows={2} value={text} />
      <div className="joi-composer-toolbar">
        <label className="joi-attachment-button">添加附件<input aria-label="给 joi 添加附件" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 8))} type="file" /></label>
        <ComposerAvatarPicker avatars={snapshot.avatars} onSelect={setTargetAvatarId} selected={targetAvatar} />
        {files.length === 0 ? null : <span className="joi-file-summary">{files.map((file) => file.name).join("、")}</span>}
        <button className="button primary" disabled={text.trim() === ""} type="submit">交给 joi</button>
      </div>
    </form>
    {error === null ? null : <p className="inline-notice danger" role="alert">{error}</p>}
  </section>;
}

function clarificationText(code: string | undefined, prompt?: string, avatarName?: string): string {
  if (code === "question_required") return prompt ?? "joi 需要你回答一个问题，才能继续安排这条任务。";
  if (code === "avatar_workspace_not_ready") return `“${avatarName ?? "当前 Avatar"}”还没有可用的工作目录。选择一个目录后，joi 会自动继续这条任务。`;
  if (code === "avatar_selection_invalid") return "joi 没法定位这条输入属于哪个上下文。在下方点选它对应的 Avatar，或补充更明确的项目/角色。";
  if (code === "avatar_creation_unavailable") return "joi 想新建一个 Avatar 来承接这条输入，但当前无法创建。请补充更明确的归属，或先到「Avatar」页手动创建。";
  if (code === "avatar_not_found") return "这条输入指向的 Avatar 已不存在。在下方点选它应归属的 Avatar，或补充项目/角色。";
  return "joi 需要你补充信息后才能继续。在下方补充细节，它会接着这条输入往下做。";
}

export function JoiHome({ api, onNavigate, onOpenAvatar }: {
  api: DigitalLifeApi;
  onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void;
  onOpenAvatar?: (avatarId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<JoiSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSnapshot(await api.joiSnapshot()); setError(null); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "没能读取 joi 的状态。"); }
  }, [api]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  if (error !== null) return <section className="content-state" role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">再试一次</button></section>;
  if (snapshot === null) return <section className="content-state" role="status">joi 正在整理全局状态…</section>;
  return snapshot.runtime.configured ? <JoiComposer api={api} {...(onNavigate === undefined ? {} : { onNavigate })} {...(onOpenAvatar === undefined ? {} : { onOpenAvatar })} snapshot={snapshot} /> : <ModelSourceSetup api={api} changed={load} />;
}
