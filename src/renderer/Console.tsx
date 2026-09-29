import {
  ArrowClockwiseIcon,
  ChartBarIcon,
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
  DeviceMobileIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent, useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import { ADMIN_PASSWORD_MIN_LENGTH } from "../shared/product";
import { ApiError, type DigitalLifeApi } from "./api";
import { WorkbenchManager, JoiHome, ModelSourceManager } from "./JoiHome";
import { PartnerPage } from "./PartnerPage";
import { JoiSkillSettings } from "./JoiSkillSettings";
import { AutomationPanel } from "./AutomationPanel";
import { listenerStatusLabel } from "./copy";
import type { DiagnosticsDto, InteractionDto } from "./types";
import type { SystemSettingsDto } from "../shared/system-settings";
import { StatisticsPage } from "./StatisticsPage";

type Section = "agents" | "automations" | "joi" | "lives" | "settings" | "statistics";
type SettingsTab = "connections" | "data" | "diagnostics" | "models" | "security" | "skills";

const SESSION_DISPLAY_LIMIT = 10;
const REMOTE_STATUS_REFRESH_MS = 1_000;
const DIAGNOSTICS_REFRESH_MS = 10_000;

const SETTINGS_TABS = [
  { key: "models", label: "模型网络" },
  { key: "skills", label: "技能" },
  { key: "connections", label: "设备连接" },
  { key: "security", label: "安全" },
  { key: "data", label: "数据" },
  { key: "diagnostics", label: "诊断" },
] as const satisfies readonly { key: SettingsTab; label: string }[];

const NAVIGATION = [
  { icon: ChatsCircleIcon, key: "joi", label: "joi" },
  { icon: HeartbeatIcon, key: "lives", label: "工作台" },
  { icon: RobotIcon, key: "agents", label: "搭档" },
  { icon: PulseIcon, key: "automations", label: "定时任务" },
  { icon: GearSixIcon, key: "settings", label: "设置" },
  { icon: ChartBarIcon, key: "statistics", label: "统计" },
] as const;

function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "danger" | "info" | "success" }) {
  return <div className={`inline-notice ${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

function LoadingPage() {
  return <div className="content-state" role="status" aria-label="joi 正在整理页面"><span className="load-line wide" /><span className="load-line" /><span className="load-block" /></div>;
}

function remoteStatusLabel(status: "connected" | "connecting" | "disabled" | "error"): string {
  if (status === "connected") return "手机链路已就绪";
  if (status === "connecting") return "正在建立安全链路";
  if (status === "disabled") return "尚未开启";
  return "原生链路暂时不可用";
}

export function RemoteAccessSettings({ api }: { api: DigitalLifeApi }) {
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [status, setStatus] = useState<Awaited<ReturnType<DigitalLifeApi["remoteAccessStatus"]>> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(async () => {
    const next = await api.remoteAccessStatus();
    setStatus(next);
    return next;
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => void load().catch(() => setNotice("没能读取远程连接状态。")), 0);
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (status?.enabled !== true || (status.status === "connected" && !diagnosticsOpen)) return;
    let refreshing = false;
    const timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void load()
        .then((next) => { if (status.status !== "connected" && next.status === "connected") setNotice("Joi 手机链路已就绪。"); })
        .catch(() => setNotice("没能读取远程连接状态。"))
        .finally(() => { refreshing = false; });
    }, REMOTE_STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, status?.enabled, status?.status, diagnosticsOpen]);
  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const relayUrl = form.get("relayUrl");
    setNotice("正在保存远程设置…");
    try {
      const next = await api.updateRemoteAccess({
        enabled: form.get("enabled") === "on",
        relayUrl: typeof relayUrl === "string" ? relayUrl : "",
      });
      setStatus(next);
      setNotice(next.status === "connected" ? "Joi 手机链路已就绪。" : "设置已保存，Joi 正在建立安全链路。");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "远程设置未保存。"); }
  };
  const createPairing = async () => {
    setNotice("正在生成一次性绑定二维码…");
    try { setStatus(await api.createRemotePairing()); setNotice("二维码将在 10 分钟后失效，绑定成功后也会立即失效。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "没能生成绑定二维码。"); }
  };
  const revoke = async (deviceId: string) => {
    try { setStatus(await api.revokeRemoteDevice(deviceId)); setNotice("这台手机已移除。"); }
    catch (error) { setNotice(error instanceof ApiError ? error.message : "没能移除这台手机。"); }
  };
  return <section className="remote-access-settings"><DeviceMobileIcon aria-hidden /><div>
    <h2>Joi 手机</h2>
    <p>Android App 会优先局域网直连，离开局域网后自动通过 iroh 中继继续连接。只开放任务卡片与文字输入，不开放设置、文件或危险操作。</p>
    {status === null ? <span className="status-dot muted">正在读取</span> : <>
      <span className={`status-dot ${status.status === "connected" ? "ok" : status.status === "error" ? "warn" : "muted"}`}>{remoteStatusLabel(status.status)}</span>
      <form className="inline-settings remote-access-form" key={`${status.hostId}:${status.relayUrl}`} onSubmit={(event) => void save(event)}>
        <label><input defaultChecked={status.enabled} name="enabled" type="checkbox" />允许已绑定的 Joi Android App 连接</label>
        <label>iroh 中继地址<input defaultValue={status.relayUrl} name="relayUrl" placeholder="https://remote.joilab.top" required type="url" /></label>
        <div className="row-actions"><button className="button quiet" type="submit">保存远程设置</button><button className="button primary" disabled={!status.enabled || status.status !== "connected"} onClick={() => void createPairing()} type="button">生成绑定二维码</button></div>
      </form>
      {status.pairing === undefined ? null : <div className="remote-pairing"><div aria-label="Joi Android App 绑定二维码"><QRCodeSVG bgColor="transparent" fgColor="currentColor" level="M" marginSize={2} size={184} value={status.pairing.qrUrl} /></div><div><strong>在 Joi App 中扫码</strong><span>{new Date(status.pairing.expiresAt).toLocaleTimeString()} 前有效 · 仅可绑定一次</span><small>配对密钥只存在于二维码与两端安全存储中，中继无法读取会话内容。</small></div></div>}
      {status.devices.length === 0 ? <small>还没有绑定手机。</small> : <div className="remote-device-list">{status.devices.map((device) => <div key={device.deviceId}><span><strong>{device.name}</strong><small>最近连接 {new Date(device.lastSeenAt).toLocaleString()}</small></span><button aria-label={`移除 ${device.name}`} className="icon-button danger" onClick={() => void revoke(device.deviceId)} type="button"><TrashIcon aria-hidden /></button></div>)}</div>}
    </>}
    {status?.diagnostics === undefined ? null : <details onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}><summary>连接诊断（最近 50 条）</summary>
      <small>仅记录阶段和错误码，不含二维码或消息。主机就绪不代表手机已连接。</small>
      {status.diagnostics.length === 0 ? <p>本次运行尚无连接记录。</p> : <ol>{status.diagnostics.map((entry) =>
        <li key={entry.sequence}><time>{new Date(entry.at).toLocaleTimeString()}</time> · {entry.code}</li>)}</ol>}
    </details>}
    {notice === null ? null : <div className="remote-settings-notice" role="status">{notice}</div>}
  </div></section>;
}

function PartnerMemoryDebug({ api }: { api: DigitalLifeApi }) {
  void api;
  return <section className="memory-debug-section">
    <h2>私有执行上下文</h2>
    <p>搭档实例、工作记忆和结果正文现在按工作台隔离；管理页只显示安全元数据，请到工作台上下文中心查看状态。</p>
  </section>;
}

export function SystemPanel({ api, diagnostics, interactions, onIntegrityCheck }: { api?: DigitalLifeApi; diagnostics: DiagnosticsDto | null; interactions: InteractionDto[]; onIntegrityCheck?: () => Promise<void> }) {
  const [notice, setNotice] = useState<string | null>(null);
  const dataHealthy = diagnostics?.database.integrity === undefined || diagnostics.database.integrity === "ok";
  const checkIntegrity = async () => {
    if (onIntegrityCheck === undefined) return;
    setNotice("正在后台检查本机数据…");
    try { await onIntegrityCheck(); setNotice("本机数据检查已完成。"); }
    catch { setNotice("本机数据检查暂时无法完成。"); }
  };
  const integrityLabel = diagnostics?.database.integrityChecking === true
    ? "检查中"
    : diagnostics?.database.integrity === "ok" ? "正常" : diagnostics?.database.integrity === "unknown" ? "尚未检查" : "需要检查";
  return <section className="page-section"><header className="page-title-row"><div><p className="eyebrow">joi 一直在留意</p><h1>joi 的运行状态</h1><p>joi 的简要状态，不会显示消息正文、密钥或文件位置。</p></div>{api === undefined ? null : <div className="row-actions"><a className="button ghost" download href={api.diagnosticsExportUrl()}>导出诊断</a>{onIntegrityCheck === undefined ? null : <button className="button ghost" disabled={diagnostics?.database.integrityChecking === true} onClick={() => void checkIntegrity()} type="button">重新检查本机数据</button>}<button className="button danger" onClick={() => void api.emergencyStopAll().then(() => setNotice("所有工作已紧急暂停，未确认的搭档过程仍会保留。"))} type="button">紧急暂停全部工作</button></div>}</header>{notice === null ? null : <Notice tone={notice.includes("无法") ? "danger" : "info"}>{notice}</Notice>}{diagnostics === null ? <LoadingPage /> : <><div className="metric-strip"><div><span>数据版本</span><strong>v{diagnostics.schemaVersion}</strong></div><div><span>工作搭档</span><strong>{diagnostics.agents.connections}</strong></div><div><span>正在协作</span><strong>{diagnostics.agents.activeInvocations ?? 0}</strong></div><div><span>正在行动</span><strong>{diagnostics.runtime.activeWakes ?? 0}</strong></div><div><span>等待处理</span><strong>{diagnostics.runtime.pendingOutbox}</strong></div><div><span>状态更新</span><strong>{diagnostics.sse.events}</strong></div></div><div className="diagnostic-table"><div><span>本机数据</span><strong>{dataHealthy ? "数据正常" : "数据有问题"}</strong><i className={dataHealthy ? "ok" : "warn"}>{integrityLabel}</i></div><div><span>日常安排</span><strong>{diagnostics.runtime.enabledSchedules ?? 0} 个作息 · {diagnostics.runtime.scheduledAlarms ?? 0} 个闹钟</strong><i className={(diagnostics.runtime.staleWakeTurns ?? 0) > 0 ? "warn" : "ok"}>{(diagnostics.runtime.staleWakeTurns ?? 0) > 0 ? `${String(diagnostics.runtime.staleWakeTurns)} 次行动需要确认` : "正常"}</i></div><div><span>其他设备访问</span><strong>{listenerStatusLabel(diagnostics.web.lan)}</strong><i className={diagnostics.web.lan === undefined ? "muted" : "ok"}>{diagnostics.web.lan === undefined ? "仅本机" : "已配置"}</i></div><div><span>已登录设备</span><strong>{diagnostics.web.sessions} 个活跃设备</strong><i className="ok">受保护</i></div><div><span>等你决定</span><strong>{interactions.length} 项待处理</strong><i className={interactions.length > 0 ? "warn" : "ok"}>{interactions.length > 0 ? "需要关注" : "正常"}</i></div></div>{api === undefined ? null : <PartnerMemoryDebug api={api} />}</>}</section>;
}

export function SettingsPanel({ api, diagnostics, interactions = [] }: { api: DigitalLifeApi; diagnostics: DiagnosticsDto | null; interactions?: InteractionDto[] }) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("models");
  const [currentDiagnostics, setCurrentDiagnostics] = useState<DiagnosticsDto | null>(diagnostics);
  const [backups, setBackups] = useState<Awaited<ReturnType<DigitalLifeApi["listBackups"]>>["items"]>([]);
  const [sessions, setSessions] = useState<Awaited<ReturnType<DigitalLifeApi["listSessions"]>>["items"]>([]);
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [lanDraft, setLanDraft] = useState<{ address: string; enabled: boolean; launchAtLogin: boolean; port: number; riskAccepted: boolean } | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const diagnosticsInFlight = useRef<Promise<void> | null>(null);
  const loadDiagnostics = useCallback((): Promise<void> => {
    if (diagnosticsInFlight.current !== null) return diagnosticsInFlight.current;
    const pending = api.diagnostics().then((next) => { setCurrentDiagnostics(next); }).finally(() => {
      if (diagnosticsInFlight.current === pending) diagnosticsInFlight.current = null;
    });
    diagnosticsInFlight.current = pending;
    return pending;
  }, [api]);
  const loadOperations = useCallback(async () => {
    const [backupPage, sessionPage, runtimeSettings] = await Promise.all([api.listBackups(), api.listSessions(), api.settings()]);
    setBackups(backupPage.items); setSessions(sessionPage.items); setSettings(runtimeSettings); setLanDraft({ ...runtimeSettings.lan, launchAtLogin: runtimeSettings.launchAtLogin });
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => void loadOperations().catch(() => setNotice("没能读取这些设置。")), 0);
    return () => clearTimeout(timer);
  }, [loadOperations]);
  useEffect(() => {
    if (diagnostics !== null) return;
    const timer = setTimeout(() => void loadDiagnostics().catch(() => setNotice("没能读取运行状态。")), 0);
    return () => clearTimeout(timer);
  }, [diagnostics, loadDiagnostics]);
  useEffect(() => {
    if (activeTab !== "diagnostics") return;
    const initial = setTimeout(() => void loadDiagnostics().catch(() => setNotice("没能刷新运行状态。")), 0);
    const interval = setInterval(() => void loadDiagnostics().catch(() => setNotice("没能刷新运行状态。")), DIAGNOSTICS_REFRESH_MS);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [activeTab, loadDiagnostics]);
  const checkDatabaseIntegrity = async () => {
    await api.checkDatabaseIntegrity();
    await loadDiagnostics();
  };
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
    event.preventDefault();
    if (lanDraft === null) return;
    if (!Number.isInteger(lanDraft.port) || lanDraft.port < 1024 || lanDraft.port > 65_535) { setNotice("访问端口必须在 1024 到 65535 之间。"); return; }
    if (lanDraft.enabled && lanDraft.address === "") { setNotice("请先选择这台电脑的局域网地址。"); return; }
    if (lanDraft.enabled && !lanDraft.riskAccepted) { setNotice("请先确认局域网明文连接风险。"); return; }
    setNotice("正在保存本机设置…");
    setSettingsSaving(true);
    try {
      const next = await api.updateSettings({
        lan: { address: lanDraft.address, enabled: lanDraft.enabled, port: lanDraft.port, riskAccepted: lanDraft.riskAccepted },
        launchAtLogin: lanDraft.launchAtLogin,
      });
      setSettings(next); setLanDraft({ ...next.lan, launchAtLogin: next.launchAtLogin });
      const effective = next.lan.effective ?? (next.lan.enabled
        ? { status: "blocked" as const, reasonCode: "lan_not_applied" as const, message: "LAN 配置尚未应用到当前进程。" }
        : { status: "disabled" as const });
      if (effective.status === "listening" && effective.pending === undefined) setNotice("设置已保存，局域网访问已立即生效。");
      else if (effective.status === "listening" && effective.pending !== undefined) setNotice("设置已保存，但新地址暂未应用，当前仍保留原监听。");
      else if (effective.status === "blocked") setNotice("设置已保存，但当前地址或端口暂时无法监听；本机访问仍可用。");
      else setNotice("设置已保存，局域网访问已关闭。");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "设置未保存。"); }
    finally { setSettingsSaving(false); }
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
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const tabCount = SETTINGS_TABS.length;
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabCount;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabCount) % tabCount;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabCount - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = SETTINGS_TABS[nextIndex];
    if (nextTab === undefined) return;
    setActiveTab(nextTab.key);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]').item(nextIndex).focus();
  };
  const refreshLanSettings = async () => {
    try {
      const next = await api.settings();
      setSettings(next); setLanDraft({ ...next.lan, launchAtLogin: next.launchAtLogin }); setNotice("局域网地址列表已刷新。");
    } catch (error) { setNotice(error instanceof ApiError ? error.message : "没能刷新局域网地址。"); }
  };
  const addressOptions = settings === null ? [] : [
    ...(settings.lan.availableAddresses ?? []),
    ...(settings.lan.address !== "" && !(settings.lan.availableAddresses ?? []).some((item) => item.address === settings.lan.address)
      ? [{ address: settings.lan.address, available: false }]
      : []),
  ];
  const effective = settings?.lan.effective ?? (settings?.lan.enabled
    ? { status: "blocked" as const, reasonCode: "lan_not_applied" as const, message: "LAN 配置尚未应用到当前进程。" }
    : settings === null ? undefined : { status: "disabled" as const });
  const effectiveLabel = effective === undefined || effective.status === "disabled"
    ? "仅限本机"
    : effective.status === "blocked" ? "暂时无法开放" : effective.pending === undefined ? "已对可信设备开放" : "新配置未应用";
  const selectedTab = SETTINGS_TABS.find((tab) => tab.key === activeTab) ?? SETTINGS_TABS[0];
  return <section className="page-section settings-page">
    <header className="page-title-row"><div><p className="eyebrow">按你的方式使用 joi</p><h1>joi 的设置</h1><p>管理模型网络、设备连接、安全和数据。</p></div></header>
    {notice === null ? null : <Notice>{notice}</Notice>}
    <div aria-label="设置分类" className="settings-tabs" role="tablist">
      {SETTINGS_TABS.map((tab, index) => <button
        aria-controls={`settings-panel-${tab.key}`}
        aria-selected={activeTab === tab.key}
        id={`settings-tab-${tab.key}`}
        key={tab.key}
        onClick={() => setActiveTab(tab.key)}
        onKeyDown={(event) => handleTabKeyDown(event, index)}
        role="tab"
        tabIndex={activeTab === tab.key ? 0 : -1}
        type="button"
      >{tab.label}</button>)}
    </div>
    <div
      aria-labelledby={`settings-tab-${selectedTab.key}`}
      className="settings-sections settings-tab-panel"
      id={`settings-panel-${selectedTab.key}`}
      role="tabpanel"
      tabIndex={0}
    >
      {activeTab === "models" ? <ModelSourceManager api={api} /> : null}
      {activeTab === "skills" ? <JoiSkillSettings api={api} /> : null}
      {activeTab === "connections" ? <>
        <RemoteAccessSettings api={api} />
        <section><NetworkIcon aria-hidden /><div><h2>其他设备访问</h2><p>同一可信网络里的设备可以找到 joi。joi 不会自动改网络设置。</p>{settings === null || lanDraft === null ? <span className="status-dot muted">正在读取</span> : <>
          <span className={`status-dot ${effective?.status === "blocked" ? "warn" : effective?.status === "listening" ? "ok" : "muted"}`}>{effectiveLabel}</span>
          {effective?.status === "listening" ? <small>{effective.pending === undefined ? `当前地址 ${effective.address}:${String(effective.port)}` : `当前仍在 ${effective.address}:${String(effective.port)} 监听，新配置等待应用`}</small> : null}
          {effective?.status === "blocked" ? <small className="field-hint">{effective.message}</small> : null}
          <form className="inline-settings" noValidate onSubmit={(event) => void updateRuntimeSettings(event)}>
            <label className="inline-check" htmlFor="lan-enabled"><input checked={lanDraft.enabled} id="lan-enabled" name="lanEnabled" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, enabled: event.target.checked })} type="checkbox" />允许局域网设备访问</label>
            <label htmlFor="lan-address">这台电脑的局域网地址<select required={lanDraft.enabled} id="lan-address" name="lanAddress" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, address: event.target.value })} value={lanDraft.address}><option value="">请选择地址</option>{addressOptions.map((item) => <option disabled={!item.available} key={item.address} value={item.address}>{item.address}{item.available ? "" : "（当前不可用）"}</option>)}</select></label>
            <label htmlFor="lan-port">访问端口<input id="lan-port" min="1024" name="lanPort" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, port: Number(event.target.value) })} type="number" value={lanDraft.port} /></label>
            {lanDraft.enabled ? <label className="inline-check" htmlFor="lan-risk"><input checked={lanDraft.riskAccepted} id="lan-risk" name="lanRiskAccepted" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, riskAccepted: event.target.checked })} type="checkbox" />我明白同一网络中的其他人可能看到未加密的连接内容</label> : null}
            <label className="inline-check" htmlFor="launch-at-login"><input checked={lanDraft.launchAtLogin} id="launch-at-login" name="launchAtLogin" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, launchAtLogin: event.target.checked })} type="checkbox" />开机时启动 joi</label>
            <div className="row-actions"><button className="button quiet" disabled={settingsSaving} type="submit">{settingsSaving ? "保存中…" : "保存访问设置"}</button><button className="button ghost" disabled={settingsSaving} onClick={() => void refreshLanSettings()} type="button">刷新地址</button></div>
          </form>
        </>}</div></section>
      </> : null}
      {activeTab === "security" ? <section><ShieldWarningIcon aria-hidden /><div><h2>管理密码与设备</h2><p>joi 只显示设备类型和最近活动时间。改了密码后其他设备需要重新登录，本机不受影响。</p><div className="session-list">{sessions.slice(0, SESSION_DISPLAY_LIMIT).map((session, index) => <span key={session.deviceId}>{session.current ? "当前设备" : session.kind === "desktop" ? "另一台本机窗口" : `局域网设备 ${String(index + 1)}`} · {new Date(session.lastActivityAt).toLocaleString()}</span>)}</div><form className="inline-settings" onSubmit={(event) => void changePassword(event)}><label>当前密码<input autoComplete="current-password" minLength={ADMIN_PASSWORD_MIN_LENGTH} name="currentPassword" required type="password" /></label><label>新密码<input autoComplete="new-password" minLength={ADMIN_PASSWORD_MIN_LENGTH} name="newPassword" required type="password" /></label><div className="row-actions"><button className="button quiet" type="submit">修改密码</button><button className="button ghost" onClick={() => void api.logoutAllLan().then(loadOperations).then(() => setNotice("所有局域网设备已退出。"))} type="button">退出所有局域网设备</button></div></form><span className={`status-dot ${currentDiagnostics?.storage?.state === "low" ? "warn" : "ok"}`}>{currentDiagnostics?.storage?.state === "low" ? "磁盘空间不足" : "密钥已隔离保存"}</span></div></section> : null}
      {activeTab === "data" ? <section className="backup-settings"><ClockCounterClockwiseIcon aria-hidden /><div><h2>备份与恢复</h2><p>备份不含搭档密钥。恢复后其他设备需要重新登录，未完成的协作会等你确认。</p><span className="status-dot muted">数据格式 v{currentDiagnostics?.schemaVersion ?? "-"} · {backups.length} 份可用备份</span>{backups.slice(0, 3).map((backup) => <div className="backup-row" key={backup.backupId}><span>{new Date(backup.createdAt).toLocaleString()} · {(backup.databaseBytes / 1024 / 1024).toFixed(1)} MB</span><button className="button ghost" onClick={() => void restore(backup.backupId)} type="button">恢复</button></div>)}</div><button className="button quiet" onClick={() => void createBackup()} type="button">创建备份</button></section> : null}
      {activeTab === "diagnostics" ? <SystemPanel api={api} diagnostics={currentDiagnostics} interactions={interactions} onIntegrityCheck={checkDatabaseIntegrity} /> : null}
    </div>
  </section>;
}

export function ConsoleApp({ api }: { api: DigitalLifeApi }) {
  const [section, setSection] = useState<Section>("joi");
  const [focusedGoalId, setFocusedGoalId] = useState<string | undefined>(undefined);
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState<string | undefined>();
  const [scheduledGoalId, setScheduledGoalId] = useState<string | undefined>();
  const contentRef = useRef<HTMLElement>(null);
  const [partnersTab, setPartnersTab] = useState<"partners" | "scenarios">("partners");
  const go = (next: Section, tab: "partners" | "scenarios" = "partners") => { setPartnersTab(tab); setSection(next); };
  const [interactions, setInteractions] = useState<InteractionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<"connected" | "connecting" | "reconnecting">("connecting");
  const statusInFlight = useRef<Promise<void> | null>(null);
  const load = useCallback((): Promise<void> => {
    if (statusInFlight.current !== null) return statusInFlight.current;
    const pending = api.listInteractions()
      .then((interactionPage) => { setInteractions(interactionPage.items); setError(null); setStreamState("connected"); })
      .catch((reason: unknown) => { setError(reason instanceof ApiError ? reason.message : "没能整理出最新状态。"); setStreamState("reconnecting"); })
      .finally(() => {
        setLoading(false);
        if (statusInFlight.current === pending) statusInFlight.current = null;
      });
    statusInFlight.current = pending;
    return pending;
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
  return <div className="app-shell"><aside className="sidebar"><header className="brand-bar" role="banner"><span className="wordmark-symbol">JOI</span><span><strong>joi</strong><small>思考、安排、派发</small></span></header><nav aria-label="主导航">{NAVIGATION.map(({ icon: Icon, key, label }) => <button aria-current={section === key ? "page" : undefined} key={key} onClick={() => { if (key === "lives") setSelectedWorkbenchId(undefined); if (key === "automations") setScheduledGoalId(undefined); setFocusedGoalId(undefined); setSection(key); }} type="button"><Icon aria-hidden /><span>{label}</span></button>)}</nav><footer><div className="stream-status"><span className={`stream-indicator ${streamState}`} /><span title={streamHint}>{streamLabel}</span></div>{streamState === "reconnecting" ? <button aria-label="重新连接状态更新" className="icon-button stream-retry" onClick={reconnectStream} title="重新连接状态更新" type="button"><ArrowClockwiseIcon aria-hidden /></button> : null}<button aria-label="退出登录" className="icon-button" onClick={() => void api.logout().finally(() => window.location.reload())} type="button"><SignOutIcon /></button></footer></aside><main className="console-main" ref={contentRef}>{error === null ? null : <Notice tone="danger"><WarningCircleIcon aria-hidden />{error}<button className="button quiet" onClick={() => void load()} type="button">再试一次</button></Notice>}{loading ? <LoadingPage /> : section === "joi" ? <JoiHome api={api} {...(focusedGoalId === undefined ? {} : { focusGoalId: focusedGoalId })} onNavigate={go} onScheduleGoal={(goalId) => { setScheduledGoalId(goalId); setSection("automations"); }} /> : section === "lives" ? <WorkbenchManager api={api} {...(selectedWorkbenchId === undefined ? {} : { initialWorkbenchId: selectedWorkbenchId })} /> : section === "agents" ? <PartnerPage api={api} onManageProviders={() => setSection("settings")} tab={partnersTab} onTabChange={setPartnersTab} /> : section === "automations" ? <AutomationPanel api={api} {...(scheduledGoalId === undefined ? {} : { initialGoalId: scheduledGoalId })} onOpenJoi={() => setSection("joi")} /> : section === "statistics" ? <StatisticsPage api={api} onOpenGoal={(goalId) => { setFocusedGoalId(goalId); setSection("joi"); }} /> : <SettingsPanel api={api} diagnostics={null} interactions={interactions} />}</main></div>;
}
