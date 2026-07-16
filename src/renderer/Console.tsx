import {
  AlarmIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BrainIcon,
  CalendarDotsIcon,
  CaretRightIcon,
  ChatsCircleIcon,
  CheckCircleIcon,
  CirclesThreePlusIcon,
  ClockCounterClockwiseIcon,
  GearSixIcon,
  HeartbeatIcon,
  LockKeyIcon,
  NetworkIcon,
  PaperclipIcon,
  PaperPlaneTiltIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  PulseIcon,
  RobotIcon,
  ShieldWarningIcon,
  SignOutIcon,
  SparkleIcon,
  StopIcon,
  WarningCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type KeyboardEvent, type SyntheticEvent, useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, type DigitalLifeApi } from "./api";
import type {
  AgentDto, ContinuityDto, DiagnosticsDto, ExpressionDto, InteractionDto, LifeDto, LifeEventDto, LifeRuntimeActivityDto, LifeState,
} from "./types";
import { formatDate, initials, isoToLocalDateTime, localDateTimeToIso } from "./view-utils";

type Section = "agents" | "lives" | "settings" | "system";
type LifeTab = "activity" | "memory" | "rhythm" | "settings" | "work";

const NAVIGATION = [
  { icon: HeartbeatIcon, key: "lives", label: "生命" },
  { icon: RobotIcon, key: "agents", label: "Agents" },
  { icon: PulseIcon, key: "system", label: "系统活动" },
  { icon: GearSixIcon, key: "settings", label: "设置" },
] as const;

const STATE_LABEL: Record<LifeState, string> = {
  BUDGET_PAUSED: "预算暂停", DEGRADED: "异常", PAUSED: "已暂停", QUEUED: "等待唤醒",
  RUNNING: "运行中", SLEEPING: "休眠", STOPPED: "已停止", WAITING_USER: "等待用户",
};

function Status({ state }: { state: LifeState }) {
  return <span className={`life-status state-${state.toLowerCase()}`}><span aria-hidden />{STATE_LABEL[state]}</span>;
}

function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "danger" | "info" | "success" }) {
  return <div className={`inline-notice ${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

function LoadingPage() {
  return <div className="content-state" role="status" aria-label="正在读取控制台"><span className="load-line wide" /><span className="load-line" /><span className="load-block" /></div>;
}

export function LifeHome({ agents, lives, onCreate, onOpen }: {
  agents: AgentDto[]; lives: LifeDto[]; onCreate: () => void; onOpen: (life: LifeDto) => void;
}) {
  const ready = agents.some((agent) => agent.readiness === true && agent.status === "ACTIVE");
  return (
    <section className="page-section" aria-labelledby="life-home-title">
      <header className="page-title-row">
        <div><p className="eyebrow">LIFE OBSERVATORY</p><h1 id="life-home-title">你的数字生命</h1><p>观察它们此刻的节奏、承诺与下一次醒来。</p></div>
        <button className="button primary" disabled={!ready} onClick={onCreate} type="button"><PlusIcon aria-hidden />创建生命</button>
      </header>
      {lives.length === 0 ? <div className="empty-observatory">
        <div className="orbit-illustration" aria-hidden><span /><i /><b /></div>
        <div><p className="eyebrow">NO LIVES YET</p><h2>还没有数字生命</h2><p>{ready ? "从身份、行动边界与生活节奏开始，让第一个生命出生。" : "先连接一个通过 readiness 的主 Agent，再定义它是谁、如何行动与生活。"}</p></div>
        <button className="button primary" disabled={!ready} onClick={onCreate} type="button"><CirclesThreePlusIcon aria-hidden />创建第一个数字生命</button>
        {!ready ? <small>连接主 Agent 后启用</small> : null}
      </div> : <div className="life-grid">{lives.map((life) => {
        const agent = agents.find((item) => item.agentConnectionId === life.mainAgentConnectionId);
        return <article className="life-card" key={life.lifeId}>
          <button aria-label={`打开 ${life.name}`} className="life-card-open" onClick={() => onOpen(life)} type="button">
            <div className="life-card-top"><span className="avatar large">{initials(life.name)}</span>{life.archivedAt === undefined ? <Status state={life.state} /> : <span className="life-status"><span aria-hidden />已归档</span>}</div>
            <div><h2>{life.name}</h2><p>{life.role ?? life.personaSummary}</p></div>
            <dl className="life-card-facts"><div><dt>主 Agent</dt><dd><span className={`health-dot ${agent?.status === "ACTIVE" ? "healthy" : ""}`} />{agent?.name ?? "连接未知"}</dd></div><div><dt>待处理事件</dt><dd>{life.pendingEventCount ?? 0}</dd></div><div><dt>今日预算</dt><dd>{life.autonomousBudgetUsed ?? 0}/{life.autonomousBudgetDailyLimit ?? 24} 唤醒 · {life.totalBudgetUsed ?? 0}/{life.totalBudgetDailyLimit ?? 100} 调用</dd></div><div><dt>下一次唤醒</dt><dd>{life.nextWakeAt === undefined ? "未安排" : formatDate(life.nextWakeAt, life.timezone)}</dd></div></dl>
            <span className="open-cue">打开生命 <CaretRightIcon aria-hidden /></span>
          </button>
        </article>;
      })}</div>}
    </section>
  );
}

export function AgentPanel({ agents, api, refresh }: { agents: AgentDto[]; api: DigitalLifeApi; refresh: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [cardUrl, setCardUrl] = useState("");
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotationToken, setRotationToken] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AgentDto | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<Awaited<ReturnType<DigitalLifeApi["getAgentDeletionImpact"]>> | null>(null);
  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setNotice("正在读取 Agent Card 并验证 readiness…");
    try { await api.addAgent(cardUrl, token); setCardUrl(""); setToken(""); setAdding(false); await refresh(); setNotice("Agent 已测试并安全保存。Token 不会再次显示。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "Agent 连接未完成。"); }
  };
  const action = async (agent: AgentDto, kind: "disable" | "enable" | "refresh") => {
    setNotice(kind === "refresh" ? "正在重新读取公开 Card…" : kind === "enable" ? "正在重新验证 Card、Token 与 readiness…" : "正在停止新调用…");
    try { await api.agentAction(agent.agentConnectionId, kind); await refresh(); setNotice(kind === "refresh" ? "Card 与 readiness 已刷新。" : kind === "enable" ? "Agent 已重新验证并启用。" : "Agent 已停用；运行中的调用不会被取消。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "操作未完成。"); }
  };
  const rotate = async (event: SyntheticEvent<HTMLFormElement>, agent: AgentDto) => {
    event.preventDefault(); setNotice("正在原子替换 Agent Token…");
    try { await api.rotateAgentToken(agent.agentConnectionId, rotationToken); setRotationToken(""); setRotating(null); await refresh(); setNotice("Token 已轮换，旧凭据不再保留。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "Token 未轮换。"); }
  };
  const inspectDeletion = async (agent: AgentDto) => {
    setNotice("正在检查生命绑定与运行中的调用…");
    try { setDeleteImpact(await api.getAgentDeletionImpact(agent.agentConnectionId)); setDeleteTarget(agent); setNotice(null); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "无法读取删除影响。"); }
  };
  return <section className="page-section">
    <header className="page-title-row"><div><p className="eyebrow">AGENT CONNECTIONS</p><h1>Agents</h1><p>公开能力、连接健康与主 Agent readiness。凭据始终留在主进程。</p></div><button className="button primary" onClick={() => setAdding(true)} type="button"><PlusIcon aria-hidden />添加 Agent</button></header>
    {notice === null ? null : <Notice>{notice}</Notice>}
    <div className="resource-list">{agents.map((agent) => <article className="agent-row" key={agent.agentConnectionId}>
      <span className="avatar"><RobotIcon aria-hidden /></span><div className="resource-main"><div className="resource-title"><h2>{agent.name}</h2><span className={`status-dot ${agent.status === "ACTIVE" ? "ok" : "muted"}`}>{agent.status}</span></div><p>{agent.description ?? "Agent Card 未提供描述"}</p><div className="tag-row">{agent.readiness === true ? <span>主 Agent ready</span> : <span>仅协作者 / 未就绪</span>}{agent.skills?.slice(0, 3).map((skill) => <span key={skill}>{skill}</span>)}{agent.lifeBindings?.map((binding) => <span key={`${binding.lifeId}:${binding.role}`}>{binding.name} · {binding.role === "PRIMARY" ? "主 Agent" : "协作者"}</span>)}{agent.recentInvocationStatus === undefined ? null : <span>最近调用 · {agent.recentInvocationStatus}</span>}</div></div>
      <div className="row-actions"><button className="button quiet" disabled={agent.status === "TOKEN_REQUIRED"} onClick={() => void action(agent, "refresh")} type="button">刷新 Card</button><button className="button ghost" onClick={() => setRotating(agent.agentConnectionId)} type="button">{agent.status === "TOKEN_REQUIRED" ? "重新输入 Token" : "轮换 Token"}</button>{agent.status === "DISABLED" ? <button className="button ghost" onClick={() => void action(agent, "enable")} type="button">重新启用</button> : <button className="button ghost" onClick={() => void action(agent, "disable")} type="button">停用</button>}<button className="button danger-text" onClick={() => void inspectDeletion(agent)} type="button">删除…</button></div>{agent.status === "TOKEN_REQUIRED" ? <p className="credential-warning">数据来自备份；旧加密凭据不会被使用。请重新输入 Token 并验证 Card。</p> : null}{rotating === agent.agentConnectionId ? <form className="agent-token-form" onSubmit={(event) => void rotate(event, agent)}><label>新 Bearer Token<input autoComplete="off" onChange={(event) => setRotationToken(event.target.value)} required type="password" value={rotationToken} /></label><button className="button quiet" type="submit">确认轮换</button><button className="button ghost" onClick={() => setRotating(null)} type="button">取消</button></form> : null}
    </article>)}</div>
    {agents.length === 0 ? <div className="plain-empty"><RobotIcon aria-hidden size={30} /><h2>还没有 Agent 连接</h2><p>添加后会立即验证 Card、协议与健康状态。</p></div> : null}
    {adding ? <div className="dialog-backdrop" role="presentation"><form aria-label="添加 Agent" className="dialog" onSubmit={(event) => void submit(event)}><button aria-label="关闭" className="icon-button dialog-close" onClick={() => setAdding(false)} type="button"><XIcon /></button><p className="eyebrow">NEW CONNECTION</p><h2>测试并保存 Agent</h2><p>Token 只在这次提交中使用，保存后不回显。</p><label>Agent Card URL<input autoFocus onChange={(event) => setCardUrl(event.target.value)} required type="url" value={cardUrl} /></label><label>Bearer Token<input autoComplete="off" onChange={(event) => setToken(event.target.value)} required type="password" value={token} /></label><button className="button primary wide" type="submit">测试并保存</button></form></div> : null}
    {deleteTarget === null || deleteImpact === null ? null : <div className="dialog-backdrop" role="presentation"><section aria-labelledby="agent-delete-title" aria-modal="true" className="dialog danger-dialog" role="dialog"><p className="eyebrow">CONNECTION IMPACT</p><h2 id="agent-delete-title">删除 {deleteTarget.name}？</h2>{deleteImpact.bindings.length > 0 ? <><p>必须先解除以下生命绑定：</p><ul className="impact-list">{deleteImpact.bindings.map((binding) => <li key={`${binding.lifeId}-${binding.role}`}><strong>{binding.name}</strong><span>{binding.role === "PRIMARY" ? "主 Agent：先暂停生命并完成交接" : "协作者：在生命设置中解除"}</span></li>)}</ul></> : <p>本地凭据和 Card 快照会删除；历史 Invocation 只保留不可执行的 Agent 标识，不会删除远端 Agent 数据。</p>}{deleteImpact.activeInvocations > 0 ? <Notice tone="danger">仍有 {deleteImpact.activeInvocations} 个运行中的调用，暂时不能删除。</Notice> : null}<div className="row-actions"><button className="button ghost" onClick={() => { setDeleteTarget(null); setDeleteImpact(null); }} type="button">取消</button><button className="button danger-text" disabled={deleteImpact.bindings.length > 0 || deleteImpact.activeInvocations > 0} onClick={() => void api.deleteAgent(deleteTarget.agentConnectionId).then(refresh).then(() => { setDeleteTarget(null); setDeleteImpact(null); setNotice("Agent 本地连接与凭据已删除。"); })} type="button">确认删除</button></div></section></div>}
  </section>;
}

function LifeWizard({ agents, api, close, created }: { agents: AgentDto[]; api: DigitalLifeApi; close: () => void; created: (life: LifeDto) => void }) {
  const readyAgents = agents.filter((agent) => agent.readiness === true && agent.status === "ACTIVE");
  const collaborators = agents.filter((agent) => agent.status === "ACTIVE" || agent.status === "COLLABORATOR_ONLY");
  const [step, setStep] = useState(1);
  const [name, setName] = useState(""); const [persona, setPersona] = useState(""); const [role, setRole] = useState("");
  const [avatarUrl, setAvatarUrl] = useState(""); const [initialGoal, setInitialGoal] = useState("");
  const [principles, setPrinciples] = useState(""); const [primary, setPrimary] = useState(readyAgents[0]?.agentConnectionId ?? "");
  const [selected, setSelected] = useState<string[]>([]); const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const finish = async () => {
    setBusy(true); setError(null);
    try {
      const life = await api.createLife({ avatarUrl, initialGoal, mainAgentConnectionId: primary, name, personaSummary: persona, principles: principles.split("\n").map((item) => item.trim()).filter(Boolean), role, timezone });
      for (const collaborator of selected.filter((id) => id !== primary)) await api.bindCollaborator(life.lifeId, collaborator);
      created(await api.runtime(life.lifeId, "start"));
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : "生命创建未完成。"); }
    finally { setBusy(false); }
  };
  return <div className="wizard-shell">
    <header><button className="button ghost" onClick={close} type="button"><XIcon aria-hidden />退出向导</button><div className="wizard-steps">{["它是谁", "它如何行动", "它如何生活"].map((label, index) => <span className={step === index + 1 ? "current" : step > index + 1 ? "done" : ""} key={label}><i>{step > index + 1 ? <CheckCircleIcon /> : index + 1}</i>{label}</span>)}</div></header>
    <main className="wizard-stage">{step === 1 ? <section><p className="eyebrow">IDENTITY · 01</p><h1>它是谁？</h1><p>写下可持续理解的身份，不必编写 system prompt。</p><div className="two-fields"><label>名称<input autoFocus maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} /></label><label>头像 URL（可选）<input maxLength={2048} onChange={(event) => setAvatarUrl(event.target.value)} type="url" value={avatarUrl} /></label></div><label>人格摘要<textarea maxLength={4000} onChange={(event) => setPersona(event.target.value)} placeholder="它如何看待世界、与人相处，以及长期想守住什么。" rows={5} value={persona} /></label><label>初始目标（可选）<textarea maxLength={4000} onChange={(event) => setInitialGoal(event.target.value)} placeholder="出生后最先希望它理解或推进的目标。" rows={3} value={initialGoal} /></label><div className="two-fields"><label>角色（可选）<input maxLength={160} onChange={(event) => setRole(event.target.value)} value={role} /></label><label>原则（每行一条）<textarea onChange={(event) => setPrinciples(event.target.value)} rows={2} value={principles} /></label></div></section> : null}
      {step === 2 ? <section><p className="eyebrow">AGENCY · 02</p><h1>它如何行动？</h1><p>主 Agent 持有单一 Wake；协作者只接收明确委派并把结果送回事件流。</p><fieldset><legend>主 Agent</legend>{readyAgents.map((agent) => <label className="choice-row" key={agent.agentConnectionId}><input checked={primary === agent.agentConnectionId} name="primary" onChange={() => setPrimary(agent.agentConnectionId)} type="radio" /><span><strong>{agent.name}</strong><small>readiness 已通过 · 可维持生命循环</small></span></label>)}</fieldset><fieldset><legend>协作者（可选）</legend>{collaborators.filter((agent) => agent.agentConnectionId !== primary).map((agent) => <label className="choice-row" key={agent.agentConnectionId}><input checked={selected.includes(agent.agentConnectionId)} onChange={(event) => setSelected((items) => event.target.checked ? [...items, agent.agentConnectionId] : items.filter((id) => id !== agent.agentConnectionId))} type="checkbox" /><span><strong>{agent.name}</strong><small>仅在 delegate 动作后参与</small></span></label>)}</fieldset></section> : null}
      {step === 3 ? <section><p className="eyebrow">RHYTHM · 03</p><h1>它如何生活？</h1><p>默认节奏保持简单，出生后仍可调整。</p><label>时区<input onChange={(event) => setTimezone(event.target.value)} required value={timezone} /></label><div className="rhythm-preview"><div><CalendarDotsIcon aria-hidden /><strong>08:00</strong><span>计划一天</span></div><div><ClockCounterClockwiseIcon aria-hidden /><strong>21:00</strong><span>晚间复盘</span></div><div><BrainIcon aria-hidden /><strong>03:00</strong><span>记忆整理</span></div></div><dl className="birth-summary"><div><dt>身份</dt><dd>{name} · {role || "未设置角色"}</dd></div><div><dt>行动</dt><dd>{readyAgents.find((agent) => agent.agentConnectionId === primary)?.name} + {selected.length} 位协作者</dd></div><div><dt>边界</dt><dd>23:00–07:00 安静时段 · 每日 24 次自主唤醒</dd></div></dl></section> : null}
      {error === null ? null : <Notice tone="danger">{error}</Notice>}
      <footer><button className="button ghost" disabled={step === 1} onClick={() => setStep((value) => value - 1)} type="button"><ArrowLeftIcon aria-hidden />返回</button>{step < 3 ? <button className="button primary" disabled={(step === 1 && (name.trim() === "" || persona.trim() === "")) || (step === 2 && primary === "")} onClick={() => setStep((value) => value + 1)} type="button">继续<ArrowRightIcon aria-hidden /></button> : <button className="button primary birth-button" disabled={busy} onClick={() => void finish()} type="button"><SparkleIcon aria-hidden />{busy ? "正在出生…" : "让它出生"}</button>}</footer>
    </main>
  </div>;
}

export function Timeline({ activity = [], api, events, expressions, timezone }: { activity?: LifeRuntimeActivityDto[]; api: DigitalLifeApi; events: LifeEventDto[]; expressions: ExpressionDto[]; timezone: string }) {
  const items = useMemo(() => [
    ...events.map((event) => ({ id: event.eventId, occurredAt: event.occurredAt, record: event, type: "event" as const })),
    ...expressions.map((expression) => ({ id: expression.expressionId, occurredAt: expression.deliveredAt ?? expression.createdAt, record: expression, type: "expression" as const })),
    ...activity.map((runtime) => ({ id: runtime.activityId, occurredAt: runtime.startedAt, record: runtime, type: "runtime" as const })),
  ].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)), [activity, events, expressions]);
  if (items.length === 0) return <div className="plain-empty"><ChatsCircleIcon aria-hidden size={28} /><h2>活动时间线还是空的</h2><p>出生、用户消息和生命表达会在这里留下可追溯记录。</p></div>;
  return <ol className="timeline">{items.map((item) => {
    if (item.type === "expression") return <li className="timeline-item expression-item" key={item.id}><span className="timeline-avatar"><SparkleIcon aria-hidden /></span><article><header><strong>生命表达</strong><time>{formatDate(item.occurredAt, timezone)}</time></header><p>{item.record.text}</p></article></li>;
    if (item.type === "runtime") {
      const details = Object.entries(item.record.details).map(([key, value]) => `${key} ${String(value)}`).join(" · ");
      const needsReview = item.record.status === "FAILED_PROTOCOL" || item.record.status === "FAILED" || item.record.status === "UNKNOWN";
      return <li className={`timeline-item runtime-item ${needsReview ? "runtime-error" : ""}`} key={item.id}><span className="timeline-avatar"><PulseIcon aria-hidden /></span><article><header><strong>{item.record.title}</strong><time>{formatDate(item.occurredAt, timezone)}</time></header><p>{item.record.status}{details === "" ? "" : ` · ${details}`}</p>{needsReview ? <small>需要关注；未知远端状态不会被伪装为完成或失败。</small> : item.record.endedAt === undefined ? <small>运行中</small> : <small>已留下可恢复运行事实</small>}</article></li>;
    }
    const event = item.record;
    const isHuman = event.type === "human.message";
    const isAgent = event.type.startsWith("agent.");
    const text = typeof event.payload.text === "string" ? event.payload.text : typeof event.payload.summary === "string" ? event.payload.summary : null;
    const messageAttachments = Array.isArray(event.payload.attachments) ? event.payload.attachments.flatMap((item) => {
      if (item === null || Array.isArray(item) || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      return typeof candidate.filename === "string" && typeof candidate.size === "number"
        ? [{ filename: candidate.filename, size: candidate.size }]
        : [];
    }) : [];
    const artifact = event.type === "agent.artifact_created" ? {
      artifactId: typeof event.payload.artifactId === "string" ? event.payload.artifactId : null,
      filename: typeof event.payload.filename === "string" ? event.payload.filename : "未命名 Artifact",
      mimeType: typeof event.payload.mimeType === "string" ? event.payload.mimeType : "类型未知",
      size: typeof event.payload.size === "number" ? event.payload.size : null,
    } : null;
    return <li className={`timeline-item ${isHuman ? "human-item" : isAgent ? "agent-item" : "system-item"}`} key={item.id}><span className="timeline-avatar">{isHuman ? "你" : isAgent ? <RobotIcon aria-hidden /> : <PulseIcon aria-hidden />}</span><article><header><strong>{isHuman ? "用户消息" : isAgent ? "Agent 结果" : event.type}</strong><time>{formatDate(event.occurredAt, timezone)}</time></header>{artifact === null ? (text === null ? <p className="event-summary">{event.status} · {event.source}</p> : <p>{text}</p>) : <div className="artifact-card"><strong>{artifact.filename}</strong><span>{artifact.mimeType}{artifact.size === null ? "" : ` · ${(artifact.size / 1024).toFixed(1)} KiB`}</span><small>受控存储 · 每次读取重新校验 hash</small>{artifact.artifactId === null ? null : <span className="artifact-actions"><a className="button ghost" href={api.artifactUrl(event.lifeId, artifact.artifactId, "preview")} rel="noreferrer" target="_blank">预览</a><a className="button quiet" href={api.artifactUrl(event.lifeId, artifact.artifactId, "download")}>下载</a></span>}</div>}{messageAttachments.length === 0 ? null : <div className="tag-row">{messageAttachments.map((attachment, index) => <span key={`${attachment.filename}:${String(index)}`}><PaperclipIcon aria-hidden />{attachment.filename} · {(attachment.size / 1024).toFixed(1)} KiB</span>)}</div>}<small>{isHuman ? (event.status === "CONSUMED" ? "已读取" : "已排队") : event.status}</small></article></li>;
  })}</ol>;
}

function InteractionCards({ api, interactions, changed }: { api: DigitalLifeApi; interactions: InteractionDto[]; changed: () => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (interactions.length === 0) return null;
  return <section className="interaction-stack" aria-label="待处理问题"><h3>等待你的决定</h3>{interactions.map((interaction) => <article className={`interaction-card ${interaction.kind}`} key={interaction.interactionId}><LockKeyIcon aria-hidden /><div><strong>{interaction.kind === "auth-required" ? "需要人工授权" : "Agent 需要补充信息"}</strong><p>{interaction.prompt}</p>{interaction.kind === "input-required" ? <form onSubmit={(event) => { event.preventDefault(); void api.answerInteraction(interaction.interactionId, answers[interaction.interactionId] ?? "").then(changed); }}><input aria-label="回答" onChange={(event) => setAnswers((current) => ({ ...current, [interaction.interactionId]: event.target.value }))} required value={answers[interaction.interactionId] ?? ""} /><button className="button quiet" type="submit">提交回答</button></form> : <div className="auth-resolution"><small>凭据必须在对应 Agent 端完成，主 Agent 不会收到 Token。</small><button className="button quiet" onClick={() => void api.resumeAuthorization(interaction.interactionId).then(changed)} type="button">我已在 Agent 完成授权，继续原任务</button></div>}</div></article>)}</section>;
}

function LifeDetail({ agents, api, interactions, life: initialLife, onBack, onChanged }: { agents: AgentDto[]; api: DigitalLifeApi; interactions: InteractionDto[]; life: LifeDto; onBack: () => void; onChanged: () => Promise<void> }) {
  const [life, setLife] = useState(initialLife); const [tab, setTab] = useState<LifeTab>("activity"); const [events, setEvents] = useState<LifeEventDto[]>([]);
  const [expressions, setExpressions] = useState<ExpressionDto[]>([]); const [activity, setActivity] = useState<LifeRuntimeActivityDto[]>([]); const [continuity, setContinuity] = useState<ContinuityDto | null>(null);
  const [message, setMessage] = useState(""); const [notice, setNotice] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const [todoDraft, setTodoDraft] = useState(""); const [todoDue, setTodoDue] = useState(""); const [todoAssignee, setTodoAssignee] = useState(""); const [todoAffair, setTodoAffair] = useState(""); const [alarmReason, setAlarmReason] = useState(""); const [alarmAt, setAlarmAt] = useState("");
  const [alarmRepeat, setAlarmRepeat] = useState(""); const [alarmQuiet, setAlarmQuiet] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [stopPrompt, setStopPrompt] = useState(false);
  const refresh = useCallback(async () => {
    const [freshLife, eventPage, expressionPage, activityPage, snapshot] = await Promise.all([api.getLife(life.lifeId), api.listEvents(life.lifeId), api.listExpressions(life.lifeId), api.listActivity(life.lifeId), api.continuity(life.lifeId)]);
    setLife(freshLife); setEvents(eventPage.items); setExpressions(expressionPage.items); setActivity(activityPage.items); setContinuity(snapshot); setLoading(false);
  }, [api, life.lifeId]);
  useEffect(() => {
    const timer = setTimeout(() => void refresh().catch((error: unknown) => {
      setNotice(error instanceof ApiError ? error.message : "生命详情读取失败。"); setLoading(false);
    }), 0);
    return () => clearTimeout(timer);
  }, [refresh]);
  const runtime = async (action: "cancel-run" | "emergency-stop" | "pause" | "resume" | "start" | "stop") => {
    setNotice("操作已提交到本机 Runtime…");
    try { setLife(await api.runtime(life.lifeId, action)); setNotice(action === "cancel-run" ? "本次运行已停止；未读取事件已回到队列。" : action === "emergency-stop" ? "紧急停止已生效。" : "生命状态已更新。"); setStopPrompt(false); await onChanged(); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "状态操作未完成。"); }
  };
  const send = async () => {
    const text = message.trim(); if (text === "") return; setMessage(""); setNotice(life.state === "RUNNING" ? "消息已持久化，会在下一轮出现。" : "消息已进入本地事件队列。");
    try {
      const uploaded = [];
      for (const attachment of attachments) uploaded.push(await api.uploadAttachment(life.lifeId, attachment));
      const event = uploaded.length === 0
        ? await api.sendMessage(life.lifeId, text)
        : await api.sendMessage(life.lifeId, text, uploaded.map((attachment) => attachment.attachmentId));
      setAttachments([]); setEvents((items) => [event, ...items.filter((item) => item.eventId !== event.eventId)]);
    }
    catch (error) { setMessage(text); setNotice(error instanceof ApiError ? `未提交：${error.message}` : "消息未提交。"); }
  };
  const chooseAttachments = (files: FileList | null) => {
    const selected = files === null ? [] : [...files];
    const total = selected.reduce((size, file) => size + file.size, 0);
    if (selected.length > 8 || selected.some((file) => file.size > 10 * 1024 * 1024) || total > 25 * 1024 * 1024) {
      setNotice("附件限制：最多 8 个，单个不超过 10 MiB，总计不超过 25 MiB。");
      return;
    }
    setAttachments(selected); setNotice(selected.length === 0 ? null : `已选择 ${String(selected.length)} 个附件，将随消息明确转发。`);
  };
  const composerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } };
  const tabs: { key: LifeTab; label: string }[] = [{ key: "activity", label: "活动" }, { key: "work", label: "事务与待办" }, { key: "memory", label: "记忆" }, { key: "rhythm", label: "作息与闹钟" }, { key: "settings", label: "设置" }];
  return <section className="life-detail">
    <header className="life-detail-header"><button className="icon-button" aria-label="返回全部生命" onClick={onBack} type="button"><ArrowLeftIcon /></button><span className="avatar large">{initials(life.name)}</span><div className="life-heading"><div><h1>{life.name}</h1><Status state={life.state} /></div><p>{life.role ?? life.personaSummary}</p></div><div className="header-actions">{life.state === "RUNNING" || life.state === "QUEUED" ? <><button className="button quiet" onClick={() => void runtime("pause")} type="button"><PauseIcon aria-hidden />暂停</button><button className="icon-button danger" aria-label="停止运行" onClick={() => setStopPrompt(true)} type="button"><StopIcon /></button></> : <button className="button quiet" onClick={() => void runtime(life.state === "STOPPED" ? "start" : "resume")} type="button"><PlayIcon aria-hidden />{life.state === "STOPPED" ? "启动" : "恢复"}</button>}</div></header>
    <nav className="life-tabs" aria-label="生命详情">{tabs.map((item) => <button aria-current={tab === item.key ? "page" : undefined} key={item.key} onClick={() => setTab(item.key)} type="button">{item.label}</button>)}</nav>
    {notice === null ? null : <Notice>{notice}</Notice>}
    {stopPrompt ? <div className="dialog-backdrop" role="presentation"><section aria-labelledby="stop-run-title" aria-modal="true" className="dialog" role="dialog"><p className="eyebrow">ACTIVE RUN</p><h2 id="stop-run-title">停止本次运行，还是暂停生命？</h2><p>停止本次运行会取消当前 Wake 并把未读取事件放回队列；暂停生命还会阻止后续 Wake，直到你手动恢复。</p><div className="row-actions"><button className="button ghost" onClick={() => setStopPrompt(false)} type="button">取消</button><button className="button quiet" onClick={() => void runtime("cancel-run")} type="button">只停止本次运行</button><button className="button danger-text" onClick={() => void runtime("pause")} type="button">暂停这个生命</button></div></section></div> : null}
    {loading || continuity === null ? <LoadingPage /> : <div className="life-detail-body">
      {tab === "activity" ? <div className="activity-layout"><main><Timeline activity={activity} api={api} events={events} expressions={expressions} timezone={life.timezone} /></main><aside><section className="focus-panel"><p className="eyebrow">CURRENT FOCUS</p><h2>{continuity.affairs.find((affair) => ["OPEN", "RUNNING", "WAITING"].includes(affair.status))?.title ?? "此刻没有活跃事务"}</h2><p>{life.personaSummary}</p><dl><div><dt>今日自主唤醒</dt><dd>{continuity.budget.autonomousWakesUsed} / {continuity.budget.autonomousWakesLimit}</dd></div><div><dt>A2A 调用</dt><dd>{continuity.budget.invocationsUsed} / {continuity.budget.invocationsLimit}</dd></div><div><dt>下个闹钟</dt><dd>{continuity.alarms.find((alarm) => alarm.status === "SCHEDULED")?.nextAt ? formatDate(continuity.alarms.find((alarm) => alarm.status === "SCHEDULED")?.nextAt ?? "", life.timezone) : "未设置"}</dd></div></dl></section><InteractionCards api={api} changed={onChanged} interactions={interactions} /></aside></div> : null}
      {tab === "work" ? <div className="resource-columns"><section><div className="section-heading"><div><p className="eyebrow">AFFAIRS</p><h2>事务</h2></div></div>{continuity.affairs.map((affair) => <article className="work-row" key={affair.affairId}><span className={`status-rail ${affair.status.toLowerCase()}`} /><div><strong>{affair.title}</strong><p>{affair.summary ?? (affair.waitingReason ? `等待：${affair.waitingReason}` : "持续推进中")}</p></div><span>{affair.status}</span></article>)}{continuity.affairs.length === 0 ? <p className="empty-line">Agent 尚未建立长期事务。</p> : null}</section><section><div className="section-heading"><div><p className="eyebrow">TODOS</p><h2>待办</h2></div></div><form className="todo-create-form" onSubmit={(event) => { event.preventDefault(); const options = { ...(todoDue === "" ? {} : { dueAt: localDateTimeToIso(todoDue, life.timezone) }), ...(todoAssignee.trim() === "" ? {} : { assignee: todoAssignee.trim() }), ...(todoAffair === "" ? {} : { affairId: todoAffair }) }; const request = Object.keys(options).length === 0 ? api.createTodo(life.lifeId, todoDraft) : api.createTodo(life.lifeId, todoDraft, options); void request.then(() => { setTodoDraft(""); setTodoDue(""); setTodoAssignee(""); setTodoAffair(""); setNotice("含截止时间与负责人的待办请求已进入事件流。"); }); }}><input aria-label="新待办" onChange={(event) => setTodoDraft(event.target.value)} placeholder="添加一个待办" required value={todoDraft} /><input aria-label="截止时间" onChange={(event) => setTodoDue(event.target.value)} type="datetime-local" value={todoDue} /><input aria-label="负责人" onChange={(event) => setTodoAssignee(event.target.value)} placeholder="负责人（可选）" value={todoAssignee} /><select aria-label="关联事务" onChange={(event) => setTodoAffair(event.target.value)} value={todoAffair}><option value="">生命全局</option>{continuity.affairs.map((affair) => <option key={affair.affairId} value={affair.affairId}>{affair.title}</option>)}</select><button className="button quiet" type="submit">添加</button></form>{continuity.todos.map((todo) => <TodoEditor affairs={continuity.affairs} api={api} key={todo.todoId} life={life} notice={setNotice} refresh={refresh} todo={todo} />)}{continuity.todos.length === 0 ? <p className="empty-line">暂时没有开放待办。</p> : null}<div className="section-heading delegation-heading"><div><p className="eyebrow">DELEGATIONS</p><h2>协作</h2></div></div>{continuity.delegations.map((delegation) => <article className="todo-row" key={delegation.delegationId}><RobotIcon aria-hidden /><div><strong>{delegation.title}</strong><p>{delegation.status} · {delegation.task}</p></div></article>)}</section></div> : null}
      {tab === "memory" ? <MemoryPanel api={api} life={life} memories={continuity.memories} notice={setNotice} /> : null}
      {tab === "rhythm" ? <div className="resource-columns"><section><div className="section-heading"><div><p className="eyebrow">DAILY RHYTHM</p><h2>作息</h2></div></div>{continuity.schedules.map((schedule) => <ScheduleEditor api={api} changed={refresh} key={schedule.scheduleId} lifeId={life.lifeId} notice={setNotice} schedule={schedule} />)}<RhythmSettings api={api} changed={(updated) => { setLife(updated); void refresh(); }} life={life} notice={setNotice} /></section><section><div className="section-heading"><div><p className="eyebrow">ALARMS</p><h2>闹钟</h2></div></div><form className="alarm-create-form" onSubmit={(event) => { event.preventDefault(); const recurrence = alarmRepeat.startsWith("rule:") ? { recurrenceRule: alarmRepeat.slice(5) as "DAILY" | "WEEKDAYS" | "WEEKENDS" | "WEEKLY" } : alarmRepeat.startsWith("interval:") ? { repeatEveryMinutes: Number(alarmRepeat.slice(9)) } : {}; void api.createAlarm(life.lifeId, alarmReason, localDateTimeToIso(alarmAt, life.timezone), { allowQuietHours: alarmQuiet, ...recurrence }).then(() => { setAlarmReason(""); setAlarmAt(""); setAlarmRepeat(""); setAlarmQuiet(false); setNotice("一次性或重复闹钟请求已进入事件流。"); }); }}><input aria-label="闹钟原因" onChange={(event) => setAlarmReason(event.target.value)} placeholder="提醒原因" required value={alarmReason} /><input aria-label="闹钟时间" onChange={(event) => setAlarmAt(event.target.value)} required type="datetime-local" value={alarmAt} /><select aria-label="重复规则" onChange={(event) => setAlarmRepeat(event.target.value)} value={alarmRepeat}><option value="">不重复</option><option value="rule:DAILY">每天</option><option value="rule:WEEKDAYS">工作日</option><option value="rule:WEEKENDS">周末</option><option value="rule:WEEKLY">每周同一天</option><option value="interval:60">每小时（自定义间隔）</option></select><label className="inline-check"><input checked={alarmQuiet} onChange={(event) => setAlarmQuiet(event.target.checked)} type="checkbox" />允许安静时段唤醒</label><button className="button quiet" type="submit">设置</button></form>{continuity.alarms.map((alarm) => <article className="todo-row" key={alarm.alarmId}><AlarmIcon aria-hidden /><div><strong>{alarm.reason}</strong><p>{formatDate(alarm.nextAt, life.timezone)} · {alarm.creator === "HUMAN" ? "你创建" : "Agent 创建"} · {alarm.allowQuietHours ? "允许安静时段" : "遵守安静时段"}{alarm.recurrenceRule ? ` · ${{ DAILY: "每天", WEEKDAYS: "工作日", WEEKENDS: "周末", WEEKLY: "每周同一天" }[alarm.recurrenceRule]}` : alarm.repeatEveryMinutes ? ` · 每 ${String(alarm.repeatEveryMinutes)} 分钟` : " · 一次性"}</p></div><button className="button ghost" onClick={() => void api.cancelAlarm(life.lifeId, alarm.alarmId).then(() => setNotice("取消闹钟请求已进入事件流。"))} type="button">取消</button></article>)}{continuity.alarms.length === 0 ? <p className="empty-line">生命还没有设置闹钟。</p> : null}<article className="budget-panel"><h3>今日自治预算</h3><p>自主唤醒 {continuity.budget.autonomousWakesUsed}/{continuity.budget.autonomousWakesLimit} · 调用 {continuity.budget.invocationsUsed}/{continuity.budget.invocationsLimit}</p><button className="button quiet" onClick={() => void api.extendBudget(life.lifeId).then(refresh).then(() => setNotice("今日预算已追加 6 次唤醒与 20 次调用。"))} type="button">追加今日预算</button></article></section></div> : null}
      {tab === "settings" ? <LifeSettings agents={agents} api={api} collaborators={continuity.collaborators ?? []} life={life} removed={() => { void onChanged(); onBack(); }} saved={(updated, message) => { setLife(updated); setNotice(message ?? "生命设置已保存，并创建了新的人格版本。"); void onChanged(); }} /> : null}
    </div>}
    {tab === "activity" ? <footer className="composer"><textarea aria-label="输入消息" onChange={(event) => setMessage(event.target.value)} onKeyDown={composerKey} placeholder={life.state === "RUNNING" ? "输入消息… 它会在下一轮读到" : "输入消息…"} rows={1} value={message} /><span>{attachments.length === 0 ? "Enter 发送 · Shift+Enter 换行" : attachments.map((file) => file.name).join(" · ")}</span><label aria-label="选择附件" className="attachment-button"><PaperclipIcon aria-hidden /><input multiple onChange={(event) => chooseAttachments(event.target.files)} type="file" /></label><button aria-label="发送消息" className="send-button" disabled={message.trim() === ""} onClick={() => void send()} type="button"><PaperPlaneTiltIcon /></button></footer> : null}
  </section>;
}

function TodoEditor({ affairs, api, life, notice, refresh, todo }: {
  affairs: ContinuityDto["affairs"]; api: DigitalLifeApi; life: LifeDto; notice: (message: string) => void; refresh: () => Promise<void>; todo: ContinuityDto["todos"][number];
}) {
  const [editing, setEditing] = useState(false); const [title, setTitle] = useState(todo.title); const [assignee, setAssignee] = useState(todo.assignee ?? "");
  const [affairId, setAffairId] = useState(todo.affairId ?? "");
  const [dueAt, setDueAt] = useState(todo.dueAt === undefined ? "" : isoToLocalDateTime(todo.dueAt, life.timezone));
  if (editing) return <form className="todo-edit-form" onSubmit={(event) => { event.preventDefault(); void api.updateTodo(life.lifeId, todo.todoId, { affairId: affairId || null, assignee: assignee.trim() || null, dueAt: dueAt === "" ? null : localDateTimeToIso(dueAt, life.timezone), title }).then(refresh).then(() => { setEditing(false); notice("待办编辑请求已进入事件流。"); }); }}><input aria-label="待办标题" onChange={(event) => setTitle(event.target.value)} required value={title} /><input aria-label="待办截止时间" onChange={(event) => setDueAt(event.target.value)} type="datetime-local" value={dueAt} /><input aria-label="待办负责人" onChange={(event) => setAssignee(event.target.value)} value={assignee} /><select aria-label="待办关联事务" onChange={(event) => setAffairId(event.target.value)} value={affairId}><option value="">生命全局</option>{affairs.map((affair) => <option key={affair.affairId} value={affair.affairId}>{affair.title}</option>)}</select><div className="row-actions"><button className="button quiet" type="submit">保存</button><button className="button ghost" onClick={() => setEditing(false)} type="button">取消</button></div></form>;
  return <article className="todo-row"><CheckCircleIcon aria-hidden /><div><strong>{todo.title}</strong><p>{todo.dueAt ? `到期 ${formatDate(todo.dueAt, life.timezone)}` : "没有截止时间"} · {todo.assignee ? `负责人 ${todo.assignee} · ` : ""}{todo.status}</p></div><div className="row-actions"><button className="button ghost" onClick={() => setEditing(true)} type="button">编辑</button><button className="button quiet" onClick={() => void api.remindTodo(life.lifeId, todo.todoId).then(() => notice("提醒已成为高优先级事件。"))} type="button">提醒</button><button className="button ghost" onClick={() => void api.updateTodo(life.lifeId, todo.todoId, { status: "DONE" }).then(refresh).then(() => notice("完成请求已进入事件流。"))} type="button">完成</button></div></article>;
}

function ScheduleEditor({ api, changed, lifeId, notice, schedule }: {
  api: DigitalLifeApi; changed: () => Promise<void>; lifeId: string; notice: (message: string) => void; schedule: ContinuityDto["schedules"][number];
}) {
  const [localTime, setLocalTime] = useState(schedule.localTime); const [enabled, setEnabled] = useState(schedule.enabled);
  const label = schedule.kind === "morning_plan" ? "晨间计划" : schedule.kind === "evening_review" ? "晚间复盘" : "记忆整理";
  return <form className="schedule-row schedule-editor" onSubmit={(event) => { event.preventDefault(); void api.updateSchedule(lifeId, schedule.scheduleId, localTime, enabled).then(changed).then(() => notice(`${label}已更新。`)); }}><input aria-label={`${label}时间`} onChange={(event) => setLocalTime(event.target.value)} required type="time" value={localTime} /><div><b>{label}</b><p>{schedule.timezone}</p></div><label className="inline-check"><input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />启用</label><button className="button ghost" type="submit">保存</button></form>;
}

function RhythmSettings({ api, changed, life, notice }: { api: DigitalLifeApi; changed: (life: LifeDto) => void; life: LifeDto; notice: (message: string) => void }) {
  const [quietStart, setQuietStart] = useState(life.quietStart ?? "23:00"); const [quietEnd, setQuietEnd] = useState(life.quietEnd ?? "07:00");
  const [autonomous, setAutonomous] = useState(life.autonomousWakesDefault ?? 24); const [invocations, setInvocations] = useState(life.invocationsDefault ?? 100);
  const [idle, setIdle] = useState(life.idleExplorationsDefault ?? 3);
  return <form className="rhythm-settings" onSubmit={(event) => { event.preventDefault(); void api.updateRhythm(life.lifeId, { autonomousWakesDefault: autonomous, idleExplorationsDefault: idle, invocationsDefault: invocations, quietEnd, quietStart }).then((updated) => { changed(updated); notice("安静时段与后续每日预算默认值已保存。当天已使用的预算不会被重写。"); }); }}><p className="eyebrow">DEFAULTS</p><h3>安静时段与每日预算</h3><div className="two-fields"><label>安静开始<input onChange={(event) => setQuietStart(event.target.value)} type="time" value={quietStart} /></label><label>安静结束<input onChange={(event) => setQuietEnd(event.target.value)} type="time" value={quietEnd} /></label><label>自主唤醒<input min={0} onChange={(event) => setAutonomous(event.target.valueAsNumber)} type="number" value={autonomous} /></label><label>A2A 调用<input min={0} onChange={(event) => setInvocations(event.target.valueAsNumber)} type="number" value={invocations} /></label><label>空闲探索<input min={0} onChange={(event) => setIdle(event.target.valueAsNumber)} type="number" value={idle} /></label></div><button className="button quiet" type="submit">保存默认值</button></form>;
}

function MemoryPanel({ api, life, memories, notice }: { api: DigitalLifeApi; life: LifeDto; memories: ContinuityDto["memories"]; notice: (message: string) => void }) {
  const [editing, setEditing] = useState<string | null>(null); const [content, setContent] = useState("");
  const groups = [{ kind: "CARD", label: "概念卡" }, { kind: "EPISODIC", label: "情景记忆" }, { kind: "SEMANTIC", label: "语义记忆" }] as const;
  return <div className="memory-board">{groups.map((group) => <section key={group.kind}><div className="section-heading"><div><p className="eyebrow">{group.kind}</p><h2>{group.label}</h2></div><span>{memories.filter((memory) => memory.kind === group.kind).length}</span></div>{memories.filter((memory) => memory.kind === group.kind).map((memory) => <article className="memory-row" key={memory.memoryId}><div><p>{memory.content}</p>{memory.entities === undefined ? null : <div className="entity-tags">{memory.entities.map((entity) => <span key={`${entity.type}:${entity.name}:${entity.relation}`}>{entity.name} · {entity.relation}</span>)}</div>}<small>置信度 {Math.round(memory.confidence * 100)}% · 修订 {memory.revision} · {formatDate(memory.updatedAt, life.timezone)}{memory.sourceEventId === undefined ? " · 来源：Agent 整理" : ` · 来源事件 ${memory.sourceEventId}`}</small></div>{editing === memory.memoryId ? <form onSubmit={(event) => { event.preventDefault(); void api.correctMemory(life.lifeId, memory.memoryId, content).then(() => { setEditing(null); notice("修正请求已写入事件；旧版本保留审计但不会直接覆盖 context。"); }); }}><textarea aria-label="修正后的记忆" onChange={(event) => setContent(event.target.value)} required value={content} /><button className="button quiet" type="submit">提交修正</button></form> : <div className="row-actions"><button className="button ghost" onClick={() => { setEditing(memory.memoryId); setContent(memory.content); }} type="button">修正</button><button className="button ghost" onClick={() => void api.forgetMemory(life.lifeId, memory.memoryId).then(() => notice("遗忘请求已写入事件；审计版本仍被保留。"))} type="button">遗忘</button></div>}</article>)}{memories.every((memory) => memory.kind !== group.kind) ? <p className="empty-line">还没有这类记忆。</p> : null}</section>)}</div>;
}

function LifeSettings({ agents, api, collaborators, life, removed, saved }: {
  agents: AgentDto[]; api: DigitalLifeApi; collaborators: AgentDto[]; life: LifeDto; removed: () => void; saved: (life: LifeDto, message?: string) => void;
}) {
  const [name, setName] = useState(life.name); const [role, setRole] = useState(life.role ?? ""); const [summary, setSummary] = useState(life.personaSummary);
  const [avatarUrl, setAvatarUrl] = useState(life.avatarUrl ?? ""); const [initialGoal, setInitialGoal] = useState(life.initialGoal ?? "");
  const candidates = agents.filter((agent) => agent.status === "ACTIVE" && agent.readiness === true && agent.agentConnectionId !== life.mainAgentConnectionId);
  const [primary, setPrimary] = useState(candidates[0]?.agentConnectionId ?? ""); const [danger, setDanger] = useState<"archive" | "delete" | null>(null);
  const [impact, setImpact] = useState<Awaited<ReturnType<DigitalLifeApi["getLifeDeletionImpact"]>> | null>(null); const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const openDelete = async () => {
    setBusy(true); setError(null);
    try { setImpact(await api.getLifeDeletionImpact(life.lifeId)); setDanger("delete"); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : "无法读取删除影响。"); }
    finally { setBusy(false); }
  };
  const confirmDanger = async () => {
    setBusy(true); setError(null);
    try {
      if (danger === "archive") {
        saved(await api.archiveLife(life.lifeId), "生命已归档：调度停止，历史数据完整保留。"); setDanger(null);
      } else if (danger === "delete") {
        await api.deleteLife(life.lifeId); removed();
      }
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : "操作未完成。"); }
    finally { setBusy(false); }
  };
  return <div className="life-settings-stack">
    {error === null ? null : <Notice tone="danger">{error}</Notice>}
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void api.updateLife(life.lifeId, { avatarUrl, initialGoal, name, personaSummary: summary, role }).then((updated) => saved(updated)); }}><p className="eyebrow">LIFE SETTINGS</p><h2>身份与人格</h2><p>每次修改都会创建新的人格版本；历史 Wake 保留原版本引用。</p><div className="two-fields"><label>名称<input maxLength={80} onChange={(event) => setName(event.target.value)} required value={name} /></label><label>角色<input maxLength={160} onChange={(event) => setRole(event.target.value)} value={role} /></label></div><label>头像 URL<input maxLength={2048} onChange={(event) => setAvatarUrl(event.target.value)} type="url" value={avatarUrl} /></label><label>人格摘要<textarea maxLength={4000} onChange={(event) => setSummary(event.target.value)} required rows={6} value={summary} /></label><label>初始目标<textarea maxLength={4000} onChange={(event) => setInitialGoal(event.target.value)} rows={3} value={initialGoal} /></label><label>时区<input disabled value={life.timezone} /></label><button className="button primary" type="submit">保存设置</button></form>
    <section className="settings-form management-panel"><p className="eyebrow">PRIMARY AGENT</p><h2>主 Agent 交接</h2><p>必须先暂停生命。系统只发送 4 KiB 内的身份、活跃事务、意识残留与概念卡摘要，不迁移 Token 或远端原始 context。</p><div className="two-fields"><label>新的主 Agent<select disabled={candidates.length === 0} onChange={(event) => setPrimary(event.target.value)} value={primary}>{candidates.length === 0 ? <option value="">没有其他已就绪 Agent</option> : candidates.map((agent) => <option key={agent.agentConnectionId} value={agent.agentConnectionId}>{agent.name}</option>)}</select></label><div className="setting-action"><span>{life.state === "PAUSED" ? "生命已暂停，可以安全交接。" : "先在页首暂停生命。"}</span><button className="button quiet" disabled={life.state !== "PAUSED" || primary === ""} onClick={() => void api.changePrimaryAgent(life.lifeId, primary).then((result) => saved(result.life, "主 Agent 已换绑；有界交接摘要已保存。"))} type="button">更换主 Agent</button></div></div><div className="collaborator-settings"><h3>协作者</h3>{collaborators.length === 0 ? <p>没有绑定协作者。</p> : collaborators.map((agent) => <div key={agent.agentConnectionId}><span>{agent.name}</span><button className="button ghost" onClick={() => void api.unbindCollaborator(life.lifeId, agent.agentConnectionId).then(() => saved(life, "协作者绑定已解除。"))} type="button">解除绑定</button></div>)}</div></section>
    <section className="settings-form danger-zone"><p className="eyebrow">DATA CONTROL</p><h2>归档与删除</h2><p>归档会停止调度并保留全部本地记录。删除会永久移除本地生命数据，但不会声称删除远端 Agent 的 Task 或历史。</p><div className="row-actions"><button className="button quiet" disabled={life.archivedAt !== undefined} onClick={() => setDanger("archive")} type="button">归档生命</button><button className="button danger-text" disabled={busy} onClick={() => void openDelete()} type="button"><ShieldWarningIcon aria-hidden />删除生命…</button></div></section>
    {danger === null ? null : <div className="dialog-backdrop" role="presentation"><section aria-labelledby="danger-title" aria-modal="true" className="dialog danger-dialog" role="dialog"><p className="eyebrow">IRREVERSIBLE ACTION</p><h2 id="danger-title">{danger === "archive" ? "归档这个生命？" : "永久删除本地生命数据？"}</h2>{danger === "archive" ? <p>调度、闹钟与正在运行的 Wake 会停止；人格、事件、记忆和事务仍会保留。</p> : <><p>将删除 {impact?.events ?? 0} 个事件、{impact?.wakes ?? 0} 个 Wake、{impact?.affairs ?? 0} 个事务、{impact?.todos ?? 0} 个待办、{impact?.memories ?? 0} 条记忆、{impact?.alarms ?? 0} 个闹钟、{impact?.schedules ?? 0} 个作息和 {impact?.delegations ?? 0} 次委派。</p><p>受控文件：{impact?.artifacts ?? 0} 个 Artifact、{impact?.attachments ?? 0} 个消息附件，共 {((impact?.managedBytes ?? 0) / 1024 / 1024).toFixed(2)} MiB。文件会先进入本地隔离区，数据库删除成功后再清理。</p><label>输入生命名称“{life.name}”确认<input autoFocus onChange={(event) => setConfirmation(event.target.value)} value={confirmation} /></label></>}<div className="row-actions"><button className="button ghost" onClick={() => { setDanger(null); setConfirmation(""); }} type="button">取消</button><button className="button danger-text" disabled={busy || (danger === "delete" && confirmation !== life.name)} onClick={() => void confirmDanger()} type="button">{busy ? "处理中…" : danger === "archive" ? "确认归档" : "永久删除"}</button></div></section></div>}
  </div>;
}

function listenerStatus(listener: Record<string, unknown> | undefined): string {
  if (listener === undefined) return "未启用";
  return typeof listener.status === "string" ? listener.status : "unknown";
}

export function SystemPanel({ api, diagnostics, interactions }: { api?: DigitalLifeApi; diagnostics: DiagnosticsDto | null; interactions: InteractionDto[] }) {
  const [notice, setNotice] = useState<string | null>(null);
  return <section className="page-section"><header className="page-title-row"><div><p className="eyebrow">SYSTEM ACTIVITY</p><h1>系统活动</h1><p>只展示状态、计数和错误边界；不包含正文、Token、Origin 或绝对路径。</p></div>{api === undefined ? null : <div className="row-actions"><a className="button ghost" download href={api.diagnosticsExportUrl()}>导出脱敏诊断</a><button className="button danger" onClick={() => void api.emergencyStopAll().then(() => setNotice("所有生命已紧急停止；未确认远端调用保留恢复事实。"))} type="button">全局紧急停止</button></div>}</header>{notice === null ? null : <Notice tone="danger">{notice}</Notice>}{diagnostics === null ? <LoadingPage /> : <><div className="metric-strip"><div><span>Schema</span><strong>v{diagnostics.schemaVersion}</strong></div><div><span>Agent 连接</span><strong>{diagnostics.agents.connections}</strong></div><div><span>活跃调用</span><strong>{diagnostics.agents.activeInvocations ?? 0}</strong></div><div><span>活跃 Wake</span><strong>{diagnostics.runtime.activeWakes ?? 0}</strong></div><div><span>等待投递</span><strong>{diagnostics.runtime.pendingOutbox}</strong></div><div><span>SSE 事件</span><strong>{diagnostics.sse.events}</strong></div></div><div className="diagnostic-table"><div><span>数据库</span><strong>{diagnostics.database.state} · {diagnostics.database.journalMode} · integrity {diagnostics.database.integrity ?? "unknown"}</strong><i className={diagnostics.database.integrity === undefined || diagnostics.database.integrity === "ok" ? "ok" : "warn"}>{diagnostics.database.integrity === undefined || diagnostics.database.integrity === "ok" ? "正常" : "需检查"}</i></div><div><span>调度与租约</span><strong>{diagnostics.runtime.enabledSchedules ?? 0} 个作息 · {diagnostics.runtime.scheduledAlarms ?? 0} 个闹钟 · {diagnostics.runtime.leases ?? 0} 个租约</strong><i className={(diagnostics.runtime.staleWakeTurns ?? 0) > 0 ? "warn" : "ok"}>{(diagnostics.runtime.staleWakeTurns ?? 0) > 0 ? `${String(diagnostics.runtime.staleWakeTurns)} 个陈旧 Turn` : "正常"}</i></div><div><span>局域网监听</span><strong>{diagnostics.web.lan === undefined ? "未启用" : listenerStatus(diagnostics.web.lan)}</strong><i className={diagnostics.web.lan === undefined ? "muted" : "ok"}>{diagnostics.web.lan === undefined ? "仅本机" : "已配置"}</i></div><div><span>Web 会话</span><strong>{diagnostics.web.sessions} 个活跃会话</strong><i className="ok">受保护</i></div><div><span>Interactions</span><strong>{interactions.length} 个等待处理</strong><i className={interactions.length > 0 ? "warn" : "ok"}>{interactions.length > 0 ? "需要关注" : "正常"}</i></div></div></>}</section>;
}

export function SettingsPanel({ api, diagnostics }: { api: DigitalLifeApi; diagnostics: DiagnosticsDto | null }) {
  const [backups, setBackups] = useState<Awaited<ReturnType<DigitalLifeApi["listBackups"]>>["items"]>([]);
  const [sessions, setSessions] = useState<Awaited<ReturnType<DigitalLifeApi["listSessions"]>>["items"]>([]);
  const [settings, setSettings] = useState<Awaited<ReturnType<DigitalLifeApi["settings"]>> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadOperations = useCallback(async () => {
    const [backupPage, sessionPage, runtimeSettings] = await Promise.all([api.listBackups(), api.listSessions(), api.settings()]);
    setBackups(backupPage.items); setSessions(sessionPage.items); setSettings(runtimeSettings);
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => void loadOperations().catch(() => setNotice("运维设置暂时不可用。")), 0);
    return () => clearTimeout(timer);
  }, [loadOperations]);
  const createBackup = async () => {
    setNotice("正在生成 SQLite 一致性快照…");
    try { await api.createBackup(); await loadOperations(); setNotice("备份已完成并通过 hash 校验。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "备份未完成。"); }
  };
  const restore = async (backupId: string) => {
    if (!window.confirm("恢复会隔离当前数据、撤销会话并要求重新输入 Agent Token。继续后应用将重启。")) return;
    setNotice("正在校验备份并准备安全重启…");
    try { await api.restoreBackup(backupId); setNotice("恢复已排队，应用即将重启。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "恢复未开始。"); }
  };
  const updateRuntimeSettings = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const address = form.get("address"); const port = form.get("port");
    setNotice("正在保存本机设置…");
    try {
      const next = await api.updateSettings({
        lan: { address: typeof address === "string" ? address : "", enabled: form.get("enabled") === "on", port: typeof port === "string" ? Number(port) : 0, riskAccepted: form.get("riskAccepted") === "on" },
        launchAtLogin: form.get("launchAtLogin") === "on",
      });
      setSettings(next); setNotice(next.restartRequired ? "设置已保存；LAN Listener 会在应用重启后切换。" : "设置已保存。");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "设置未保存。"); }
  };
  const changePassword = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const current = form.get("currentPassword"); const next = form.get("newPassword");
    const currentPassword = typeof current === "string" ? current : ""; const newPassword = typeof next === "string" ? next : "";
    try { await api.changePassword(currentPassword, newPassword); event.currentTarget.reset(); await loadOperations(); setNotice("管理员口令已更新，所有 LAN 会话已撤销。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "口令未更新。"); }
  };
  return <section className="page-section settings-page"><header className="page-title-row"><div><p className="eyebrow">LOCAL OPERATIONS</p><h1>设置</h1><p>本机运行、可信局域网、数据边界与诊断。</p></div></header>{notice === null ? null : <Notice>{notice}</Notice>}<div className="settings-sections">
    <section><NetworkIcon aria-hidden /><div><h2>局域网与桌面</h2><p>只绑定明确的 RFC1918 IPv4；不使用 0.0.0.0，也不会自动修改防火墙。</p>{settings === null ? <span className="status-dot muted">正在读取</span> : <form className="inline-settings" key={JSON.stringify(settings)} onSubmit={(event) => void updateRuntimeSettings(event)}><label><input defaultChecked={settings.lan.enabled} name="enabled" type="checkbox" />启用 LAN Listener</label><label>地址<input defaultValue={settings.lan.address} name="address" placeholder="192.168.1.20" /></label><label>端口<input defaultValue={settings.lan.port} min="1024" name="port" type="number" /></label><label><input defaultChecked={settings.lan.riskAccepted} name="riskAccepted" type="checkbox" />我理解可信局域网 HTTP 不能抵御同网段主动窃听</label><label><input defaultChecked={settings.launchAtLogin} name="launchAtLogin" type="checkbox" />开机时启动</label><button className="button quiet" type="submit">保存运行设置</button></form>}</div></section>
    <section><ShieldWarningIcon aria-hidden /><div><h2>管理员与会话</h2><p>设备只显示脱敏标识；修改口令会撤销所有 LAN 会话，但保留桌面本地会话。</p><div className="session-list">{sessions.map((session) => <span key={session.deviceId}>{session.kind === "desktop" ? "桌面" : "LAN"} · {session.deviceId} · {new Date(session.lastActivityAt).toLocaleString()}{session.current ? " · 当前" : ""}</span>)}</div><form className="inline-settings" onSubmit={(event) => void changePassword(event)}><label>当前口令<input autoComplete="current-password" minLength={10} name="currentPassword" required type="password" /></label><label>新口令<input autoComplete="new-password" minLength={10} name="newPassword" required type="password" /></label><div className="row-actions"><button className="button quiet" type="submit">修改口令</button><button className="button ghost" onClick={() => void api.logoutAllLan().then(loadOperations).then(() => setNotice("LAN 会话已全部撤销。"))} type="button">退出所有 LAN 设备</button></div></form><span className={`status-dot ${diagnostics?.storage?.state === "low" ? "warn" : "ok"}`}>{diagnostics?.storage?.state === "low" ? "磁盘空间不足" : "凭据隔离"}</span></div></section>
    <section className="backup-settings"><ClockCounterClockwiseIcon aria-hidden /><div><h2>备份与恢复</h2><p>一致性备份不包含可迁移的明文 Agent Token；恢复后会撤销会话并将未终态调用置为人工复核。</p><span className="status-dot muted">Schema v{diagnostics?.schemaVersion ?? "—"} · {backups.length} 份可用备份</span>{backups.slice(0, 3).map((backup) => <div className="backup-row" key={backup.backupId}><span>{new Date(backup.createdAt).toLocaleString()} · {(backup.databaseBytes / 1024 / 1024).toFixed(1)} MiB</span><button className="button ghost" onClick={() => void restore(backup.backupId)} type="button">恢复</button></div>)}</div><button className="button quiet" onClick={() => void createBackup()} type="button">创建备份</button></section>
  </div></section>;
}

export function ConsoleApp({ api }: { api: DigitalLifeApi }) {
  const [section, setSection] = useState<Section>("lives"); const [lives, setLives] = useState<LifeDto[]>([]); const [agents, setAgents] = useState<AgentDto[]>([]);
  const [interactions, setInteractions] = useState<InteractionDto[]>([]); const [diagnostics, setDiagnostics] = useState<DiagnosticsDto | null>(null);
  const [selectedLife, setSelectedLife] = useState<LifeDto | null>(null); const [wizard, setWizard] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [streamState, setStreamState] = useState<"connected" | "reconnecting">("connected");
  const load = useCallback(async () => {
    try {
      const [lifePage, agentPage, interactionPage, health] = await Promise.all([api.listLives(), api.listAgents(), api.listInteractions(), api.diagnostics()]);
      setLives(lifePage.items); setAgents(agentPage.items); setInteractions(interactionPage.items); setDiagnostics(health); setError(null);
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : "控制台数据读取失败。"); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (typeof EventSource === "undefined") return undefined;
    const stream = new EventSource(`${api.origin}/api/v1/stream`, { withCredentials: true });
    stream.onopen = () => setStreamState("connected"); stream.onerror = () => setStreamState("reconnecting");
    const refresh = () => void load();
    for (const name of ["life.created", "life.updated", "life.state.changed", "event.created", "expression.created", "stream_reset"]) stream.addEventListener(name, refresh);
    return () => stream.close();
  }, [api.origin, load]);
  if (wizard) return <LifeWizard agents={agents} api={api} close={() => setWizard(false)} created={(life) => { setWizard(false); setSelectedLife(life); void load(); }} />;
  return <div className="app-shell"><aside className="sidebar"><header className="brand-bar" role="banner"><span className="wordmark-symbol">JOI</span><span><strong>joi</strong><small>LOCAL HUB</small></span></header><nav aria-label="主导航">{NAVIGATION.map(({ icon: Icon, key, label }) => <button aria-current={section === key && selectedLife === null ? "page" : undefined} key={key} onClick={() => { setSection(key); setSelectedLife(null); }} type="button"><Icon aria-hidden /><span>{label}</span></button>)}</nav><footer><span className={`stream-indicator ${streamState}`} /><span>{streamState === "connected" ? "Runtime 已连接" : "事件流重连中"}</span><button aria-label="退出登录" className="icon-button" onClick={() => void api.logout().finally(() => window.location.reload())} type="button"><SignOutIcon /></button></footer></aside><main className="console-main">{error === null ? null : <Notice tone="danger"><WarningCircleIcon aria-hidden />{error}<button className="button quiet" onClick={() => void load()} type="button">重试</button></Notice>}{loading ? <LoadingPage /> : selectedLife !== null ? <LifeDetail agents={agents} api={api} interactions={interactions} life={selectedLife} onBack={() => setSelectedLife(null)} onChanged={load} /> : section === "lives" ? <LifeHome agents={agents} lives={lives} onCreate={() => setWizard(true)} onOpen={setSelectedLife} /> : section === "agents" ? <AgentPanel agents={agents} api={api} refresh={load} /> : section === "system" ? <SystemPanel api={api} diagnostics={diagnostics} interactions={interactions} /> : <SettingsPanel api={api} diagnostics={diagnostics} />}</main></div>;
}
