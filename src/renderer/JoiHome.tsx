import { type SyntheticEvent, useCallback, useEffect, useState } from "react";

import { MODEL_SOURCE_CHOICES, type JoiAcceptedMessageDto, type JoiSnapshotDto, type ModelSourceKindDto } from "../shared/joi";
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

function JoiComposer({ api, snapshot }: { api: DigitalLifeApi; snapshot: JoiSnapshotDto }) {
  const [text, setText] = useState("");
  const [accepted, setAccepted] = useState<JoiAcceptedMessageDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = text.trim();
    if (message === "") return;
    setText(""); setError(null);
    try {
      const saved = await api.sendJoiMessage(message);
      setAccepted((items) => [...items, saved]);
    } catch (reason) {
      setText(message);
      setError(reason instanceof ApiError ? reason.message : "输入没保存成功，请再试一次。");
    }
  };
  return <section className="joi-home" aria-labelledby="joi-home-title">
    <header><p className="eyebrow">唯一入口</p><h1 id="joi-home-title">现在想让 joi 做什么？</h1><p>你只管说目标。Avatar 归属、是否并发、找哪位搭档，都由 joi 判断和安排。</p></header>
    <div className="joi-work-overview"><strong>全局工作状态</strong><span>{snapshot.work.length === 0 ? "当前没有运行中的工作" : `${String(snapshot.work.length)} 项工作正在安排`}</span></div>
    <ol className="joi-accepted-list" aria-label="已保存输入">{accepted.map((item) => <li key={item.inputId}><strong>输入已保存</strong><span>joi 正在归类和安排 · {item.inputId}</span></li>)}</ol>
    <form className="joi-composer" onSubmit={(event) => void submit(event)}>
      <label htmlFor="joi-input">给 joi 输入</label>
      <textarea autoFocus id="joi-input" onChange={(event) => setText(event.target.value)} placeholder="描述目标、补充想法，或继续上一段对话…" rows={4} value={text} />
      <button className="button primary" disabled={text.trim() === ""} type="submit">交给 joi</button>
    </form>
    {error === null ? null : <p className="inline-notice danger" role="alert">{error}</p>}
  </section>;
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
