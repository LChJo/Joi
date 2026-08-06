import {
  ArrowClockwiseIcon,
  ChatsCircleIcon,
  ClockCounterClockwiseIcon,
  GearSixIcon,
  HeartbeatIcon,
  NetworkIcon,
  PulseIcon,
  RobotIcon,
  ShieldWarningIcon,
  SignOutIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";

import { ADMIN_PASSWORD_MIN_LENGTH } from "../shared/product";
import { ApiError, type DigitalLifeApi } from "./api";
import { WorkbenchManager, JoiHome, ModelSourceManager } from "./JoiHome";
import { PartnerPage } from "./PartnerPage";
import { listenerStatusLabel } from "./copy";
import type { DiagnosticsDto, InteractionDto } from "./types";

type Section = "agents" | "joi" | "lives" | "settings" | "system";

const SESSION_DISPLAY_LIMIT = 10;

const NAVIGATION = [
  { icon: ChatsCircleIcon, key: "joi", label: "joi" },
  { icon: HeartbeatIcon, key: "lives", label: "工作台" },
  { icon: RobotIcon, key: "agents", label: "搭档" },
  { icon: PulseIcon, key: "system", label: "状态" },
  { icon: GearSixIcon, key: "settings", label: "设置" },
] as const;

function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "danger" | "info" | "success" }) {
  return <div className={`inline-notice ${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

function LoadingPage() {
  return <div className="content-state" role="status" aria-label="joi 正在整理页面"><span className="load-line wide" /><span className="load-line" /><span className="load-block" /></div>;
}

function PartnerMemoryDebug({ api }: { api: DigitalLifeApi }) {
  void api;
  return <section className="memory-debug-section">
    <h2>私有执行上下文</h2>
    <p>搭档实例、工作记忆和结果正文现在按工作台隔离；管理页只显示安全元数据，请到工作台上下文中心查看状态。</p>
  </section>;
}

export function SystemPanel({ api, diagnostics, interactions }: { api?: DigitalLifeApi; diagnostics: DiagnosticsDto | null; interactions: InteractionDto[] }) {
  const [notice, setNotice] = useState<string | null>(null);
  const dataHealthy = diagnostics?.database.integrity === undefined || diagnostics.database.integrity === "ok";
  return <section className="page-section"><header className="page-title-row"><div><p className="eyebrow">joi 一直在留意</p><h1>joi 的运行状态</h1><p>joi 的简要状态，不会显示消息正文、密钥或文件位置。</p></div>{api === undefined ? null : <div className="row-actions"><a className="button ghost" download href={api.diagnosticsExportUrl()}>导出诊断</a><button className="button danger" onClick={() => void api.emergencyStopAll().then(() => setNotice("所有工作已紧急暂停，未确认的搭档过程仍会保留。"))} type="button">紧急暂停全部工作</button></div>}</header>{notice === null ? null : <Notice tone="danger">{notice}</Notice>}{diagnostics === null ? <LoadingPage /> : <><div className="metric-strip"><div><span>数据版本</span><strong>v{diagnostics.schemaVersion}</strong></div><div><span>工作搭档</span><strong>{diagnostics.agents.connections}</strong></div><div><span>正在协作</span><strong>{diagnostics.agents.activeInvocations ?? 0}</strong></div><div><span>正在行动</span><strong>{diagnostics.runtime.activeWakes ?? 0}</strong></div><div><span>等待处理</span><strong>{diagnostics.runtime.pendingOutbox}</strong></div><div><span>状态更新</span><strong>{diagnostics.sse.events}</strong></div></div><div className="diagnostic-table"><div><span>本机数据</span><strong>{dataHealthy ? "数据正常" : "数据有问题"}</strong><i className={dataHealthy ? "ok" : "warn"}>{dataHealthy ? "正常" : "需要检查"}</i></div><div><span>日常安排</span><strong>{diagnostics.runtime.enabledSchedules ?? 0} 个作息 · {diagnostics.runtime.scheduledAlarms ?? 0} 个闹钟</strong><i className={(diagnostics.runtime.staleWakeTurns ?? 0) > 0 ? "warn" : "ok"}>{(diagnostics.runtime.staleWakeTurns ?? 0) > 0 ? `${String(diagnostics.runtime.staleWakeTurns)} 次行动需要确认` : "正常"}</i></div><div><span>其他设备访问</span><strong>{listenerStatusLabel(diagnostics.web.lan)}</strong><i className={diagnostics.web.lan === undefined ? "muted" : "ok"}>{diagnostics.web.lan === undefined ? "仅本机" : "已配置"}</i></div><div><span>已登录设备</span><strong>{diagnostics.web.sessions} 个活跃设备</strong><i className="ok">受保护</i></div><div><span>等你决定</span><strong>{interactions.length} 项待处理</strong><i className={interactions.length > 0 ? "warn" : "ok"}>{interactions.length > 0 ? "需要关注" : "正常"}</i></div></div>{api === undefined ? null : <PartnerMemoryDebug api={api} />}</>}</section>;
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
    const timer = setTimeout(() => void loadOperations().catch(() => setNotice("没能读取这些设置。")), 0);
    return () => clearTimeout(timer);
  }, [loadOperations]);
  const createBackup = async () => {
    setNotice("正在保存备份…");
    try { await api.createBackup(); await loadOperations(); setNotice("备份已完成，joi 检查过了。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "备份没成功。"); }
  };
  const restore = async (backupId: string) => {
    if (!window.confirm("恢复前 joi 会隔离当前数据并退出其他设备。恢复后需要重新输入搭档密钥，应用也会重启。继续吗？")) return;
    setNotice("正在检查备份并准备重启…");
    try { await api.restoreBackup(backupId); setNotice("恢复已排队，应用即将重启。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "恢复没开始。"); }
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
      setSettings(next); setNotice(next.restartRequired ? "设置已保存，重启后其他设备的访问方式会切换。" : "设置已保存。");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "设置未保存。"); }
  };
  const changePassword = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Capture the form element before awaiting: event.currentTarget is nulled once dispatch returns.
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const current = form.get("currentPassword"); const next = form.get("newPassword");
    const currentPassword = typeof current === "string" ? current : ""; const newPassword = typeof next === "string" ? next : "";
    try { await api.changePassword(currentPassword, newPassword); formElement.reset(); await loadOperations(); setNotice("管理密码已更新，其他设备需要重新登录。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "密码没更新。"); }
  };
  return <section className="page-section settings-page"><header className="page-title-row"><div><p className="eyebrow">按你的方式使用 joi</p><h1>joi 的设置</h1><p>管理模型网络、其他设备访问、管理密码和数据备份。</p></div></header>{notice === null ? null : <Notice>{notice}</Notice>}<div className="settings-sections">
    <ModelSourceManager api={api} />
    <section><NetworkIcon aria-hidden /><div><h2>其他设备访问</h2><p>同一可信网络里的设备可以找到 joi。joi 不会自动改网络设置。</p>{settings === null ? <span className="status-dot muted">正在读取</span> : <form className="inline-settings" key={JSON.stringify(settings)} onSubmit={(event) => void updateRuntimeSettings(event)}><label><input defaultChecked={settings.lan.enabled} name="enabled" type="checkbox" />允许局域网设备访问</label><label>这台电脑的局域网地址<input defaultValue={settings.lan.address} name="address" placeholder="192.168.1.20" /></label><label>访问端口<input defaultValue={settings.lan.port} min="1024" name="port" type="number" /></label><label><input defaultChecked={settings.lan.riskAccepted} name="riskAccepted" type="checkbox" />我明白同一网络中的其他人可能看到未加密的连接内容</label><label><input defaultChecked={settings.launchAtLogin} name="launchAtLogin" type="checkbox" />开机时启动 joi</label><button className="button quiet" type="submit">保存访问设置</button></form>}</div></section>
    <section><ShieldWarningIcon aria-hidden /><div><h2>管理密码与设备</h2><p>joi 只显示设备类型和最近活动时间。改了密码后其他设备需要重新登录，本机不受影响。</p><div className="session-list">{sessions.slice(0, SESSION_DISPLAY_LIMIT).map((session, index) => <span key={session.deviceId}>{session.current ? "当前设备" : session.kind === "desktop" ? "另一台本机窗口" : `局域网设备 ${String(index + 1)}`} · {new Date(session.lastActivityAt).toLocaleString()}</span>)}</div><form className="inline-settings" onSubmit={(event) => void changePassword(event)}><label>当前密码<input autoComplete="current-password" minLength={ADMIN_PASSWORD_MIN_LENGTH} name="currentPassword" required type="password" /></label><label>新密码<input autoComplete="new-password" minLength={ADMIN_PASSWORD_MIN_LENGTH} name="newPassword" required type="password" /></label><div className="row-actions"><button className="button quiet" type="submit">修改密码</button><button className="button ghost" onClick={() => void api.logoutAllLan().then(loadOperations).then(() => setNotice("所有局域网设备已退出。"))} type="button">退出所有局域网设备</button></div></form><span className={`status-dot ${diagnostics?.storage?.state === "low" ? "warn" : "ok"}`}>{diagnostics?.storage?.state === "low" ? "磁盘空间不足" : "密钥已隔离保存"}</span></div></section>
    <section className="backup-settings"><ClockCounterClockwiseIcon aria-hidden /><div><h2>备份与恢复</h2><p>备份不含搭档密钥。恢复后其他设备需要重新登录，未完成的协作会等你确认。</p><span className="status-dot muted">数据格式 v{diagnostics?.schemaVersion ?? "-"} · {backups.length} 份可用备份</span>{backups.slice(0, 3).map((backup) => <div className="backup-row" key={backup.backupId}><span>{new Date(backup.createdAt).toLocaleString()} · {(backup.databaseBytes / 1024 / 1024).toFixed(1)} MB</span><button className="button ghost" onClick={() => void restore(backup.backupId)} type="button">恢复</button></div>)}</div><button className="button quiet" onClick={() => void createBackup()} type="button">创建备份</button></section>
  </div></section>;
}

export function ConsoleApp({ api }: { api: DigitalLifeApi }) {
  const [section, setSection] = useState<Section>("joi");
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState<string | undefined>();
  const contentRef = useRef<HTMLElement>(null);
  const [partnersTab, setPartnersTab] = useState<"partners" | "scenarios">("partners");
  const go = (next: Section, tab: "partners" | "scenarios" = "partners") => { setPartnersTab(tab); setSection(next); };
  const [interactions, setInteractions] = useState<InteractionDto[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"connected" | "connecting" | "reconnecting">("connecting");
  const load = useCallback(async () => {
    try {
      const [interactionPage, health] = await Promise.all([api.listInteractions(), api.diagnostics()]);
      setInteractions(interactionPage.items); setDiagnostics(health); setError(null); setStreamState("connected");
    } catch (reason) { setError(reason instanceof ApiError ? reason.message : "没能整理出最新状态。"); setStreamState("reconnecting"); }
    finally { setLoading(false); }
  }, [api]);
  // SSE transport retired (ADR 0009): the console converges state by polling.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    const interval = setInterval(() => void load(), 2_500);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [load]);
  const streamLabel = streamState === "connected" ? "状态自动刷新" : streamState === "connecting" ? "正在连接状态" : "状态刷新暂时断开";
  const streamHint = streamState === "reconnecting" ? "页面仍可使用，可以手动刷新状态。" : "joi 会按固定节奏刷新最新状态。";
  const reconnectStream = () => { setStreamState("connecting"); void load(); };
  useEffect(() => { if (contentRef.current !== null) contentRef.current.scrollTop = 0; }, [section, selectedWorkbenchId]);
  return <div className="app-shell"><aside className="sidebar"><header className="brand-bar" role="banner"><span className="wordmark-symbol">JOI</span><span><strong>joi</strong><small>思考、安排、派发</small></span></header><nav aria-label="主导航">{NAVIGATION.map(({ icon: Icon, key, label }) => <button aria-current={section === key ? "page" : undefined} key={key} onClick={() => { if (key === "lives") setSelectedWorkbenchId(undefined); setSection(key); }} type="button"><Icon aria-hidden /><span>{label}</span></button>)}</nav><footer><div className="stream-status"><span className={`stream-indicator ${streamState}`} /><span title={streamHint}>{streamLabel}</span></div>{streamState === "reconnecting" ? <button aria-label="重新连接状态更新" className="icon-button stream-retry" onClick={reconnectStream} title="重新连接状态更新" type="button"><ArrowClockwiseIcon aria-hidden /></button> : null}<button aria-label="退出登录" className="icon-button" onClick={() => void api.logout().finally(() => window.location.reload())} type="button"><SignOutIcon /></button></footer></aside><main className="console-main" ref={contentRef}>{error === null ? null : <Notice tone="danger"><WarningCircleIcon aria-hidden />{error}<button className="button quiet" onClick={() => void load()} type="button">再试一次</button></Notice>}{loading ? <LoadingPage /> : section === "joi" ? <JoiHome api={api} onNavigate={go} /> : section === "lives" ? <WorkbenchManager api={api} {...(selectedWorkbenchId === undefined ? {} : { initialWorkbenchId: selectedWorkbenchId })} /> : section === "agents" ? <PartnerPage api={api} onManageProviders={() => setSection("settings")} tab={partnersTab} onTabChange={setPartnersTab} /> : section === "system" ? <SystemPanel api={api} diagnostics={diagnostics} interactions={interactions} /> : <SettingsPanel api={api} diagnostics={diagnostics} />}</main></div>;
}
