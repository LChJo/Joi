import { ResultExportMenu } from './ResultExportMenu';
import { WorkbenchEvolutionPanel } from './EvolutionSettings';
import { type SyntheticEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClockIcon, XIcon } from "@phosphor-icons/react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { MODEL_SOURCE_CHOICES, type AgentConversationEntryDto, type AgentConversationPageDto, type WorkbenchAgentCardDto, type WorkbenchAgentStatusDto, type WorkbenchArtifactDto, type WorkbenchDetailDto, type WorkbenchDto, type JoiAcceptedMessageDto, type JoiGoalCardDto, type JoiGoalHarnessDto, type JoiHomeFeedDto, type JoiSnapshotDto, type JoiThinkingItemDto, type ModelSourceAccessModeDto, type ModelSourceKindDto, type ModelSourceProtocolDto, type PartnerDto } from "../shared/joi";
import { ApiError, type DigitalLifeApi } from "./api";

const SAFE_MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => href !== undefined && /^https?:\/\//iu.test(href) ? <a href={href} rel="noreferrer" target="_blank">{children}</a> : <span>{children}</span>,
  img: ({ alt }) => <span className="agent-remote-image">[图片{alt === undefined ? "" : `：${alt}`}]</span>,
};

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
  if (reasonCode === "empty_response") return "接口已响应，但未返回有效正文。请稍后重新验证，若持续出现请检查模型与协议兼容性。";
  if (reasonCode === "response_truncated") return "验证回复达到输出上限而被截断，可能与模型思考模式有关。请重新验证，若持续出现请检查模型与协议兼容性。";
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
  const removeSource = async (sourceId: string) => {
    setNotice(null);
    try {
      await api.deleteModelSource(sourceId);
      setEditing((current) => current === sourceId ? null : current);
      setNotice("模型网络已删除。");
      await load();
    } catch {
      setNotice("模型网络未删除，请重试。");
    }
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
      <div aria-label={`${source.displayName} 操作`} className="row-actions model-source-actions" role="group"><button aria-label={`编辑 ${source.displayName}`} className="button ghost" onClick={() => setEditing(source.sourceId)} type="button">编辑</button><button className="button ghost" disabled={index === 0} onClick={() => void reorder(index, -1)} type="button">上移</button><button className="button ghost" disabled={index === sources.length - 1} onClick={() => void reorder(index, 1)} type="button">下移</button><button className="button quiet" onClick={() => void api.validateModelSource(source.sourceId).then(load).catch(() => setNotice("验证没有通过。"))} type="button">验证</button><button className="button ghost" onClick={() => void api.updateModelSource(source.sourceId, { disabled: true }).then(load)} type="button">停用</button><button className="button danger-text" onClick={() => void removeSource(source.sourceId)} type="button">删除</button></div>
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

function ArtifactCard({ api, artifact, source, sourceId, workbenchId }: {
  api: DigitalLifeApi;
  artifact: WorkbenchArtifactDto;
  source: "AGENT" | "GOAL";
  sourceId: string;
  workbenchId: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const available = api.desktop && artifact.artifactId !== undefined;
  const activate = async (mode: "OPEN" | "REVEAL") => {
    if (artifact.artifactId === undefined) return;
    setNotice(mode === "OPEN" ? "正在打开…" : "正在定位…");
    try {
      await api.openWorkbenchArtifact(workbenchId, { artifactId: artifact.artifactId, mode, source, sourceId });
      setNotice(mode === "OPEN" ? "已交给系统打开。" : "已在文件夹中定位。");
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "这个产物暂时无法打开。");
    }
  };
  return <div className={`agent-artifact ${available ? "actionable" : ""}`}>
    <span className="agent-artifact-copy"><strong>{artifact.name}</strong><span>{artifact.kind === "DIRECTORY" ? "文件夹" : artifact.mimeType} · {String(artifact.size)} B</span></span>
    {available ? <button
      aria-label={`打开产物 ${artifact.name}`}
      className="button ghost agent-artifact-open"
      onClick={() => void activate("OPEN")}
      onContextMenu={(event) => { event.preventDefault(); void activate("REVEAL"); }}
      title="点击打开；右键在文件夹中定位"
      type="button"
    >{artifact.kind === "DIRECTORY" ? "打开文件夹" : "打开"}</button> : null}
    {notice === null ? null : <small className="agent-artifact-notice" role="status">{notice}</small>}
  </div>;
}

function groupAgentEntries(items: AgentConversationEntryDto[]) {
  const groups: { entry: AgentConversationEntryDto; entries: AgentConversationEntryDto[] }[] = [];
  for (const entry of items) {
    const previous = groups.at(-1);
    const isTool = entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT";
    if (isTool && entry.toolName !== undefined && previous?.entry.toolName === entry.toolName
      && (previous.entry.kind === "TOOL_CALL" || previous.entry.kind === "TOOL_RESULT")) {
      previous.entries.push(entry);
    } else { groups.push({ entry, entries: [entry] }); }
  }
  return groups;
}

function ToolEntry({ entry, entries }: { entry: AgentConversationEntryDto; entries: AgentConversationEntryDto[] }) {
  if (entries.length > 1) {
    const calls = entries.filter((item) => item.kind === "TOOL_CALL").length;
    const results = entries.length - calls;
    return <article className="agent-message tool"><details className="agent-tool-compact">
      <summary><span>工具</span><code>{entry.toolName} ×{Math.max(calls, results)}</code><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></summary>
      {entries.map((item) => <div key={item.entryId}><small>{item.kind === "TOOL_CALL" ? "调用工具" : "工具结果"} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></small>{item.text ? <pre>{item.text}</pre> : null}</div>)}
    </details></article>;
  }
  const label = entry.kind === "TOOL_CALL" ? "调用工具" : "工具结果";
  return <article className={`agent-message tool ${entry.kind.toLowerCase()}`}>
    <details className={`agent-tool-compact ${entry.kind === "TOOL_RESULT" ? "result" : ""}`}>
      <summary><span>{label}</span><code>{entry.toolName ?? (entry.kind === "TOOL_CALL" ? "tool" : "")}</code><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></summary>
      {entry.text === undefined || entry.text === "" ? null : <pre>{entry.text}</pre>}
    </details>
  </article>;
}

function GoalArtifacts({ api, goal }: { api: DigitalLifeApi; goal: JoiGoalCardDto }) {
  if (goal.artifacts === undefined || goal.artifacts.length === 0) return null;
  return <section aria-label="结论产物" className="joi-goal-artifacts">
    <h3>产物</h3>
    {goal.artifacts.map((artifact) => <ArtifactCard
      api={api} artifact={artifact} key={artifact.artifactId ?? `${artifact.name}:${String(artifact.size)}`}
      source="GOAL" sourceId={goal.goalId} workbenchId={goal.workbench.workbenchId}
    />)}
  </section>;
}

function mergeConversationItems(older: AgentConversationEntryDto[], newer: AgentConversationEntryDto[]) {
  return [...new Map([...older, ...newer].map(entry => [entry.entryId, entry])).values()]
    .sort((a, b) => a.sequence - b.sequence || a.entryId.localeCompare(b.entryId));
}

export function AgentMessageStream({ agent, api, workbenchId, goalId, live = false }: {
  agent: WorkbenchAgentCardDto;
  api: DigitalLifeApi;
  workbenchId: string;
  goalId?: string;
  live?: boolean;
}) {
  const [page, setPage] = useState<AgentConversationPageDto | null>(null);
  const [following, setFollowing] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const currentPage = useRef<AgentConversationPageDto | null>(null);
  const followLatest = useRef(true);
  const positioned = useRef(false);
  const historyBusy = useRef(false);
  const historyAnchor = useRef<{ height: number; top: number } | null>(null);
  const generation = useRef(0);
  const publish = useCallback((next: AgentConversationPageDto) => { currentPage.current = next; setPage(next); }, []);
  const read = useCallback((cursor?: string) => api.agentConversation(workbenchId, agent.agentId, {
    limit: 50, latest: true, ...(goalId === undefined ? {} : { goalId }), ...(cursor === undefined ? {} : { cursor }),
  }), [agent.agentId, api, goalId, workbenchId]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const previous = currentPage.current;
        let next = await read();
        // Catch up after a slow/background tab without leaving a hole between pages.
        const known = new Set(previous?.items.map(item => item.entryId));
        const cursors = new Set<string>();
        while (!cancelled && known.size > 0 && next.nextCursor !== undefined
          && !next.items.some(item => known.has(item.entryId)) && !cursors.has(next.nextCursor)) {
          cursors.add(next.nextCursor);
          const older = await read(next.nextCursor);
          next = { ...older, agent: next.agent, items: mergeConversationItems(older.items, next.items) };
        }
        if (cancelled) return;
        const current = currentPage.current;
        publish(current === null || current.items.length === 0 ? next : {
          ...current, agent: next.agent, items: mergeConversationItems(current.items, next.items),
        });
        setNotice(null);
      } catch (error) {
        if (!cancelled) setNotice(error instanceof ApiError ? error.message : "没能读取 Agent 对话。");
      } finally {
        const status = currentPage.current?.agent.status;
        if (!cancelled && live && (status === undefined || status === "RUNNING" || status === "WAITING")) timer = setTimeout(() => void load(), 750);
      }
    };
    timer = setTimeout(() => void load(), 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [live, publish, read]);
  useEffect(() => () => { generation.current += 1; }, [read]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (element === null) return;
    if (followLatest.current) element.scrollTop = element.scrollHeight;
    else if (historyAnchor.current !== null) element.scrollTop = historyAnchor.current.top + element.scrollHeight - historyAnchor.current.height;
    historyAnchor.current = null;
    if (!positioned.current && page !== null && page.items.length > 0) {
      positioned.current = true;
      element.scrollIntoView({ block: "end", inline: "nearest" });
    }
  }, [page]);
  const loadMore = useCallback(async () => {
    const cursor = currentPage.current?.nextCursor;
    if (cursor === undefined || historyBusy.current) return;
    const revision = generation.current;
    historyBusy.current = true;
    setLoadingHistory(true);
    try {
      const next = await read(cursor);
      if (revision !== generation.current) return;
      const element = viewport.current;
      if (element !== null) historyAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
      const current = currentPage.current;
      publish({ ...next, agent: current?.agent ?? next.agent, items: mergeConversationItems(next.items, current?.items ?? []) });
      setNotice(null);
    } catch (error) {
      if (revision === generation.current) setNotice(error instanceof ApiError ? error.message : "没能读取更早记录，向上滚动可重试。");
    } finally {
      historyBusy.current = false;
      if (revision === generation.current) setLoadingHistory(false);
    }
  }, [publish, read]);
  useEffect(() => {
    // Compact tool groups can leave a page shorter than the viewport: fill it so
    // history is reachable even when there is no scrollbar yet.
    const timer = setTimeout(() => {
      const element = viewport.current;
      if (element !== null && element.clientHeight > 0 && element.scrollHeight <= element.clientHeight) void loadMore();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadMore, page]);
  return <>
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
    <div className="agent-stream-viewport" ref={viewport} role="log" aria-label="Agent 执行记录" aria-live="off" tabIndex={0} onScroll={() => {
      const element = viewport.current;
      if (element === null || element.clientHeight === 0) return;
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      followLatest.current = atBottom;
      setFollowing(atBottom);
      if (element.scrollTop < 64 && !atBottom) void loadMore();
    }}>
    {page?.nextCursor === undefined ? null : <p className="agent-history-hint">{loadingHistory ? "正在加载历史记录…" : "向上滚动查看更早记录"}</p>}
    {page === null ? <p className="content-state">正在整理对话…</p> : <div className="agent-message-stream">{page.items.length === 0 ? <p className="plain-empty">这位 Agent 还没有可展示的执行消息。</p> : groupAgentEntries(page.items).map(({ entry, entries }) => entry.kind === "TOOL_CALL" || entry.kind === "TOOL_RESULT"
      ? <ToolEntry entry={entry} entries={entries} key={entry.entryId} />
      : <article className={`agent-message ${entry.role.toLowerCase()} ${entry.kind.toLowerCase()}`} key={entry.entryId}>
      <header><strong>{entry.role === "USER" ? "任务" : entry.role === "AGENT" ? agent.partnerName : entry.role === "TOOL" ? "工具" : "系统"}</strong><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></header>
      {entry.kind === "ARTIFACT" && entry.artifact !== undefined
        ? <ArtifactCard api={api} artifact={entry.artifact} source="AGENT" sourceId={agent.agentId} workbenchId={workbenchId} />
        : entry.kind === "ARTIFACT" ? <div className="agent-artifact"><span className="agent-artifact-copy"><strong>产物</strong><span>文件 · 0 B</span></span></div>
          : <ReactMarkdown components={SAFE_MARKDOWN_COMPONENTS} remarkPlugins={[remarkGfm]} skipHtml>{entry.text ?? ""}</ReactMarkdown>}
    </article>)}</div>}
    </div>
    {following ? null : <button className="button ghost agent-load-more" onClick={() => {
      followLatest.current = true;
      setFollowing(true);
      if (viewport.current !== null) {
        viewport.current.scrollTop = viewport.current.scrollHeight;
        viewport.current.scrollIntoView({ block: "end", inline: "nearest" });
      }
    }} type="button">回到最新</button>}
  </>;
}

function AgentConversation({ agent, api, workbenchId, onBack }: {
  agent: WorkbenchAgentCardDto;
  api: DigitalLifeApi;
  workbenchId: string;
  onBack: () => void;
}) {
  return <section className="agent-conversation" aria-label={`${agent.partnerName} 对话`}>
    <header className="agent-detail-header"><button className="button ghost" onClick={onBack} type="button">返回 Agent 列表</button><div><p className="eyebrow">只读执行记录</p><h2>{agent.partnerName}</h2><span>{agent.transport} · {agent.sessionPolicy} · {agent.status}</span></div></header>
    <AgentMessageStream key={agent.agentId} agent={agent} api={api} workbenchId={workbenchId} live={agent.status === "RUNNING" || agent.status === "WAITING"} />
  </section>;
}

function formatWorkbenchUpdated(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function WorkbenchManager({ api, initialWorkbenchId }: { api: DigitalLifeApi; initialWorkbenchId?: string }) {
  const [removing, setRemoving] = useState<{ workbenchId: string; name: string } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removeLock = useRef(false);
  const removeDialog = useRef<HTMLElement>(null);
  useEffect(() => {
    if (removing === null) return;
    const previousFocus = document.activeElement;
    removeDialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, [removing]);
  const [workbenches, setWorkbenches] = useState<WorkbenchDto[]>([]);
  const [detail, setDetail] = useState<WorkbenchDetailDto | null>(null);
  const [agents, setAgents] = useState<WorkbenchAgentCardDto[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<WorkbenchAgentCardDto | null>(null);
  const [tab, setTab] = useState<"agents" | "context" | "evolution">("agents");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => setWorkbenches((await api.listWorkbenches()).items), [api]);
  const loadAgents = useCallback(async (workbenchId: string) => {
    try {
      const page = await api.listWorkbenchAgents(workbenchId, { limit: 100 });
      setAgents(Array.isArray(page.items) ? page.items : []);
    }
    catch { setAgents([]); }
  }, [api]);
  const open = useCallback(async (workbenchId: string, nextTab: "agents" | "context" | "evolution" = "agents") => {
    try {
      setDetail(await api.getWorkbench(workbenchId));
      setSelectedAgent(null); setTab(nextTab); setNotice(null);
      await loadAgents(workbenchId);
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "没能读取工作台上下文。"); }
  }, [api, loadAgents]);
  useEffect(() => { const timer = setTimeout(() => void load().catch(() => setNotice("没能读取工作台列表。")), 0); return () => clearTimeout(timer); }, [load]);
  useEffect(() => {
    if (initialWorkbenchId === undefined) return;
    const timer = setTimeout(() => void open(initialWorkbenchId), 0);
    return () => clearTimeout(timer);
  }, [initialWorkbenchId, open]);
  useEffect(() => {
    if (detail === null || selectedAgent !== null) return undefined;
    const timer = setInterval(() => void loadAgents(detail.workbenchId), 1_500);
    return () => clearInterval(timer);
  }, [detail, loadAgents, selectedAgent]);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    await api.createWorkbench({ name: field("name"), personaSummary: field("personaSummary"), projectLabel: field("projectLabel"), scopeSummary: field("scopeSummary") });
    setAdding(false); setNotice("工作台已创建；之后的任务上下文仍由 joi 归属和管理。"); await load();
  };
  const saveDetail = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); if (detail === null) return;
    const form = new FormData(event.currentTarget);
    const field = (name: string) => { const value = form.get(name); return typeof value === "string" ? value.trim() : ""; };
    const persona = field("persona");
    try {
      setDetail(await api.updateWorkbench(detail.workbenchId, { name: field("name"), ...(persona === "" ? {} : { persona }), projectLabel: field("projectLabel"), responsibility: field("responsibility") }));
      setNotice("工作台上下文已更新。"); await load();
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "工作台没保存成功。"); }
  };
  const workspaceAction = async (action: "bind" | "rebuild") => {
    if (detail === null) return;
    try {
      if (action === "bind") await api.bindWorkbenchWorkspace(detail.workbenchId); else await api.rebuildWorkbenchWorkspace(detail.workbenchId);
      await open(detail.workbenchId); setTab("context");
      setNotice(action === "bind" ? "已绑定现有目录。" : "已切换为默认运行目录，新任务将创建独立目录。");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "工作区操作没有完成。"); }
  };
  const removeAgent = async (agent: WorkbenchAgentCardDto) => {
    if (detail === null) return;
    try { await api.deleteWorkbenchAgent(detail.workbenchId, agent.agentId); await loadAgents(detail.workbenchId); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "Agent 没有删除。"); }
  };
  const requestRemoval = (workbench: { workbenchId: string; name: string }) => {
    setRemoveError(null); setRemoving(workbench);
  };
  const removeWorkbench = async () => {
    if (removing === null || removeLock.current) return;
    removeLock.current = true; setRemoveBusy(true); setRemoveError(null);
    try {
      await api.archiveWorkbench(removing.workbenchId);
      setWorkbenches((items) => items.filter((item) => item.workbenchId !== removing.workbenchId));
      setDetail(null); setAgents([]); setSelectedAgent(null); setRemoving(null);
      setNotice("工作台已移除，历史记录和工作目录已保留。");
    } catch (error) {
      setRemoveError(error instanceof ApiError && error.code === "workbench_change_active_work"
        ? "工作台仍有未结束的任务，请先完成或取消任务后再移除。"
        : "工作台没有移除，请重试。");
    } finally { removeLock.current = false; setRemoveBusy(false); }
  };
  if (detail !== null && selectedAgent !== null) return <AgentConversation agent={selectedAgent} api={api} workbenchId={detail.workbenchId} onBack={() => setSelectedAgent(null)} />;
  return <section className="partner-manager page-section">
    {removing === null ? null : <div className="dialog-backdrop"><section aria-labelledby="remove-workbench-title" aria-modal="true" className="dialog" ref={removeDialog} role="dialog" tabIndex={-1} onKeyDown={(event) => {
      if (event.key === "Escape" && !removeBusy) setRemoving(null);
      if (event.key === "Tab") {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const next = buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
        event.preventDefault(); (next ?? event.currentTarget).focus();
      }
    }}>
      <h2 id="remove-workbench-title">移除“{removing.name}”？</h2>
      <p>工作台将从列表移除，不再接收新任务。历史记录和工作目录会保留。有未结束的任务时无法移除。</p>
      {removeError === null ? null : <p role="alert">{removeError}</p>}
      <div className="row-actions"><button className="button ghost" disabled={removeBusy} onClick={() => setRemoving(null)} type="button">取消</button><button className="button danger-text" disabled={removeBusy} onClick={() => void removeWorkbench()} type="button">{removeBusy ? "正在移除…" : "确认移除"}</button></div>
    </section></div>}
    <header className="page-title-row"><div><p className="eyebrow">工作台 / Agent</p><h1>{detail?.name ?? "工作台"}</h1><p>{detail === null ? "每个工作台保存一个长期上下文，Agent 是它实际启动的工作者。" : "这里始终展示这个工作台启动过且尚未删除的全部 Agent。"}</p></div>{detail === null ? <button className={adding ? "button quiet" : "button primary"} onClick={() => setAdding((value) => !value)} type="button">{adding ? "收起" : "创建工作台"}</button> : <div className="row-actions"><button className="button danger-text" onClick={() => requestRemoval(detail)} type="button">移除工作台</button><button className="button ghost" onClick={() => { setDetail(null); setAgents([]); }} type="button">返回工作台列表</button></div>}</header>
    {detail === null && adding ? <form className="partner-form" onSubmit={(event) => void submit(event)}><label>名称<input name="name" placeholder="工作聚类名称，如：前端调试分析" required /></label><label>工程名称<input name="projectLabel" placeholder="工作环境 / 工程，如：数字生活" required /></label><label>职责范围<textarea name="scopeSummary" placeholder="描述这类工作共享的环境和边界" required rows={4} /></label><label>人格摘要<textarea name="personaSummary" placeholder="描述工作环境的长期约束，不要写单个 Agent 角色" required rows={4} /></label><button className="button primary" type="submit">保存工作台</button></form> : null}
    {detail === null ? (workbenches.length === 0 ? <div className="plain-empty"><h2>还没有工作台</h2><p>直接从首页告诉 joi 目标，它也可以按需要创建。</p></div> : <div className="workbench-catalog">{workbenches.map((workbench) => <article className="workbench-catalog-entry" key={workbench.workbenchId}><button aria-label={`打开工作台 ${workbench.name}`} className="workbench-catalog-open" onClick={() => void open(workbench.workbenchId)} type="button"><span className="workbench-catalog-head"><span aria-hidden="true" className="workbench-orb">{workbench.name.slice(0, 1)}</span><strong>{workbench.name}</strong></span><span className="workbench-catalog-scope" title={workbench.scopeSummary}>{workbench.scopeSummary}</span></button><footer className="workbench-catalog-footer"><time dateTime={workbench.updatedAt} title={new Date(workbench.updatedAt).toLocaleString()}>更新于 {formatWorkbenchUpdated(workbench.updatedAt)}</time><span className="workbench-catalog-actions"><button aria-label={`管理上下文 ${workbench.name}`} className="workbench-catalog-manage" onClick={() => void open(workbench.workbenchId, "context")} type="button">管理上下文</button><button aria-label={`移除工作台 ${workbench.name}`} className="button danger-text workbench-catalog-remove" onClick={() => requestRemoval(workbench)} type="button">移除工作台</button></span></footer></article>)}</div>) : <>
      <div className="workbench-detail-tabs" role="tablist"><button aria-selected={tab === "agents"} onClick={() => setTab("agents")} role="tab" type="button">Agent <span>{agents.length}</span></button><button aria-selected={tab === "context"} onClick={() => setTab("context")} role="tab" type="button">上下文设置</button><button aria-selected={tab === "evolution"} onClick={() => setTab("evolution")} role="tab" type="button">自主进化</button></div>
      {tab === "agents" ? <div className="workbench-agent-list">{agents.length === 0 ? <div className="plain-empty"><h2>还没有 Agent</h2><p>当 joi 为这个工作台安排实际工作后，Agent 会出现在这里。</p></div> : agents.map((agent) => <article className="workbench-agent-card" key={agent.agentId}><button aria-label={`查看 ${agent.partnerName} 详情`} className="workbench-agent-open" onClick={() => setSelectedAgent(agent)} type="button"><span className="agent-workbench">{agent.partnerName.slice(0, 1)}</span><span><strong>{agent.partnerName}</strong><small>{agent.transport} · {agent.engine} · {agent.sessionPolicy}</small></span><i className={`agent-status ${agent.status.toLowerCase()}`}>{agent.status}</i><time>{new Date(agent.lastActivityAt).toLocaleString()}</time></button>{agent.canDelete ? <button aria-label={`删除 ${agent.partnerName}`} className="button danger-text agent-delete" onClick={() => void removeAgent(agent)} type="button">删除</button> : null}</article>)}</div> : tab === "context" ? <div className="workbench-context-center">
        <form className="partner-form" onSubmit={(event) => void saveDetail(event)}><label>名称<input defaultValue={detail.name} name="name" required /></label><label>工程名称<input defaultValue={detail.projectLabel} name="projectLabel" required /></label><label>职责范围<textarea defaultValue={detail.responsibility} name="responsibility" required rows={4} /></label><label>提交新人格 revision（留空保持当前）<textarea name="persona" rows={4} /></label><button className="button primary" type="submit">保存上下文</button></form>
        <article className="context-card"><h3>工作区</h3><p>{detail.workspace.kind === "BOUND" ? "此工作台的新任务固定使用指定目录。" : "每个新任务在用户主目录 joi/runs 下创建独立目录；恢复和重试复用原目录。"}</p><p><strong>{detail.workspace.kind === "BOUND" ? detail.workspace.displayName : "默认运行目录"}</strong> · {detail.workspace.kind} · {detail.workspace.status}</p>{detail.workspace.failureReasonCode === undefined ? null : <small>{detail.workspace.failureReasonCode}</small>}<div className="row-actions"><button className="button ghost" onClick={() => void workspaceAction("bind")} type="button">绑定已有目录</button><button className="button ghost" onClick={() => void workspaceAction("rebuild")} type="button">使用默认运行目录</button></div></article>
        <article className="context-card"><h3>活跃工作</h3>{detail.activeWork.length === 0 ? <p>当前没有非终态工作。</p> : <ul>{detail.activeWork.map((work) => <li key={work.workId}>{work.title} · {work.status}</li>)}</ul>}</article>
        <article className="context-card"><h3>最近结果总结</h3>{detail.recentOutcomes.length === 0 ? <p>还没有目标级结果总结。</p> : <ul>{detail.recentOutcomes.map((item) => <li key={`${item.goalId}:${String(item.resultRevision)}`}><strong>{item.title}</strong><span>{item.summary}</span><small>{recentOutcomeLabel(item.status)} · {new Date(item.completedAt).toLocaleString()}</small></li>)}</ul>}</article>
      </div> : <div className="workbench-context-center"><WorkbenchEvolutionPanel api={api} key={detail.workbenchId} workbenchId={detail.workbenchId} /></div>}
    </>}
    {notice === null ? null : <p className="inline-notice info">{notice}</p>}
  </section>;
}

interface WorkbenchProposal {
  description: string;
  name: string;
  personaSummary: string;
  projectLabel: string;
  scopeSummary: string;
}

function workbenchProposals(seed?: string): WorkbenchProposal[] {
  const cleaned = seed?.replace(/\s+/gu, " ").replace(/[「」"'`]/gu, "").trim();
  const label = cleaned === undefined || cleaned === "" ? "当前任务" : cleaned.length > 18 ? `${cleaned.slice(0, 18)}…` : cleaned;
  return [
    {
      description: "按这条输入隔离上下文，由 joi 持续整理目标、资料和执行结果。",
      name: `${label} 工作台`,
      personaSummary: "由 joi 维护长期上下文，先确认事实，再安排可验证的执行。",
      projectLabel: label,
      scopeSummary: `围绕“${label}”的目标、资料与执行过程。`,
    },
    {
      description: "适合 SDK、API、应用开发和调试，保留连续的工程上下文。",
      name: "AI 应用开发工作台",
      personaSummary: "关注 SDK/API 集成、应用开发和可验证交付，保持工程上下文连续。",
      projectLabel: "AI 应用开发",
      scopeSummary: "Claude Code、SDK、API 集成、应用开发与调试。",
    },
    {
      description: "适合 monitor、告警、性能和线上问题，集中沉淀排查结论。",
      name: "监控与可观测性工作台",
      personaSummary: "优先建立可观察事实，谨慎分析告警、性能和线上行为，不把猜测当结论。",
      projectLabel: "监控与可观测性",
      scopeSummary: "monitor、日志、告警、性能分析和线上问题排查。",
    },
  ];
}

function ClarificationActions({ api, partners, workbenchId, workbenches, inputId, onResolved, prompt, questionId, questionVersion, reasonCode, suggestionSeed }: {
  api: DigitalLifeApi;
  partners: PartnerDto[];
  workbenchId: string | undefined;
  workbenches: WorkbenchDto[];
  inputId: string;
  onResolved: () => void;
  prompt: string | undefined;
  questionId: string | undefined;
  questionVersion: number | undefined;
  reasonCode: string | undefined;
  suggestionSeed?: string;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingWorkbench, setCreatingWorkbench] = useState(false);
  const [createdWorkbench, setCreatedWorkbench] = useState<WorkbenchDto | null>(null);
  const [workbenchQuery, setWorkbenchQuery] = useState("");
  const isQuestion = reasonCode === "question_required";
  const needsPartnerChoice = reasonCode === "partner_selection_required";
  const needsWaitingRecovery = reasonCode === "partner_waiting_recovery_required" || reasonCode === "partner_auth_required";
  const needsGoalContinuation = reasonCode === "goal_continuation_required";
  const needsReviewRetry = reasonCode === "goal_review_interrupted";
  const needsWorkspace = reasonCode === "workbench_workspace_not_ready";
  const needsWorkbenchChoice = reasonCode === "workbench_selection_invalid" || reasonCode === "workbench_creation_unavailable" || reasonCode === "workbench_not_found";
  const needsHistoricalReview = reasonCode === "harness_review_unrecoverable";
  const assignedWorkbench = workbenches.find((workbench) => workbench.workbenchId === workbenchId);
  const proposals = workbenchProposals(suggestionSeed);
  const selectableWorkbenches = createdWorkbench === null || workbenches.some((workbench) => workbench.workbenchId === createdWorkbench.workbenchId)
    ? workbenches
    : [...workbenches, createdWorkbench];
  const showWorkbenchSearch = selectableWorkbenches.length > 6;
  const normalizedWorkbenchQuery = workbenchQuery.trim().toLowerCase();
  const visibleWorkbenches = !showWorkbenchSearch || normalizedWorkbenchQuery === ""
    ? selectableWorkbenches
    : selectableWorkbenches.filter((workbench) => `${workbench.name} ${workbench.scopeSummary}`.toLowerCase().includes(normalizedWorkbenchQuery));
  const selectablePartners = partners.filter((partner) => partner.status === "ACTIVE" && partner.configuration === undefined);
  const resolve = async (resolution: { actionChoice?: "RESUME" | "CONTINUE" | "ACCEPT_CURRENT"; partnerId?: string; workbenchId?: string; text?: string }) => {
    setBusy(true); setNotice(null);
    try {
      await api.clarifyJoiMessage(inputId, { ...resolution, ...(questionId === undefined || questionVersion === undefined ? {} : { questionId, questionVersion }) });
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
  const createWorkbenchAndResolve = async (proposal: WorkbenchProposal) => {
    if (createdWorkbench?.name === proposal.name) {
      await resolve({ workbenchId: createdWorkbench.workbenchId });
      return;
    }
    setBusy(true); setNotice(null);
    try {
      const created = await api.createWorkbench({
        name: proposal.name,
        personaSummary: proposal.personaSummary,
        projectLabel: proposal.projectLabel,
        scopeSummary: proposal.scopeSummary,
      });
      setCreatedWorkbench(created);
      setCreatingWorkbench(false);
      await api.clarifyJoiMessage(inputId, { workbenchId: created.workbenchId, ...(questionId === undefined || questionVersion === undefined ? {} : { questionId, questionVersion }) });
      setNotice("工作台已创建，正在重新安排…");
      setDraft("");
      onResolved();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "工作台没有创建成功，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const chooseWorkspace = async () => {
    if (workbenchId === undefined) {
      setNotice("这条任务还没有关联工作台，暂时不能选择工作目录。");
      return;
    }
    setBusy(true); setNotice(null);
    try {
      await api.bindWorkbenchWorkspace(workbenchId);
      await api.clarifyJoiMessage(inputId, { workbenchId, ...(questionId === undefined || questionVersion === undefined ? {} : { questionId, questionVersion }) });
      setNotice("工作目录已绑定，joi 正在继续安排…");
      onResolved();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "工作目录没有绑定成功，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return <div className="joi-clarify">
    <p className="joi-clarify-label">{needsHistoricalReview ? "joi 正在整理历史状态" : "joi 需要你确认"}</p>
    <p className="joi-clarify-reason">{clarificationText(reasonCode, prompt, assignedWorkbench?.name)}</p>
    {needsHistoricalReview ? <div className="joi-clarify-workspace">
      <div><strong>已交给 joi 自动校正</strong><span>Joi 会依据已完成的 Work 和闭合路径收敛状态，不会重放历史评审。若事实仍不足以证明完成，请取消这条任务，并用新的输入重新描述后续要求。</span></div>
    </div> : needsPartnerChoice ? <>
      {selectablePartners.length === 0 ? <p className="joi-clarify-hint">当前没有可用搭档。请先到「搭档」页修复或创建搭档。</p> : null}
      {selectablePartners.length === 0 ? null : <div className="joi-clarify-partner-list" role="group" aria-label="选择一个搭档继续任务">
        {selectablePartners.map((partner) => <button className="joi-clarify-partner" disabled={busy} key={partner.partnerId} onClick={() => void resolve({ partnerId: partner.partnerId })} type="button">
          <strong>{partner.displayName}</strong>
          <span>{partner.description ?? (partner.kind === "local-pi" ? "本地搭档" : "远程搭档")}</span>
        </button>)}
      </div>}
    </> : needsWorkbenchChoice ? <>
      {selectableWorkbenches.length === 0 ? <p className="joi-clarify-hint">还没有可选的工作台；可以直接新增一个，或补充更明确的项目/角色。</p> : null}
      <div className="joi-clarify-workbench-picker" aria-label="点选这条输入归属的工作台">
        {showWorkbenchSearch ? <label className="joi-clarify-workbench-search">搜索工作台<input aria-label="搜索工作台" onChange={(event) => setWorkbenchQuery(event.target.value)} placeholder="按名称或范围搜索…" type="search" value={workbenchQuery} /></label> : null}
        <div className="joi-clarify-workbench-list" role="group" aria-label="选择一个工作台继续">
          {visibleWorkbenches.length === 0 ? <p className="joi-clarify-hint">没有匹配的工作台，请换个关键词。</p> : visibleWorkbenches.map((workbench) => <button aria-label={workbench.name} className="joi-clarify-workbench-option" disabled={busy} key={workbench.workbenchId} onClick={() => void resolve({ workbenchId: workbench.workbenchId })} type="button">
            <strong>{workbench.name}</strong><span>{workbench.scopeSummary}</span>
          </button>)}
        </div>
        <button className="joi-clarify-chip joi-clarify-new-workbench" disabled={busy} onClick={() => { setCreatingWorkbench(true); setNotice(null); }} type="button">新增工作台</button>
      </div>
      {creatingWorkbench ? <section aria-label="joi 建议的工作台方案" className="joi-clarify-proposals">
        <div><strong>joi 建议了几个工作台方案</strong><span>选择一个后，joi 会直接创建并继续这条输入。</span></div>
        <div className="joi-clarify-proposal-list">
          {proposals.map((proposal) => <button className="joi-clarify-proposal" disabled={busy} key={proposal.name} onClick={() => void createWorkbenchAndResolve(proposal)} type="button">
            <strong>{proposal.name}</strong><span>{proposal.description}</span>
          </button>)}
        </div>
        <div className="row-actions">
          <button className="button quiet" disabled={busy} onClick={() => { setCreatingWorkbench(false); setNotice(null); }} type="button">取消</button>
        </div>
      </section> : null}
    </> : null}
    {needsHistoricalReview || needsPartnerChoice ? null : needsReviewRetry ? <div className="joi-clarify-workspace">
      <div><strong>重新核对已有工作</strong><span>已有回答和工作结果已保留，joi 会核对后继续。</span></div>
      <button className="button primary" disabled={busy} onClick={() => void resolve({ text: "沿用已保存的回答，重试评审。" })} type="button">{busy ? "提交中…" : "重试评审"}</button>
    </div> : needsGoalContinuation ? <div className="joi-clarify-workspace">
      <div><strong>选择如何收口</strong><span>继续会再授权最多两轮自动补充；接受现状会保留当前结论和已注明的缺口。</span></div>
      <span className="row-actions">
        <button className="button primary" disabled={busy} onClick={() => void resolve({ actionChoice: "CONTINUE" })} type="button">{busy ? "提交中…" : "继续补齐"}</button>
        <button className="button quiet" disabled={busy} onClick={() => void resolve({ actionChoice: "ACCEPT_CURRENT" })} type="button">接受现状</button>
      </span>
    </div> : needsWaitingRecovery ? <div className="joi-clarify-workspace">
      <div><strong>恢复原工作</strong><span>joi 会使用已保存的 Work 和搭档会话继续，不会重新创建一份任务。</span></div>
      <button className="button primary" disabled={busy} onClick={() => void resolve({ actionChoice: "RESUME" })} type="button">{busy ? "恢复中…" : "继续原工作"}</button>
    </div> : needsWorkspace ? <div className="joi-clarify-workspace">
      <div><strong>{assignedWorkbench?.name ?? "当前工作台"}</strong><span>选择后只保存安全的工作区标识，不会在页面或接口中暴露绝对路径。</span></div>
      <button className="button primary" disabled={busy || workbenchId === undefined} onClick={() => void chooseWorkspace()} type="button">{busy ? "选择中…" : "选择工作目录"}</button>
    </div> : creatingWorkbench ? null : <div className="joi-clarify-add">
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

function ComposerWorkbenchPicker({ workbenches, onSelect, selected }: {
  workbenches: WorkbenchDto[];
  onSelect: (workbenchId: string | null) => void;
  selected: WorkbenchDto | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const showSearch = workbenches.length > 6;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleWorkbenches = !showSearch || normalizedQuery === ""
    ? workbenches
    : workbenches.filter((workbench) => `${workbench.name} ${workbench.scopeSummary}`.toLowerCase().includes(normalizedQuery));
  const toggle = () => setOpen((current) => {
    if (current) setQuery("");
    return !current;
  });
  const choose = (workbenchId: string | null) => { onSelect(workbenchId); setQuery(""); setOpen(false); };
  return <div className="joi-workbench-picker">
    <button aria-expanded={open} aria-haspopup="dialog" className="joi-workbench-button" onClick={toggle} type="button">
      {selected === undefined ? "joi 自主分发" : `分发给 ${selected.name}`}
    </button>
    {open ? <div aria-label="选择工作台" className="joi-workbench-menu" role="dialog">
      {showSearch ? <label className="joi-workbench-search">搜索工作台<input aria-label="搜索工作台" onChange={(event) => setQuery(event.target.value)} placeholder="按名称或范围搜索…" type="search" value={query} /></label> : null}
      <div aria-label="工作台列表" className="joi-workbench-options" role="group">
        {visibleWorkbenches.length === 0 ? <small className="joi-workbench-empty">没有匹配的工作台，请换个关键词。</small> : visibleWorkbenches.map((workbench) => <button aria-label={workbench.name} className="button ghost" key={workbench.workbenchId} onClick={() => choose(workbench.workbenchId)} type="button">{workbench.name}</button>)}
      </div>
    </div> : null}
  </div>;
}


function goalStatusLabel(status: JoiGoalCardDto["status"]): string {
  if (status === "ARRANGING") return "正在安排";
  if (status === "ARRANGED") return "排队中";
  if (status === "RUNNING") return "执行中";
  if (status === "REVIEWING") return "正在评审";
  if (status === "EXTENDING") return "评审后补充执行";
  if (status === "NEEDS_ATTENTION") return "需要你";
  if (status === "FINALIZING") return "正在总结";
  if (status === "COMPLETED") return "已完成";
  if (status === "COMPLETED_WITH_GAPS") return "已完成（有缺口）";
  if (status === "FAILED") return "处理失败";
  return "已取消";
}

function recentOutcomeLabel(status: WorkbenchDetailDto["recentOutcomes"][number]["status"]): string {
  if (status === "COMPLETED_WITH_GAPS") return "已完成（有缺口）";
  if (status === "FAILED") return "处理失败";
  if (status === "CANCELED") return "已取消";
  return "已完成";
}

const ACTIVE_GOAL_STATUSES: ReadonlySet<JoiGoalCardDto["status"]> = new Set(["ARRANGING", "ARRANGED", "RUNNING", "REVIEWING", "EXTENDING", "FINALIZING"]);

function GoalStatusBadge({ status }: { status: JoiGoalCardDto["status"] }) {
  return <span className={`joi-goal-status ${status.toLowerCase()}`}>{ACTIVE_GOAL_STATUSES.has(status) ? <i aria-hidden="true" className="joi-goal-status-dot" /> : null}{goalStatusLabel(status)}</span>;
}

function GoalProgress({ goal }: { goal: JoiGoalCardDto }) {
  const percent = goal.status === "COMPLETED" || goal.status === "COMPLETED_WITH_GAPS"
    ? 100
    : goal.work.total === 0 ? 0 : Math.round((goal.work.completed / goal.work.total) * 100);
  return <span className="joi-goal-progress">
    <span aria-hidden="true" className="joi-goal-progress-track"><i style={{ width: `${String(percent)}%` }} /></span>
    <i>{goal.agentCount} Agent · {goal.work.completed}/{goal.work.total} 工作完成</i>
  </span>;
}

function GoalAgentWarning({ goal, onOpen }: { goal: JoiGoalCardDto; onOpen: () => void }) {
  if ((goal.status !== "COMPLETED" && goal.status !== "COMPLETED_WITH_GAPS") || goal.work.failed === 0) return null;
  return <button
    aria-label={`查看 ${String(goal.work.failed)} 个异常搭档`}
    className="joi-goal-agent-warning"
    onClick={onOpen}
    type="button">
    {String(goal.work.failed)} 个搭档异常 · 查看详情
  </button>;
}

function GoalFailureNotice({ failure }: { failure: NonNullable<JoiGoalCardDto["failure"]> }) {
  const action = failure.suggestedAction === "RESTART_OR_UPDATE"
    ? "这是 joi 的内部配置问题。请重启或升级 joi 后重新提交；如果再次出现，请导出诊断信息反馈。"
    : failure.suggestedAction === "CHECK_MODEL_SOURCE"
      ? "请在设置中检查主模型源的网络、凭证和可用状态，重新验证后再提交。"
      : "请重新提交一次；如果再次失败，请导出诊断信息反馈。";
  return <section className="joi-goal-failure" role="alert">
    <strong>joi 已停止重试</strong>
    <p>已自动尝试 {String(failure.attempts)} 次，现已停止重试。{failure.executionStarted ? "任务已经开始执行，部分工作可能已有结果。" : "尚未启动 Agent，也没有派发工作。"}</p>
    <p>{action}</p>
    <small>诊断编号：{failure.reasonCode}</small>
  </section>;
}

const TERMINAL_GOAL_STATUSES: readonly JoiGoalCardDto["status"][] = ["CANCELED", "COMPLETED", "COMPLETED_WITH_GAPS", "FAILED"];

function goalRetryHint(status: JoiGoalCardDto["status"]): string {
  if (status === "FAILED") return "问题处理好后，可以继续这条任务。补充新的要求，或留空直接重新派发。";
  if (status === "CANCELED") return "这条任务之前被取消了。可以基于原目标继续，也可以补充新的要求。";
  return "这条目标已经收官。补充后续要求，joi 会接着这个上下文继续。";
}

function GoalRetryPanel({ api, goal, onDone }: {
  api: DigitalLifeApi;
  goal: JoiGoalCardDto;
  onDone: (accepted: JoiAcceptedMessageDto) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const submit = () => {
    if (busy) return;
    setBusy(true); setNotice(null);
    const text = draft.trim();
    void api.retryJoiMessage(goal.goalId, { ...(text === "" ? {} : { text }) })
      .then((accepted) => onDone(accepted))
      .catch((reason: unknown) => setNotice(reason instanceof ApiError ? reason.message : "没能继续这条目标，请重试。"))
      .finally(() => setBusy(false));
  };
  const sendNegativeFeedback = () => {
    if (feedbackBusy) return;
    setFeedbackBusy(true); setFeedback(null);
    void api.evolutionNegativeFeedback(goal.workbench.workbenchId, goal.goalId)
      .then((status) => setFeedback(status.reason === "rolled_back"
        ? "已回退该策略并暂停自动进化；运行中的目标保留原策略。"
        : "已记录反馈。这条目标没有运行当前策略，无需回退。"))
      .catch((reason: unknown) => setFeedback(reason instanceof ApiError && reason.code === "evolution_goal_invalid"
        ? "这条目标没有绑定进化策略，无需反馈。"
        : "没能提交策略反馈，请重试。"))
      .finally(() => setFeedbackBusy(false));
  };
  return <div className="joi-goal-retry joi-clarify">
    <p className="joi-clarify-reason">{goalRetryHint(goal.status)}</p>
    {busy ? <div aria-label="正在提交继续请求" className="joi-retry-submitting" role="status">
      <span aria-hidden="true" className="joi-thinking-dot" />
      <span><strong>正在提交继续请求</strong><small>joi 确认接收后，会立即进入“正在安排”。</small></span>
    </div> : null}
    <div className="joi-clarify-add">
      <input aria-label="补充说明" disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submit(); } }} placeholder="补充要求（可留空，直接继续）" value={draft} />
      <button className="button quiet" disabled={busy} onClick={submit} type="button">{busy ? "正在交给 joi…" : "继续"}</button>
    </div>
    {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
    <div className="joi-goal-feedback">
      <button className="button ghost" disabled={feedbackBusy} onClick={sendNegativeFeedback} title="如果这条目标的结果明显糟糕，向运行它的进化策略提交负反馈；命中当前策略时会回退并暂停自动进化" type="button">{feedbackBusy ? "正在提交反馈…" : "反馈策略没帮上忙"}</button>
      {feedback === null ? null : <p className="field-hint" role="status">{feedback}</p>}
    </div>
  </div>;
}

function optimisticRetryFeed(feed: JoiHomeFeedDto, goal: JoiGoalCardDto): JoiHomeFeedDto {
  const startedAt = new Date().toISOString();
  const nextGoal: JoiGoalCardDto = {
    agentCount: 0,
    canDelete: false,
    goalId: goal.goalId,
    ...(goal.harness === undefined ? {} : { harness: goal.harness }),
    status: "ARRANGING",
    title: goal.title,
    updatedAt: startedAt,
    work: { active: 0, completed: 0, failed: 0, total: 0 },
    workbench: goal.workbench,
  };
  return {
    ...feed,
    goals: feed.goals.map((item) => item.goalId === goal.goalId ? nextGoal : item),
    thinking: [{
      agentCount: 0,
      goalId: goal.goalId,
      phase: "queued",
      stage: "ROUTING",
      startedAt,
      turnId: `pending:${goal.goalId}`,
      work: { active: 0, completed: 0, failed: 0, total: 0 },
    }, ...feed.thinking.filter((item) => item.goalId !== goal.goalId)],
  };
}

const THINKING_STAGE_LABELS: Record<JoiThinkingItemDto["stage"], string> = {
  ROUTING: "正在整理任务",
  PLANNING: "正在拆分工作",
  DISPATCHING: "正在安排搭档",
  RUNNING: "搭档执行中",
  WAITING: "等待搭档回应",
  FINALIZING: "正在汇总结果",
  REVIEWING: "正在评审结果",
  EXTENDING: "评审后补充执行",
};

type JoiThinkingRenderItem = Omit<JoiThinkingItemDto, "agentCount" | "stage" | "work"> & Partial<Pick<JoiThinkingItemDto, "agentCount" | "stage" | "work">>;

function thinkingStageLabel(stage: JoiThinkingRenderItem["stage"]): string {
  return stage === undefined ? "正在整理任务" : THINKING_STAGE_LABELS[stage];
}

function thinkingElapsed(startedAt: string, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000));
  if (elapsedSeconds < 60) return `${String(elapsedSeconds)} 秒`;
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${String(minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)} 小时${minutes % 60 === 0 ? "" : ` ${String(minutes % 60)} 分钟`}`;
}

function thinkingWorkSummary(item: JoiThinkingRenderItem): string {
  const work = item.work ?? { active: 0, completed: 0, failed: 0, total: 0 };
  const agentCount = item.agentCount ?? 0;
  const parts = [
    agentCount > 0 ? `${String(agentCount)} Agent` : null,
    work.total > 0 ? `${String(work.completed)}/${String(work.total)} 工作完成` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}

function HarnessPanel({ harness }: { harness: JoiGoalHarnessDto }) {
  return <article className="joi-goal-harness">
    <p className="joi-goal-harness-destination">
      {harness.destination === undefined ? "目的地未命名（joi 将在复盘中命名）" : `目的地：${harness.destination}`}
      {harness.mapStatus === "CLEARED" ? " · 地图已收官" : ""}
    </p>
    {harness.topPaths.length === 0 ? null : <ul className="joi-goal-harness-paths">
      {harness.topPaths.map((pathItem) => <li className={`joi-harness-path ${pathItem.status.toLowerCase()}`} key={pathItem.pathId}>{pathItem.title}</li>)}
    </ul>}
    <p className="joi-goal-harness-counts">已决策 {String(harness.decisionCount)} · 雾区 {String(harness.fogCount)} · 第 {String(harness.currentLayer)} 层路径</p>
    {harness.topFogNote === undefined ? null : <p className="joi-goal-harness-fog">雾区：{harness.topFogNote}</p>}
  </article>;
}

function GoalDetail({ api, partners, workbenches, goal, initialAgentStatus, onBack, onResolved, onRetried, onScheduleGoal }: {
  api: DigitalLifeApi;
  partners: PartnerDto[];
  workbenches: WorkbenchDto[];
  goal: JoiGoalCardDto;
  initialAgentStatus?: WorkbenchAgentStatusDto;
  onScheduleGoal?: (goalId: string) => void;
  onBack: () => void;
  onResolved: () => void;
  onRetried: (goal: JoiGoalCardDto) => void;
}) {
  const [agents, setAgents] = useState<WorkbenchAgentCardDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadAgents = useCallback(async () => {
    try {
      const page = await api.listWorkbenchAgents(goal.workbench.workbenchId, { goalId: goal.goalId, limit: 100 });
      const items = Array.isArray(page.items) ? page.items : [];
      setAgents(items);
      setNotice(null);
      setSelectedAgentId((current) => current !== null && items.some((agent) => agent.agentId === current)
        ? current
        : (items.find((agent) => agent.status === initialAgentStatus)?.agentId ?? items[0]?.agentId ?? null));
    } catch {
      setNotice("没能读取这条目标的 Agent 列表。");
    }
  }, [api, goal.workbench.workbenchId, goal.goalId, initialAgentStatus]);
  useEffect(() => {
    const initial = setTimeout(() => void loadAgents(), 0);
    const interval = setInterval(() => void loadAgents().catch(() => undefined), 1_500);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [loadAgents]);
  const selectedAgent = agents.find((agent) => agent.agentId === selectedAgentId);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onBack(); };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; };
  }, [onBack]);
  return <div className="joi-drawer-backdrop" onClick={onBack} role="presentation">
    <section aria-label={`${goal.workbench.name} 的目标详情`} aria-modal="true" className="joi-goal-drawer" onClick={(event) => event.stopPropagation()} role="dialog">
      <header className="joi-goal-detail-header">
        <div className="joi-goal-detail-title">
          <p className="eyebrow">{goal.workbench.name}</p>
          <h1>{goal.title}</h1>
          <span className="joi-goal-detail-meta"><GoalStatusBadge status={goal.status} /><GoalProgress goal={goal} /></span>
        </div>
        <div className="joi-goal-detail-actions">
          <button aria-label="关闭" className="icon-button joi-goal-detail-close" onClick={onBack} title="关闭" type="button"><XIcon aria-hidden size={18} /></button>
          {onScheduleGoal === undefined ? null : <button className="button joi-goal-schedule" onClick={() => onScheduleGoal(goal.goalId)} title="设置当前目标的定时继续计划" type="button"><ClockIcon aria-hidden size={16} /><span>定时</span></button>}
        </div>
      </header>
      <div className="joi-goal-drawer-body">
        {goal.harness === undefined ? null : <HarnessPanel harness={goal.harness} />}
        {goal.failure === undefined ? null : <GoalFailureNotice failure={goal.failure} />}
        {goal.completionSummary === undefined ? null : <article className="joi-goal-result"><h2>最终结果</h2><div className="joi-md"><ReactMarkdown components={SAFE_MARKDOWN_COMPONENTS} remarkPlugins={[remarkGfm]} skipHtml>{goal.completionSummary}</ReactMarkdown></div><GoalArtifacts api={api} goal={goal} /></article>}
        <GoalAgentWarning goal={goal} onOpen={() => setSelectedAgentId(agents.find((agent) => agent.status === "FAILED")?.agentId ?? null)} />
        {goal.clarification === undefined ? null : <ClarificationActions api={api} partners={partners} workbenchId={goal.workbench.workbenchId} workbenches={workbenches} inputId={goal.goalId} onResolved={onResolved} prompt={goal.clarification.prompt} questionId={goal.clarification.questionId} questionVersion={goal.clarification.questionVersion} reasonCode={goal.clarification.reasonCode} suggestionSeed={goal.title} />}
        {TERMINAL_GOAL_STATUSES.includes(goal.status) ? <GoalRetryPanel api={api} goal={goal} onDone={() => onRetried(goal)} /> : null}
        {notice === null ? null : <p className="inline-notice danger" role="alert">{notice}</p>}
        <div className="joi-goal-detail-body">
          <aside aria-label="这条目标的 Agent 列表" className="joi-goal-agents">
            {agents.length === 0 ? <p className="plain-empty">joi 还没有为这条目标启动 Agent。</p> : agents.map((agent) => <button aria-pressed={agent.agentId === selectedAgentId} className={`joi-goal-agent ${agent.agentId === selectedAgentId ? "selected" : ""}`} key={agent.agentId} onClick={() => setSelectedAgentId(agent.agentId)} type="button">
              <span className="agent-workbench">{agent.partnerName.slice(0, 1)}</span>
              <span className="joi-goal-agent-copy"><strong>{agent.partnerName}</strong><small>{agent.transport} · {agent.engine}</small></span>
              <i className={`agent-status ${agent.status.toLowerCase()}`}>{agent.status}</i>
            </button>)}
          </aside>
          <div className="joi-goal-stream">
            {selectedAgent === undefined
              ? <p className="content-state">Agent 启动后，这里会直接展示它的执行数据流和结果。</p>
              : <AgentMessageStream agent={selectedAgent} api={api} workbenchId={goal.workbench.workbenchId} goalId={goal.goalId} key={`${goal.goalId}:${selectedAgent.agentId}`} live={selectedAgent.status === "RUNNING" || selectedAgent.status === "WAITING"} />}
          </div>
        </div>
      </div>
    </section>
  </div>;
}

function GoalResultView({ api, goal, onBack, onOpenDetail, onRetried }: {
  api: DigitalLifeApi;
  goal: JoiGoalCardDto;
  onBack: () => void;
  onOpenDetail: (preferredStatus?: WorkbenchAgentStatusDto) => void;
  onRetried: (goal: JoiGoalCardDto) => void;
}) {
  const [body] = useState(goal.completionSummary ?? "");
  const [exportMenu, setExportMenu] = useState(false);
  const close = () => { if (exportMenu) setExportMenu(false); else onBack(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { if (exportMenu) setExportMenu(false); else onBack(); } };
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; };
  }, [onBack, exportMenu]);
  return <div className="joi-drawer-backdrop" onClick={close} role="presentation">
    <section aria-label={`${goal.workbench.name} 的最终结果`} aria-modal="true" className="joi-goal-drawer joi-result-drawer" onClick={(event) => { event.stopPropagation(); setExportMenu(false); }} role="dialog">
      <header className="joi-goal-detail-header">
        <div className="joi-goal-detail-title">
          <p className="eyebrow">{goal.workbench.name}</p>
          <h1>{goal.title}</h1>
          <span className="joi-goal-detail-meta"><GoalStatusBadge status={goal.status} />{goal.completedAt === undefined ? null : <time className="joi-feed-time">{new Date(goal.completedAt).toLocaleString()}</time>}</span>
        </div>
        <div className="row-actions"><button className="button ghost" disabled={goal.workbench.workbenchId === ""} onClick={() => onOpenDetail()} type="button">查看详情</button><button className="button quiet" onClick={close} type="button">关闭</button></div>
      </header>
      <div className="joi-goal-drawer-body">
        <article className="joi-goal-result"><h2>最终结果</h2><div className="joi-md"><ReactMarkdown components={SAFE_MARKDOWN_COMPONENTS} remarkPlugins={[remarkGfm]} skipHtml>{body}</ReactMarkdown></div><GoalArtifacts api={api} goal={goal} /></article>
        <GoalAgentWarning goal={goal} onOpen={() => onOpenDetail("FAILED")} />
        {TERMINAL_GOAL_STATUSES.includes(goal.status) ? <GoalRetryPanel api={api} goal={goal} onDone={() => onRetried(goal)} /> : null}
      </div>
      <ResultExportMenu api={api} goalId={goal.goalId} body={body} expanded={exportMenu} onExpanded={setExportMenu} />
    </section>
  </div>;
}

const JOI_MAX_ATTACHMENTS = 8;
const JOI_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function JoiComposer({ api, onNavigate, onScheduleGoal, snapshot }: {
  api: DigitalLifeApi;
  onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void;
  onScheduleGoal?: (goalId: string) => void;
  snapshot: JoiSnapshotDto;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [targetWorkbenchId, setTargetWorkbenchId] = useState<string | null>(null);
  const targetWorkbench = snapshot.workbenches.find((workbench) => workbench.workbenchId === targetWorkbenchId);
  const [feed, setFeed] = useState<JoiHomeFeedDto>({ goals: [], thinking: [], unassignedActions: [] });
  const [feedError, setFeedError] = useState(false);
  const [openGoalId, setOpenGoalId] = useState<string | null>(null);
  const [openGoalAgentStatus, setOpenGoalAgentStatus] = useState<WorkbenchAgentStatusDto | undefined>(undefined);
  const [resultGoal, setResultGoal] = useState<JoiGoalCardDto | null>(null);
  const [retryGoalId, setRetryGoalId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [workbenchChanges, setWorkbenchChanges] = useState(snapshot.workbenchChanges);
  const [error, setError] = useState<string | null>(null);
  const feedRevisionRef = useRef(0);
  const loadFeed = useCallback(async (revision = feedRevisionRef.current) => {
    try {
      const loaded = await api.joiHomeFeed();
      if (!Array.isArray(loaded.goals) || !Array.isArray(loaded.thinking) || !Array.isArray(loaded.unassignedActions)) throw new Error("joi_home_feed_invalid");
      if (revision !== feedRevisionRef.current) return;
      setFeed(loaded);
      setFeedError(false);
    } catch {
      if (revision !== feedRevisionRef.current) return;
      // Inbox routing/consumption is not execution/completion evidence.
      // Keep the last authoritative projection until this endpoint recovers.
      setFeedError(true);
    }
  }, [api]);
  const refresh = useCallback(async () => {
    const revision = feedRevisionRef.current;
    const state = await api.joiSnapshot();
    await loadFeed(revision);
    if (revision !== feedRevisionRef.current) return;
    setWorkbenchChanges(state.workbenchChanges);
  }, [api, loadFeed]);
  useEffect(() => {
    const initial = setTimeout(() => void loadFeed().catch(() => undefined), 0);
    const interval = setInterval(() => void refresh().catch(() => undefined), 1_500);
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => { clearTimeout(initial); clearInterval(interval); clearInterval(clock); };
  }, [loadFeed, refresh]);
  const addFiles = (incoming: Iterable<File>) => {
    const oversized: string[] = [];
    const accepted: File[] = [];
    let dropped = 0;
    for (const file of incoming) {
      if (file.size > JOI_MAX_ATTACHMENT_BYTES) {
        oversized.push(file.name);
        continue;
      }
      if (files.length + accepted.length >= JOI_MAX_ATTACHMENTS) {
        dropped += 1;
        continue;
      }
      if ([...files, ...accepted].some((existing) => existing.name === file.name && existing.size === file.size)) continue;
      accepted.push(file);
    }
    if (accepted.length > 0) setFiles([...files, ...accepted]);
    const notices: string[] = [];
    if (oversized.length > 0) notices.push(`「${oversized.join("」「")}」超过 10 MiB，没有添加。`);
    if (dropped > 0) notices.push(`最多只能添加 ${String(JOI_MAX_ATTACHMENTS)} 个附件，多出的没有添加。`);
    setError(notices.length === 0 ? null : notices.join(" "));
  };
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = text.trim();
    if (message === "") return;
    setText(""); setError(null);
    try {
      const uploaded = await Promise.all(files.map((file) => api.uploadJoiAttachment(file)));
      const saved = await api.sendJoiMessage(message, {
        ...(uploaded.length === 0 ? {} : { attachmentIds: uploaded.map((item) => item.attachmentId) }),
        ...(targetWorkbench === undefined ? {} : { workbenchId: targetWorkbench.workbenchId }),
      });
      setFiles([]);
      setFeed((current) => ({ ...current, thinking: [{
        agentCount: 0,
        goalId: saved.inputId,
        phase: "queued",
        stage: "ROUTING",
        startedAt: saved.acceptedAt,
        turnId: `pending:${saved.inputId}`,
        work: { active: 0, completed: 0, failed: 0, total: 0 },
      }, ...current.thinking] }));
      void refresh().catch(() => undefined);
    } catch (reason) {
      setText(message);
      setError(reason instanceof ApiError ? reason.message : "输入没保存成功，请再试一次。");
    }
  };
  const visibleThinking = useMemo(() => feed.thinking.filter((item) => item.phase === "queued" || item.phase === "progressing" || Date.parse(item.expiresAt ?? "") > now), [feed.thinking, now]);
  const openGoal = feed.goals.find((goal) => goal.goalId === openGoalId);
  const dismissGoal = (goalId: string) => setFeed((current) => ({ ...current, goals: current.goals.filter((goal) => goal.goalId !== goalId) }));
  const dismissAction = (inputId: string) => setFeed((current) => ({ ...current, unassignedActions: current.unassignedActions.filter((item) => item.inputId !== inputId) }));
  const markRetryStarted = (goal: JoiGoalCardDto) => {
    feedRevisionRef.current += 1;
    setFeed((current) => optimisticRetryFeed(current, goal));
    void refresh().catch(() => undefined);
  };
  return <section className="joi-home" aria-labelledby="joi-home-title">
    <header><h1 id="joi-home-title">现在想让 joi 做什么？</h1><p>你只管说目标。工作台归属、是否并发、找哪位搭档，都由 joi 判断和安排。</p></header>
    {feedError ? <div className="inline-notice danger" role="alert"><p>任务状态暂时无法刷新，已保留上次成功获取的数据。</p><button className="button quiet" onClick={() => void loadFeed()} type="button">重新加载任务状态</button></div> : null}
    {workbenchChanges.length === 0 ? null : <section className="joi-workbench-confirmations" aria-label="工作台变更确认"><h2>需要你确认</h2>{workbenchChanges.map((change) => <article key={change.requestId}>
      <div><strong>{change.kind === "MERGE" ? "joi 建议合并工作台" : "joi 建议归档工作台"}</strong><span>{change.reason}</span><small>{change.kind === "MERGE" ? `${change.sourceWorkbenchId} → ${change.targetWorkbenchId ?? ""}` : change.sourceWorkbenchId}</small></div>
      <div className="row-actions"><button className="button ghost" onClick={() => void api.decideWorkbenchChange(change.requestId, "REJECT").then(refresh)} type="button">保留原样</button><button className="button danger-text" onClick={() => void api.decideWorkbenchChange(change.requestId, "CONFIRM").then(refresh)} type="button">{change.kind === "MERGE" ? "确认合并" : "确认归档"}</button></div>
    </article>)}</section>}
    {openGoal === undefined ? null : <GoalDetail api={api} partners={snapshot.partners} workbenches={snapshot.workbenches} goal={openGoal} {...(onScheduleGoal === undefined ? {} : { onScheduleGoal })} {...(openGoalAgentStatus === undefined ? {} : { initialAgentStatus: openGoalAgentStatus })} onBack={() => { setOpenGoalId(null); setOpenGoalAgentStatus(undefined); }} onResolved={() => void refresh().catch(() => undefined)} onRetried={markRetryStarted} />}
    {resultGoal?.completionSummary === undefined ? null : <GoalResultView api={api} goal={resultGoal} onBack={() => setResultGoal(null)} onOpenDetail={(preferredStatus) => { setResultGoal(null); setOpenGoalAgentStatus(preferredStatus); setOpenGoalId(resultGoal.goalId); }} onRetried={(retriedGoal) => { setResultGoal(null); markRetryStarted(retriedGoal); }} />}
    <div aria-label="joi 信息流" className="joi-feed joi-feed-single">
      {visibleThinking.map((item) => {
        const renderItem = item as JoiThinkingRenderItem;
        const isProgressing = item.phase !== "queued";
        const stageLabel = thinkingStageLabel(renderItem.stage);
        const workSummary = thinkingWorkSummary(renderItem);
        const accessibleSummary = isProgressing
          ? `${stageLabel}${workSummary === "" ? "" : `，${workSummary}`}`
          : "queued";
        return <div aria-label={accessibleSummary} className={`joi-thinking ${item.phase}`} key={item.turnId} role="status">
          <span aria-hidden="true" className="joi-thinking-dot" />
          <div className="joi-thinking-copy">
            <strong>{item.phase === "queued" ? "queued" : "progressing"}</strong>
            {isProgressing ? <span className="joi-thinking-summary">
              <span className="joi-thinking-stage">{stageLabel}</span>
              {workSummary === "" ? null : <span className="joi-thinking-meta">{workSummary}</span>}
              <span aria-hidden="true" className="joi-thinking-elapsed"> · 已用 {thinkingElapsed(item.startedAt, now)}</span>
            </span> : null}
          </div>
        </div>;
      })}
      {feed.unassignedActions.map((message) => <article className="joi-feed-item needs-you" key={message.inputId}><div className="joi-feed-head"><span className="joi-feed-stage">需要你确认</span><span className="joi-feed-head-right"><time className="joi-feed-time">{new Date(message.acceptedAt).toLocaleString()}</time><CancelInputButton api={api} inputId={message.inputId} onCanceled={() => dismissAction(message.inputId)} /></span></div>{message.textPreview === undefined ? null : <p className="joi-feed-text">{message.textPreview}</p>}<ClarificationActions api={api} partners={snapshot.partners} workbenchId={message.workbenchId} workbenches={snapshot.workbenches} inputId={message.inputId} onResolved={() => dismissAction(message.inputId)} prompt={message.clarificationPrompt} questionId={message.questionId} questionVersion={message.questionVersion} reasonCode={message.clarificationReasonCode} {...(message.textPreview === undefined ? {} : { suggestionSeed: message.textPreview })} /></article>)}
      {feed.goals.map((goal) => <article className={`joi-goal-card ${goal.status.toLowerCase()}`} key={goal.goalId}>
        <div className="joi-goal-row">
          <button className="joi-goal-open" disabled={goal.workbench.workbenchId === ""} onClick={() => { setResultGoal(null); setOpenGoalAgentStatus(undefined); setOpenGoalId(goal.goalId); }} type="button"><span className="workbench-orb">{goal.workbench.name.slice(0, 1)}</span><span className="joi-goal-copy"><small>{goal.workbench.name}</small><strong className="joi-goal-title">{goal.title}</strong><GoalProgress goal={goal} /></span></button>
          <div className="joi-goal-side"><GoalStatusBadge status={goal.status} /><div aria-label={`${goal.title} 操作`} className="joi-goal-actions" role="group">{TERMINAL_GOAL_STATUSES.includes(goal.status) ? null : <CancelInputButton api={api} inputId={goal.goalId} onCanceled={() => void refresh().catch(() => undefined)} />}{TERMINAL_GOAL_STATUSES.includes(goal.status) ? <button aria-label={`继续「${goal.title}」`} className="joi-goal-link" onClick={() => setRetryGoalId((current) => current === goal.goalId ? null : goal.goalId)} type="button">{retryGoalId === goal.goalId ? "收起" : "继续"}</button> : null}{goal.canDelete ? <DismissInputButton api={api} inputId={goal.goalId} onDismissed={() => dismissGoal(goal.goalId)} /> : null}</div></div>
        </div>
        {goal.completionSummary === undefined ? null : <div aria-haspopup="dialog" aria-label={`打开「${goal.title}」的最终结果全文`} className="joi-goal-result-preview joi-md" role="button" tabIndex={0} onClick={() => { setResultGoal(goal); setOpenGoalId(null); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setResultGoal(goal); setOpenGoalId(null); } }}><ReactMarkdown components={SAFE_MARKDOWN_COMPONENTS} remarkPlugins={[remarkGfm]} skipHtml>{goal.completionSummary}</ReactMarkdown></div>}
        {goal.failure === undefined ? null : <GoalFailureNotice failure={goal.failure} />}
        {goal.clarification === undefined ? null : <ClarificationActions api={api} partners={snapshot.partners} workbenchId={goal.workbench.workbenchId} workbenches={snapshot.workbenches} inputId={goal.goalId} onResolved={() => void refresh().catch(() => undefined)} prompt={goal.clarification.prompt} questionId={goal.clarification.questionId} questionVersion={goal.clarification.questionVersion} reasonCode={goal.clarification.reasonCode} suggestionSeed={goal.title} />}
        {retryGoalId === goal.goalId ? <GoalRetryPanel api={api} goal={goal} onDone={() => { setRetryGoalId(null); markRetryStarted(goal); }} /> : null}
      </article>)}
      {!feedError && visibleThinking.length === 0 && feed.unassignedActions.length === 0 && feed.goals.length === 0 ? <p className="joi-feed-empty">这里很干净。告诉 joi 一个目标，正在推进的工作会暂时出现在这里。</p> : null}
    </div>
    {snapshot.partners.length >= 2 ? null : <div className="inline-notice warning"><span>{snapshot.partners.length === 0 ? "当前还没有工作搭档。" : `当前只有 ${String(snapshot.partners.length)} 个工作搭档。`}可以先用场景预设一键组建团队，或去搭档页手动创建 2-3 个。</span><span className="row-actions"><button className="button ghost" onClick={() => onNavigate?.("agents", "scenarios")} type="button">看场景预设</button><button className="button ghost" onClick={() => onNavigate?.("agents", "partners")} type="button">去搭档页创建</button></span></div>}
    <div className="joi-composer-dock">
      <form
        className={`joi-composer${dragOver ? " drag-over" : ""}`}
        onDragLeave={(event) => { if (event.currentTarget.contains(event.relatedTarget as Node | null)) return; setDragOver(false); }}
        onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
        onDrop={(event) => { event.preventDefault(); setDragOver(false); addFiles(Array.from(event.dataTransfer.files)); }}
        onSubmit={(event) => void submit(event)}>
        <label className="joi-composer-label" htmlFor="joi-input">给 joi 输入</label>
        <textarea autoFocus id="joi-input" onChange={(event) => setText(event.target.value)} onPaste={(event) => {
          const pasted = Array.from(event.clipboardData.files);
          if (pasted.length === 0) return;
          event.preventDefault();
          addFiles(pasted);
        }} placeholder="描述目标、补充想法，或继续上一段对话…" rows={2} value={text} />
        <div className="joi-composer-toolbar">
          <label className="joi-attachment-button">添加附件<input aria-label="给 joi 添加附件" multiple onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} type="file" /></label>
          <ComposerWorkbenchPicker workbenches={snapshot.workbenches} onSelect={setTargetWorkbenchId} selected={targetWorkbench} />
          {files.length === 0 ? null : <span className="joi-file-summary">{files.map((file) => file.name).join("、")}</span>}
          <button className="button primary" disabled={text.trim() === ""} type="submit">交给 joi</button>
        </div>
      </form>
      {error === null ? null : <p className="inline-notice danger" role="alert">{error}</p>}
    </div>
  </section>;
}

function clarificationText(code: string | undefined, prompt?: string, workbenchName?: string): string {
  if (code === "question_required") return prompt ?? "joi 需要你回答一个问题，才能继续安排这条任务。";
  if (code === "partner_waiting_recovery_required") return prompt ?? "一项搭档工作仍在等待。点击继续原工作即可恢复。";
  if (code === "partner_auth_required") return prompt ?? "搭档需要重新授权。请先在搭档设置完成授权，然后点击继续原工作。";
  if (code === "goal_continuation_required") return prompt ?? "已自动补充两轮，当前结果仍有明确缺口。可以继续补齐，或接受当前结果。";
  if (code === "workbench_workspace_not_ready") return `“${workbenchName ?? "当前工作台"}”还没有可用的工作目录。选择一个目录后，joi 会自动继续这条任务。`;
  if (code === "partner_selection_required") return prompt ?? "请选择一个可用搭档继续这条任务。";
  if (code === "work_dispatch_failed") return prompt ?? "joi 暂时无法把这条任务派发给搭档，任务已暂停。修复搭档配置后可以继续重试。";
  if (code === "workbench_selection_invalid") return "joi 没法定位这条输入属于哪个上下文。在下方点选它对应的工作台，或补充更明确的项目/角色。";
  if (code === "workbench_creation_unavailable") return "joi 想新建一个工作台来承接这条输入，但当前无法创建。请补充更明确的归属，或先到「工作台」页手动创建。";
  if (code === "workbench_not_found") return "这条输入指向的工作台已不存在。在下方点选它应归属的工作台，或补充项目/角色。";
  return prompt ?? "joi 需要你补充信息后才能继续。在下方补充细节，它会接着这条输入往下做。";
}

export function JoiHome({ api, onNavigate, onScheduleGoal }: {
  api: DigitalLifeApi;
  onNavigate?: (section: "agents" | "joi", tab?: "partners" | "scenarios") => void;
  onScheduleGoal?: (goalId: string) => void;
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
  return snapshot.runtime.configured ? <JoiComposer api={api} {...(onNavigate === undefined ? {} : { onNavigate })} {...(onScheduleGoal === undefined ? {} : { onScheduleGoal })} snapshot={snapshot} /> : <ModelSourceSetup api={api} changed={load} />;
}
