import { type SyntheticEvent, useCallback, useEffect, useState } from "react";

import { MODEL_SOURCE_CHOICES, type JoiAcceptedMessageDto, type JoiActivityDto, type JoiSnapshotDto, type ModelSourceKindDto, type PartnerDto } from "../shared/joi";
import { ApiError, type DigitalLifeApi } from "./api";

export function ModelSourceSetup({ api, changed }: { api: DigitalLifeApi; changed: () => Promise<void> }) {
  const [selected, setSelected] = useState<ModelSourceKindDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selected === null) return;
    const form = new FormData(event.currentTarget);
    const value = (key: string) => {
      const field = form.get(key);
      return typeof field === "string" ? field : "";
    };
    setBusy(true); setNotice("正在检查连接，这可能产生极少量模型费用…");
    try {
      const source = await api.createModelSource({
        apiKey: value("apiKey"),
        kind: selected,
        ...(selected === "generic-openai" ? {
          baseUrl: value("baseUrl"), displayName: value("displayName"), modelId: value("modelId"),
        } : value("modelId").trim() === "" ? {} : { modelId: value("modelId") }),
      });
      const validated = await api.validateModelSource(source.sourceId);
      setNotice(validated.status === "READY" ? "已连接，joi 可以开始思考了。" : "连接已保存，但还没有通过检查。你可以修改后再验证。");
      await changed();
      if (validated.status === "READY") setSelected(null);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "连接没检查成功，草稿仍可稍后重试。");
    } finally {
      setBusy(false);
    }
  };
  return <section className="joi-network-gate" aria-labelledby="joi-network-title">
    <p className="eyebrow">第一次见面</p>
    <h1 id="joi-network-title">joi需要链接到大模型网络</h1>
    <p>选一个你已有账号的主流模型网络。密钥加密保存在本机，不会在页面再次显示。</p>
    <div className="model-source-choices">{MODEL_SOURCE_CHOICES.map((choice) => <button className={selected === choice.kind ? "selected" : ""} key={choice.kind} onClick={() => setSelected(choice.kind)} type="button">连接 {choice.label}</button>)}</div>
    {selected === null ? null : <form className="model-source-form" onSubmit={(event) => void submit(event)}>
      <h2>{MODEL_SOURCE_CHOICES.find((choice) => choice.kind === selected)?.label}</h2>
      {selected === "generic-openai" ? <>
        <label>显示名称<input name="displayName" required /></label>
        <label>Base URL<input name="baseUrl" placeholder="https://api.example.com/v1" required type="url" /></label>
        <label>Model ID<input name="modelId" required /></label>
      </> : <label>Model ID（可选，高级设置）<input name="modelId" placeholder="留空使用推荐模型" /></label>}
      <label>API Key{selected === "generic-openai" ? "（本机 localhost 可留空）" : ""}<input autoComplete="off" name="apiKey" required={selected !== "generic-openai"} type="password" /></label>
      <div className="row-actions"><button className="button primary" disabled={busy} type="submit">{busy ? "正在检查…" : "保存并验证"}</button><button className="button ghost" onClick={() => setSelected(null)} type="button">取消</button></div>
    </form>}
    {notice === null ? null : <p className="inline-notice info" role="status">{notice}</p>}
  </section>;
}

export function ModelSourceManager({ api }: { api: DigitalLifeApi }) {
  const [sources, setSources] = useState<JoiSnapshotDto["modelSources"]>([]);
  const [adding, setAdding] = useState(false);
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
  return <section className="model-source-manager">
    <header><div><h2>大模型网络</h2><p>主源和备用源按这里的顺序使用。页面不会显示已保存的密钥。</p></div><button className="button quiet" onClick={() => setAdding((value) => !value)} type="button">{adding ? "收起" : "添加网络"}</button></header>
    {adding ? <ModelSourceSetup api={api} changed={async () => { await load(); setAdding(false); }} /> : null}
    <div className="model-source-list">{sources.map((source, index) => <article key={source.sourceId}>
      <div><strong>{source.displayName}</strong><span>{source.primary ? "主源" : `备用 ${String(index)}`} · {source.status} · {source.activeModel.id}</span>{source.baseUrl === undefined ? null : <small>{source.baseUrl}</small>}</div>
      <div className="row-actions"><button className="button ghost" disabled={index === 0} onClick={() => void reorder(index, -1)} type="button">上移</button><button className="button ghost" disabled={index === sources.length - 1} onClick={() => void reorder(index, 1)} type="button">下移</button><button className="button quiet" onClick={() => void api.validateModelSource(source.sourceId).then(load).catch(() => setNotice("验证没有通过。"))} type="button">验证</button><button className="button ghost" onClick={() => void api.updateModelSource(source.sourceId, { disabled: true }).then(load)} type="button">停用</button><button className="button danger-text" onClick={() => void api.deleteModelSource(source.sourceId).then(load)} type="button">删除</button></div>
    </article>)}</div>
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
  </section>;
}

function values(value: FormDataEntryValue | null): string[] {
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

export function PartnerManager({ api }: { api: DigitalLifeApi }) {
  const [partners, setPartners] = useState<PartnerDto[]>([]);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => setPartners((await api.listPartners()).items), [api]);
  useEffect(() => { const timer = setTimeout(() => void load().catch(() => setNotice("没能读取统一搭档列表。")), 0); return () => clearTimeout(timer); }, [load]);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value.trim() : "";
    };
    const kind = field("kind") === "a2a" ? "a2a" as const : "local-pi" as const;
    if (kind === "a2a") {
      await api.addAgent(field("cardUrl"), field("token"));
    } else {
      await api.createPartner({
        capabilities: values(form.get("capabilities")),
        displayName: field("displayName"),
        kind,
        ...(field("prompt") === "" ? {} : { prompt: field("prompt") }),
        skills: values(form.get("skills")),
        tools: values(form.get("tools")),
        ...(field("workspaceRef") === "" ? {} : { workspaceRef: field("workspaceRef") }),
      });
    }
    setAdding(false);
    setNotice("搭档列表已先更新；之后的新派发会固定使用这个 revision。");
    await load();
  };
  return <section className="partner-manager page-section">
    <header className="page-title-row"><div><p className="eyebrow">joi 的统一搭档目录</p><h1>搭档</h1><p>本机 Pi 与远端 A2A 都先登记能力、工作目录、提示词和工具，再由 joi 派发。</p></div><button className="button primary" onClick={() => setAdding((value) => !value)} type="button">{adding ? "收起" : "添加搭档"}</button></header>
    {adding ? <form className="partner-form" onSubmit={(event) => void submit(event)}>
      <label>名称<input name="displayName" required /></label><label>类型<select name="kind"><option value="local-pi">本机 Pi</option><option value="a2a">远端 A2A</option></select></label>
      <label>远端 Agent Card URL<input name="cardUrl" placeholder="仅远端 A2A 填写" type="url" /></label><label>远端 Bearer Token<input autoComplete="off" name="token" placeholder="仅远端 A2A 填写" type="password" /></label>
      <label>能力标签（逗号分隔）<input name="capabilities" /></label><label>Skills（逗号分隔）<input name="skills" /></label><label>工具 allowlist（逗号分隔）<input name="tools" placeholder="read, grep, edit" /></label>
      <label>工作目录<input name="workspaceRef" placeholder="仅本机保存，不在列表返回" /></label><label>搭档提示词<textarea name="prompt" placeholder="仅本机保存，不在列表返回" rows={4} /></label>
      <button className="button primary" type="submit">保存搭档 revision</button>
    </form> : null}
    {partners.length === 0 ? <div className="plain-empty"><h2>还没有搭档</h2><p>添加本机 Pi 或远端 A2A 搭档后，joi 才会把工作派发给它。</p></div> : null}
    <div className="partner-list">{partners.map((partner) => <article key={partner.partnerId}><div><strong>{partner.displayName}</strong><span>{partner.kind === "local-pi" ? "本机 Pi" : "远端 A2A"} · revision {String(partner.registryRevision)} · {partner.status}</span><small>{[...partner.capabilities, ...partner.skills, ...partner.tools].join(" · ") || "尚未声明能力"}</small></div>{partner.status === "ACTIVE" ? <button className="button ghost" onClick={() => void api.disablePartner(partner.partnerId).then(load)} type="button">停用</button> : null}</article>)}</div>
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
  </section>;
}

function JoiComposer({ api, snapshot }: { api: DigitalLifeApi; snapshot: JoiSnapshotDto }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [accepted, setAccepted] = useState<JoiAcceptedMessageDto[]>([]);
  const [activity, setActivity] = useState<JoiActivityDto[]>([]);
  const [work, setWork] = useState(snapshot.work);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [messages, timeline, state] = await Promise.all([api.listJoiMessages(), api.listJoiActivity(), api.joiSnapshot()]);
    setAccepted(messages.items);
    setActivity(timeline.items);
    setWork(state.work);
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
  return <section className="joi-home" aria-labelledby="joi-home-title">
    <header><p className="eyebrow">唯一入口</p><h1 id="joi-home-title">现在想让 joi 做什么？</h1><p>你只管说目标。Avatar 归属、是否并发、找哪位搭档，都由 joi 判断和安排。</p></header>
    <div className="joi-work-overview"><strong>全局工作状态</strong><span>{work.length === 0 ? "当前没有运行中的工作" : `${String(work.length)} 项工作正在安排`}</span></div>
    {work.length === 0 ? null : <div className="joi-active-work">{work.map((item) => <article key={item.workId}><strong>{item.title}</strong><span>{item.status} · Avatar {item.avatarId}</span></article>)}</div>}
    <ol className="joi-accepted-list" aria-label="已保存输入">{accepted.map((item) => <li key={item.inputId}><strong>{messageStage(item.status)}</strong><span>{item.status === "CLARIFICATION_REQUIRED" ? "joi 需要你补充信息" : item.status === "CONSUMED" ? "joi 已完成这轮归类和安排" : "joi 正在归类和安排"}</span></li>)}</ol>
    {activity.length === 0 ? null : <section className="joi-activity"><h2>最近活动</h2><ol>{activity.slice(0, 12).map((item) => <li key={`${item.kind}:${item.activityId}`}><strong>{activityLabel(item.kind)}</strong><span>{item.status} · {new Date(item.occurredAt).toLocaleString()}</span></li>)}</ol></section>}
    <form className="joi-composer" onSubmit={(event) => void submit(event)}>
      <label htmlFor="joi-input">给 joi 输入</label>
      <textarea autoFocus id="joi-input" onChange={(event) => setText(event.target.value)} placeholder="描述目标、补充想法，或继续上一段对话…" rows={4} value={text} />
      <label className="joi-attachment-button">添加附件（最多 8 个，每个 10 MiB）<input aria-label="给 joi 添加附件" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []).slice(0, 8))} type="file" /></label>
      {files.length === 0 ? null : <span className="joi-file-summary">{files.map((file) => file.name).join("、")}</span>}
      <button className="button primary" disabled={text.trim() === ""} type="submit">交给 joi</button>
    </form>
    {error === null ? null : <p className="inline-notice danger" role="alert">{error}</p>}
  </section>;
}

function messageStage(status: JoiAcceptedMessageDto["status"]): string {
  if (status === "ROUTED") return "joi 已归类";
  if (status === "CONSUMED") return "工作已安排";
  if (status === "CLARIFICATION_REQUIRED") return "需要你确认";
  return "输入已保存";
}

function activityLabel(kind: JoiActivityDto["kind"]): string {
  if (kind === "TURN") return "joi 正在思考";
  if (kind === "WORK") return "工作状态";
  if (kind === "PARTNER_RESULT") return "搭档结果";
  return "输入状态";
}

export function JoiHome({ api }: { api: DigitalLifeApi }) {
  const [snapshot, setSnapshot] = useState<JoiSnapshotDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSnapshot(await api.joiSnapshot()); setError(null); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "没能读取 joi 的状态。"); }
  }, [api]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  if (error !== null) return <section className="content-state" role="alert"><p>{error}</p><button className="button quiet" onClick={() => void load()} type="button">再试一次</button></section>;
  if (snapshot === null) return <section className="content-state" role="status">joi 正在整理全局状态…</section>;
  return snapshot.runtime.configured ? <JoiComposer api={api} snapshot={snapshot} /> : <ModelSourceSetup api={api} changed={load} />;
}
