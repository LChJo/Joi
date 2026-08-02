import { type SyntheticEvent, useCallback, useEffect, useState } from "react";

import { MODEL_SOURCE_CHOICES, type AvatarDetailDto, type AvatarDto, type JoiAcceptedMessageDto, type JoiActivityDto, type JoiSnapshotDto, type ModelSourceAccessModeDto, type ModelSourceKindDto, type ModelSourceProtocolDto } from "../shared/joi";
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
      setNotice(validated.status === "READY" ? "已连接，joi 可以开始思考了。" : validationNotice(validated.reasonCode));
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
      {selectedAccessMode === "coding-plan" ? <p className="inline-notice warning">订阅套餐仅适合个人交互使用，请确认你的使用符合厂商条款。</p> : null}
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

function validationNotice(reasonCode: string | undefined): string {
  if (reasonCode === "auth_failed") return "API Key 与所选接入方案不匹配，或没有访问权限。请确认 Key 和套餐类型后再验证。";
  if (reasonCode === "model_unavailable") return "所选接口找不到这个 Model ID。请留空使用推荐模型，或填写该套餐支持的模型。";
  return "joi 无法访问所选接口。请检查网络、服务状态和套餐余额后再验证。";
}

function accessModeLabel(accessMode: ModelSourceAccessModeDto): string {
  if (accessMode === "coding-plan") return "Coding Plan";
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
      <div className="model-source-summary"><div className="model-source-heading"><strong>{source.displayName}</strong><span className={`model-source-status ${source.status.toLowerCase()}`}>{modelSourceStatusLabel(source.status)}</span></div><span className="model-source-meta">{source.primary ? "主源" : `备用 ${String(index)}`} · {accessModeLabel(source.accessMode)} · {protocolLabel(source.protocol)}</span><small>模型：{source.activeModel.id}</small>{source.baseUrl === undefined ? null : <small>{source.baseUrl}</small>}</div>
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

export function AvatarManager({ api }: { api: DigitalLifeApi }) {
  const [avatars, setAvatars] = useState<AvatarDto[]>([]);
  const [detail, setDetail] = useState<AvatarDetailDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => setAvatars((await api.listAvatars()).items), [api]);
  useEffect(() => { const timer = setTimeout(() => void load().catch(() => setNotice("没能读取 Avatar 列表。")), 0); return () => clearTimeout(timer); }, [load]);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    await api.createAvatar({
      name: field("name"), personaSummary: field("personaSummary"), projectLabel: field("projectLabel"), scopeSummary: field("scopeSummary"),
    });
    setAdding(false); setNotice("Avatar 已创建；之后的任务上下文仍由 joi 归属和管理。"); await load();
  };
  const open = async (avatarId: string) => {
    try { setDetail(await api.getAvatar(avatarId)); setNotice(null); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "没能读取 Avatar 上下文。"); }
  };
  const saveDetail = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (detail === null) return;
    const form = new FormData(event.currentTarget);
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    const persona = field("persona");
    try {
      setDetail(await api.updateAvatar(detail.avatarId, {
        name: field("name"),
        ...(persona === "" ? {} : { persona }),
        projectLabel: field("projectLabel"),
        responsibility: field("responsibility"),
      }));
      setNotice("Avatar 上下文已更新。");
      await load();
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "Avatar 没保存成功。"); }
  };
  const workspaceAction = async (action: "bind" | "rebuild") => {
    if (detail === null) return;
    try {
      if (action === "bind") await api.bindAvatarWorkspace(detail.avatarId);
      else await api.rebuildAvatarWorkspace(detail.avatarId);
      await open(detail.avatarId);
      setNotice(action === "bind" ? "已绑定现有目录。" : "已重新排队创建受管目录。");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "工作区操作没有完成。"); }
  };
  return <section className="partner-manager page-section">
    <header className="page-title-row"><div><p className="eyebrow">joi 管理的上下文边界</p><h1>Avatar 上下文中心</h1><p>Avatar 是工程目录与执行上下文的唯一权威；joi 仍是唯一派发者。</p></div><button className="button primary" onClick={() => setAdding((value) => !value)} type="button">{adding ? "收起" : "创建 Avatar"}</button></header>
    {adding ? <form className="partner-form" onSubmit={(event) => void submit(event)}>
      <label>名称<input name="name" required /></label><label>工程名称<input name="projectLabel" required /></label>
      <label>职责范围<textarea name="scopeSummary" required rows={3} /></label><label>人格摘要<textarea name="personaSummary" required rows={4} /></label>
      <button className="button primary" type="submit">保存 Avatar</button>
    </form> : null}
    {avatars.length === 0 ? <div className="plain-empty"><h2>还没有 Avatar</h2><p>直接从首页告诉 joi 目标，它也可以按需要创建。</p></div> : <div className="partner-list">{avatars.map((avatar) => <article key={avatar.avatarId}><div><strong>{avatar.name}</strong><span>{avatar.scopeSummary}</span><small>更新于 {new Date(avatar.updatedAt).toLocaleString()}</small></div><button className="button ghost" onClick={() => void open(avatar.avatarId)} type="button">管理上下文</button></article>)}</div>}
    {detail === null ? null : <div className="avatar-context-center">
      <header className="page-title-row"><div><p className="eyebrow">当前 Avatar</p><h2>{detail.name}</h2><p>人格 revision {detail.personaRevisionId}</p></div><button className="button ghost" onClick={() => setDetail(null)} type="button">关闭</button></header>
      <form className="partner-form" onSubmit={(event) => void saveDetail(event)}>
        <label>名称<input defaultValue={detail.name} name="name" required /></label>
        <label>工程名称<input defaultValue={detail.projectLabel} name="projectLabel" required /></label>
        <label>职责范围<textarea defaultValue={detail.responsibility} name="responsibility" required rows={3} /></label>
        <label>提交新人格 revision（留空保持当前）<textarea name="persona" rows={4} /></label>
        <button className="button primary" type="submit">保存上下文</button>
      </form>
      <article className="context-card"><h3>工作区</h3><p><strong>{detail.workspace.displayName}</strong> · {detail.workspace.kind} · {detail.workspace.status}</p>{detail.workspace.failureReasonCode === undefined ? null : <small>{detail.workspace.failureReasonCode}</small>}<div className="row-actions"><button className="button ghost" onClick={() => void workspaceAction("bind")} type="button">绑定已有目录</button><button className="button ghost" onClick={() => void workspaceAction("rebuild")} type="button">重建受管目录</button></div></article>
      <article className="context-card"><h3>活跃工作</h3>{detail.activeWork.length === 0 ? <p>当前没有非终态工作。</p> : <ul>{detail.activeWork.map((work) => <li key={work.workId}>{work.title} · {work.status}</li>)}</ul>}</article>
      <article className="context-card"><h3>最近结果</h3>{detail.recentResults.length === 0 ? <p>还没有结果元数据。</p> : <ul>{detail.recentResults.map((item) => <li key={item.resultId}>{item.summary} · {item.status}{item.isLate ? " · 迟到" : ""}</li>)}</ul>}</article>
      <article className="context-card"><h3>私有搭档实例</h3>{detail.instances.length === 0 ? <p>当前没有实例。</p> : <ul>{detail.instances.map((instance) => <li key={instance.instanceId}>{instance.partnerName} · {instance.sessionPolicy} · {instance.status}</li>)}</ul>}</article>
    </div>}
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
  </section>;
}

function ClarificationActions({ api, avatars, inputId, onResolved, reasonCode }: {
  api: DigitalLifeApi; avatars: AvatarDto[]; inputId: string; onResolved: () => void; reasonCode: string | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
  return <div className="joi-clarify">
    <p className="joi-clarify-reason">{clarificationText(reasonCode)}</p>
    {avatars.length === 0
      ? <p className="joi-clarify-hint">还没有可选的 Avatar；先补充细节，或到「Avatar」页创建后再点选。</p>
      : <div className="joi-clarify-chips" role="group" aria-label="点选这条输入归属的 Avatar">{avatars.map((avatar) => <button className="joi-clarify-chip" disabled={busy} key={avatar.avatarId} onClick={() => void resolve({ avatarId: avatar.avatarId })} type="button">{avatar.name}</button>)}</div>}
    <div className="joi-clarify-add">
      <input aria-label="补充信息" disabled={busy} onChange={(event) => setDraft(event.target.value)} placeholder="补充细节，让 joi 接着这条输入往下做…" value={draft} />
      <button className="button quiet" disabled={busy || draft.trim() === ""} onClick={submitDraft} type="button">补充并继续</button>
    </div>
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

function JoiComposer({ api, onNavigate, snapshot }: { api: DigitalLifeApi; onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void; snapshot: JoiSnapshotDto }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [accepted, setAccepted] = useState<JoiAcceptedMessageDto[]>([]);
  const [activity, setActivity] = useState<JoiActivityDto[]>([]);
  const [work, setWork] = useState(snapshot.work);
  const [avatarChanges, setAvatarChanges] = useState(snapshot.avatarChanges);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [messages, timeline, state] = await Promise.all([api.listJoiMessages(), api.listJoiActivity(), api.joiSnapshot()]);
    setAccepted(messages.items);
    setActivity(timeline.items);
    setWork(state.work);
    setAvatarChanges(state.avatarChanges);
  }, [api]);
  useEffect(() => {
    const initial = setTimeout(() => void Promise.all([api.listJoiMessages(), api.listJoiActivity()])
      .then(([messages, timeline]) => { setAccepted(messages.items); setActivity(timeline.items); })
      .catch(() => undefined), 0);
    const interval = setInterval(() => void refresh().catch(() => undefined), 1_500);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [api, refresh]);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = text.trim();
    if (message === "") return;
    setText(""); setError(null);
    try {
      const uploaded = await Promise.all(files.map((file) => api.uploadJoiAttachment(file)));
      const saved = uploaded.length === 0
        ? await api.sendJoiMessage(message)
        : await api.sendJoiMessage(message, uploaded.map((item) => item.attachmentId));
      setFiles([]);
      setAccepted((items) => [...items, saved]);
      void refresh().catch(() => undefined);
    } catch (reason) {
      setText(message);
      setError(reason instanceof ApiError ? reason.message : "输入没保存成功，请再试一次。");
    }
  };
  const feed = buildFeed(accepted, activity);
  return <section className="joi-home" aria-labelledby="joi-home-title">
    <header><h1 id="joi-home-title">现在想让 joi 做什么？</h1><p>你只管说目标。Avatar 归属、是否并发、找哪位搭档，都由 joi 判断和安排。</p></header>
    {avatarChanges.length === 0 ? null : <section className="joi-avatar-confirmations" aria-label="Avatar 变更确认"><h2>需要你确认</h2>{avatarChanges.map((change) => <article key={change.requestId}>
      <div><strong>{change.kind === "MERGE" ? "joi 建议合并 Avatar" : "joi 建议归档 Avatar"}</strong><span>{change.reason}</span><small>{change.kind === "MERGE" ? `${change.sourceAvatarId} → ${change.targetAvatarId ?? ""}` : change.sourceAvatarId}</small></div>
      <div className="row-actions"><button className="button ghost" onClick={() => void api.decideAvatarChange(change.requestId, "REJECT").then(refresh)} type="button">保留原样</button><button className="button danger-text" onClick={() => void api.decideAvatarChange(change.requestId, "CONFIRM").then(refresh)} type="button">{change.kind === "MERGE" ? "确认合并" : "确认归档"}</button></div>
    </article>)}</section>}
    <div className="joi-body">
      <div aria-label="joi 信息流" className="joi-feed">
        {feed.length === 0 ? <p className="joi-feed-empty">还没有动态。在下方告诉 joi 一个目标，或先用场景预设组建团队。</p> : feed.map((entry) => entry.kind === "input" ? <article className={`joi-feed-item${entry.message.status === "CLARIFICATION_REQUIRED" ? " needs-you" : ""}`} key={entry.id}>
          <div className="joi-feed-head"><span className="joi-feed-stage">{messageStage(entry.message.status, entry.message.canceled)}</span><span className="joi-feed-head-right"><time className="joi-feed-time">{new Date(entry.message.acceptedAt).toLocaleString()}</time>{entry.message.status === "CLARIFICATION_REQUIRED" ? <CancelInputButton api={api} inputId={entry.message.inputId} onCanceled={() => { void refresh(); }} /> : null}</span></div>
          {entry.message.textPreview === undefined ? null : <p className="joi-feed-text">{entry.message.textPreview}</p>}
          {entry.message.status === "CLARIFICATION_REQUIRED"
            ? <ClarificationActions api={api} avatars={snapshot.avatars} inputId={entry.message.inputId} onResolved={() => { void refresh(); }} reasonCode={entry.message.clarificationReasonCode} />
            : <p className="joi-feed-note">{entry.message.canceled === true ? "你已取消这条输入" : entry.message.status === "CONSUMED" ? "joi 已完成这轮归类和安排" : entry.message.status === "ROUTED" ? "joi 已派给搭档处理" : "joi 正在归类和安排"}</p>}
        </article> : <div className="joi-feed-process" key={entry.id}><strong>{entry.label}</strong><span>{entry.detail}</span><time>{new Date(entry.time).toLocaleString()}</time></div>)}
      </div>
      <aside aria-label="工作状态" className="joi-work-panel"><h2>工作状态</h2>{work.length === 0 ? <p className="joi-work-empty">当前没有运行中的工作</p> : <ul className="joi-active-work">{work.map((item) => <li key={item.workId}><strong>{item.title}</strong><span>{activityStatus(item.status)} · Avatar {item.avatarId}</span></li>)}</ul>}</aside>
    </div>
    {snapshot.partners.length >= 2 ? null : <div className="inline-notice warning"><span>{snapshot.partners.length === 0 ? "当前还没有工作搭档。" : `当前只有 ${String(snapshot.partners.length)} 个工作搭档。`}可以先用场景预设一键组建团队，或去搭档页手动创建 2-3 个。</span><span className="row-actions"><button className="button ghost" onClick={() => onNavigate?.("agents", "scenarios")} type="button">看场景预设</button><button className="button ghost" onClick={() => onNavigate?.("agents", "partners")} type="button">去搭档页创建</button></span></div>}
    <form className="joi-composer" onSubmit={(event) => void submit(event)}>
      <label className="joi-composer-label" htmlFor="joi-input">给 joi 输入</label>
      <textarea autoFocus id="joi-input" onChange={(event) => setText(event.target.value)} placeholder="描述目标、补充想法，或继续上一段对话…" rows={2} value={text} />
      <div className="joi-composer-toolbar">
        <label className="joi-attachment-button">添加附件<input aria-label="给 joi 添加附件" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 8))} type="file" /></label>
        {files.length === 0 ? null : <span className="joi-file-summary">{files.map((file) => file.name).join("、")}</span>}
        <button className="button primary" disabled={text.trim() === ""} type="submit">交给 joi</button>
      </div>
    </form>
    {error === null ? null : <p className="inline-notice danger" role="alert">{error}</p>}
  </section>;
}

function messageStage(status: JoiAcceptedMessageDto["status"], canceled = false): string {
  if (canceled) return "已取消";
  if (status === "ROUTED") return "joi 已归类";
  if (status === "CONSUMED") return "工作已安排";
  if (status === "CLARIFICATION_REQUIRED") return "需要你确认";
  return "输入已保存";
}

function clarificationText(code: string | undefined): string {
  if (code === "avatar_selection_invalid") return "joi 没法定位这条输入属于哪个上下文。在下方点选它对应的 Avatar，或补充更明确的项目/角色。";
  if (code === "avatar_creation_unavailable") return "joi 想新建一个 Avatar 来承接这条输入，但当前无法创建。请补充更明确的归属，或先到「Avatar」页手动创建。";
  if (code === "avatar_not_found") return "这条输入指向的 Avatar 已不存在。在下方点选它应归属的 Avatar，或补充项目/角色。";
  return "joi 需要你补充信息后才能继续。在下方补充细节，它会接着这条输入往下做。";
}

function activityLabel(kind: JoiActivityDto["kind"]): string {
  if (kind === "TURN") return "joi 正在思考";
  if (kind === "WORK") return "工作进展";
  if (kind === "PARTNER_RESULT") return "搭档结果";
  return "joi 动态";
}

function activityStatus(status: string): string {
  if (status === "RUNNING") return "进行中";
  if (status === "COMPLETED") return "已完成";
  if (status === "FAILED") return "失败";
  if (status === "PENDING") return "等待中";
  if (status === "CLARIFICATION_REQUIRED") return "需补充";
  if (status === "ROUTED") return "已派发";
  if (status === "CONSUMED") return "已处理";
  if (status === "READY") return "已就绪";
  if (status === "INTEGRATED") return "已整合";
  if (status === "WAITING") return "等待确认";
  return status;
}

type FeedEntry =
  | { id: string; kind: "input"; message: JoiAcceptedMessageDto; time: string }
  | { detail: string; id: string; kind: "process"; label: string; time: string };

function buildFeed(messages: JoiAcceptedMessageDto[], activity: JoiActivityDto[]): FeedEntry[] {
  const entries: FeedEntry[] = messages.map((message) => ({ id: `input:${message.inputId}`, kind: "input", message, time: message.acceptedAt }));
  for (const item of activity) {
    if (item.kind === "MESSAGE") continue;
    entries.push({ detail: activityStatus(item.status), id: `act:${item.activityId}`, kind: "process", label: activityLabel(item.kind), time: item.occurredAt });
  }
  return entries.sort((left, right) => (left.time < right.time ? 1 : left.time > right.time ? -1 : 0));
}

export function JoiHome({ api, onNavigate }: { api: DigitalLifeApi; onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void }) {
  const [snapshot, setSnapshot] = useState<JoiSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSnapshot(await api.joiSnapshot()); setError(null); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "没能读取 joi 的状态。"); }
  }, [api]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  if (error !== null) return <section className="content-state" role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">再试一次</button></section>;
  if (snapshot === null) return <section className="content-state" role="status">joi 正在整理全局状态…</section>;
  return snapshot.runtime.configured ? <JoiComposer api={api} {...(onNavigate === undefined ? {} : { onNavigate })} snapshot={snapshot} /> : <ModelSourceSetup api={api} changed={load} />;
}
