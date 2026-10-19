import { errorNotice, translateNotice, currentLocale, noticeMessage, t, useI18n, useNotice } from "./i18n";
import {
  ArchiveIcon,
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
import { ArchivedGoals, WorkbenchManager, JoiHome, ModelSourceManager } from "./JoiHome";
import { PartnerPage } from "./PartnerPage";
import { JoiSkillSettings } from "./JoiSkillSettings";
import { AutomationPanel } from "./AutomationPanel";
import { listenerStatusLabel } from "./copy";
import type { DiagnosticsDto, InteractionDto } from "./types";
import type { SystemSettingsDto } from "../shared/system-settings";
import { StatisticsPage } from "./StatisticsPage";
import { JoiBrand } from "./JoiBrand";
import { LanguageSelector } from "./LanguageSelector";

type Section = "agents" | "archived" | "automations" | "joi" | "lives" | "settings" | "statistics";
type SettingsTab = "connections" | "data" | "diagnostics" | "models" | "security" | "skills";

const SESSION_DISPLAY_LIMIT = 10;
const REMOTE_STATUS_REFRESH_MS = 1_000;
const DIAGNOSTICS_REFRESH_MS = 10_000;

const SETTINGS_TABS = [
  { key: "models", get label() { return t("settings.modelConnections"); } },
  { key: "skills", get label() { return t("settings.skills"); } },
  { key: "connections", get label() { return t("settings.deviceConnections"); } },
  { key: "security", get label() { return t("settings.security"); } },
  { key: "data", get label() { return t("settings.data"); } },
  { key: "diagnostics", get label() { return t("settings.diagnostics"); } },
] as const satisfies readonly { key: SettingsTab; label: string }[];

const NAVIGATION = [
  { icon: ChatsCircleIcon, key: "joi", label: "joi" },
  { icon: HeartbeatIcon, key: "lives", get label() { return t("common.workbenches"); } },
  { icon: RobotIcon, key: "agents", get label() { return t("common.partners"); } },
  { icon: PulseIcon, key: "automations", get label() { return t("common.scheduledTasks"); } },
  { icon: GearSixIcon, key: "settings", get label() { return t("common.settings"); } },
  { icon: ChartBarIcon, key: "statistics", get label() { return t("common.statistics"); } },
  { icon: ArchiveIcon, key: "archived", get label() { return t("common.archived"); } },
] as const;

function Notice({ children, tone = "info" }: { children: React.ReactNode; tone?: "danger" | "info" | "success" }) {
  useI18n();
  return <div className={`inline-notice ${tone}`} role={tone === "danger" ? "alert" : "status"}>{children}</div>;
}

function LoadingPage() {
  useI18n();
  return <div className="content-state" role="status" aria-label={t("settings.joiIsPreparingThePage")}><span className="load-line wide" /><span className="load-line" /><span className="load-block" /></div>;
}

function remoteStatusLabel(status: "connected" | "connecting" | "disabled" | "error"): string {
  if (status === "connected") return t("settings.mobileConnectionReady");
  if (status === "connecting") return t("settings.establishingASecureConnection");
  if (status === "disabled") return t("settings.notEnabled");
  return t("settings.theNativeConnectionIsTemporarilyUnavailable");
}

export function RemoteAccessSettings({ api }: { api: DigitalLifeApi }) {
  useI18n();
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [status, setStatus] = useState<Awaited<ReturnType<DigitalLifeApi["remoteAccessStatus"]>> | null>(null);
  const [notice, setNotice] = useNotice();
  const load = useCallback(async () => {
    const next = await api.remoteAccessStatus();
    setStatus(next);
    return next;
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => void load().catch(() => setNotice(noticeMessage("settings.couldNotLoadRemoteConnectionStatus"))), 0);
    return () => clearTimeout(timer);
  }, [load, setNotice]);
  useEffect(() => {
    if (status?.enabled !== true || (status.status === "connected" && !diagnosticsOpen)) return;
    let refreshing = false;
    const timer = setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void load()
        .then((next) => { if (status.status !== "connected" && next.status === "connected") setNotice(noticeMessage("settings.theJoiMobileConnectionIsReady")); })
        .catch(() => setNotice(noticeMessage("settings.couldNotLoadRemoteConnectionStatus")))
        .finally(() => { refreshing = false; });
    }, REMOTE_STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, status?.enabled, status?.status, diagnosticsOpen, setNotice]);
  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const relayUrl = form.get("relayUrl");
    setNotice(noticeMessage("settings.savingRemoteSettings"));
    try {
      const next = await api.updateRemoteAccess({
        enabled: form.get("enabled") === "on",
        relayUrl: typeof relayUrl === "string" ? relayUrl : "",
      });
      setStatus(next);
      setNotice(next.status === "connected" ? noticeMessage("settings.theJoiMobileConnectionIsReady") : noticeMessage("settings.settingsSavedJoiIsEstablishingASecureConnection"));
    } catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("settings.remoteSettingsCouldNotBeSaved")); }
  };
  const createPairing = async () => {
    setNotice(noticeMessage("settings.generatingASingleUsePairingQrCode"));
    try { setStatus(await api.createRemotePairing()); setNotice(noticeMessage("settings.theQrCodeExpiresIn10MinutesOrImmediately")); }
    catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("settings.couldNotGenerateThePairingQrCode")); }
  };
  const revoke = async (deviceId: string) => {
    try { setStatus(await api.revokeRemoteDevice(deviceId)); setNotice(noticeMessage("settings.thisPhoneHasBeenRemoved")); }
    catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("settings.couldNotRemoveThisPhone")); }
  };
  return <section className="remote-access-settings"><DeviceMobileIcon aria-hidden /><div>
    <h2>{t("settings.joiMobile")}</h2>
    <p>{t("settings.theAndroidAppConnectsDirectlyOverLanWhenPossible")}</p>
    {status === null ? <span className="status-dot muted">{t("settings.loading")}</span> : <>
      <span className={`status-dot ${status.status === "connected" ? "ok" : status.status === "error" ? "warn" : "muted"}`}>{remoteStatusLabel(status.status)}</span>
      <form className="inline-settings remote-access-form" key={`${status.hostId}:${status.relayUrl}`} onSubmit={(event) => void save(event)}>
        <label><input defaultChecked={status.enabled} name="enabled" type="checkbox" />{t("settings.allowPairedJoiAndroidAppsToConnect")}</label>
        <label>{t("settings.irohRelayUrl")}<input defaultValue={status.relayUrl} name="relayUrl" placeholder="https://remote.joilab.top" required type="url" /></label>
        <div className="row-actions"><button className="button quiet" type="submit">{t("settings.saveRemoteSettings")}</button><button className="button primary" disabled={!status.enabled || status.status !== "connected"} onClick={() => void createPairing()} type="button">{t("settings.generatePairingQrCode")}</button></div>
      </form>
      {status.pairing === undefined ? null : <div className="remote-pairing"><div aria-label={t("settings.joiAndroidAppPairingQrCode")}><QRCodeSVG bgColor="transparent" fgColor="currentColor" level="M" marginSize={2} size={184} value={status.pairing.qrUrl} /></div><div><strong>{t("settings.scanWithTheJoiApp")}</strong><span>{new Date(status.pairing.expiresAt).toLocaleTimeString(currentLocale())}  {t("settings.expirySingleUseOnly")}</span><small>{t("settings.pairingKeysExistOnlyInTheQrCodeAnd")}</small></div></div>}
      {status.devices.length === 0 ? <small>{t("settings.noPhonesPairedYet")}</small> : <div className="remote-device-list">{status.devices.map((device) => <div key={device.deviceId}><span><strong>{device.name}</strong><small>{t("settings.lastConnected")} {new Date(device.lastSeenAt).toLocaleString(currentLocale())}</small></span><button aria-label={t("settings.removeValue", { p0: device.name })} className="icon-button danger" onClick={() => void revoke(device.deviceId)} type="button"><TrashIcon aria-hidden /></button></div>)}</div>}
    </>}
    {status?.diagnostics === undefined ? null : <details onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}><summary>{t("settings.connectionDiagnosticsLatest50")}</summary>
      <small>{t("settings.onlyStagesAndErrorCodesAreRecordedWithoutQr")}</small>
      {status.diagnostics.length === 0 ? <p>{t("settings.noConnectionEventsInThisSession")}</p> : <ol>{status.diagnostics.map((entry) =>
        <li key={entry.sequence}><time>{new Date(entry.at).toLocaleTimeString(currentLocale())}</time> · {entry.code}</li>)}</ol>}
    </details>}
    {notice === null ? null : <div className="remote-settings-notice" role="status">{notice}</div>}
  </div></section>;
}

function PartnerMemoryDebug({ api }: { api: DigitalLifeApi }) {
  useI18n();
  void api;
  return <section className="memory-debug-section">
    <h2>{t("settings.privateExecutionContext")}</h2>
    <p>{t("settings.partnerInstancesWorkingMemoryAndResultsAreIsolatedBy")}</p>
  </section>;
}

export function SystemPanel({ api, diagnostics, interactions, onIntegrityCheck }: { api?: DigitalLifeApi; diagnostics: DiagnosticsDto | null; interactions: InteractionDto[]; onIntegrityCheck?: () => Promise<void> }) {
  useI18n();
  const [notice, setNotice] = useNotice();
  const dataHealthy = diagnostics?.database.integrity === undefined || diagnostics.database.integrity === "ok";
  const checkIntegrity = async () => {
    if (onIntegrityCheck === undefined) return;
    setNotice(noticeMessage("settings.checkingLocalDataInTheBackground"));
    try { await onIntegrityCheck(); setNotice(noticeMessage("settings.localDataCheckCompleted")); }
    catch { setNotice(noticeMessage("settings.theLocalDataCheckCouldNotBeCompleted")); }
  };
  const integrityLabel = diagnostics?.database.integrityChecking === true
    ? t("settings.checking")
    : diagnostics?.database.integrity === "ok" ? t("settings.healthy") : diagnostics?.database.integrity === "unknown" ? t("settings.notChecked") : t("settings.checkNeeded");
  return <section className="page-section"><header className="page-title-row"><div><p className="eyebrow">{t("settings.joiIsKeepingAnEyeOnThings")}</p><h1>{t("settings.joiRuntimeStatus")}</h1><p>{t("settings.aBriefStatusOverviewWithoutMessageContentCredentialsOr")}</p></div>{api === undefined ? null : <div className="row-actions"><a className="button ghost" download href={api.diagnosticsExportUrl()}>{t("settings.exportDiagnostics")}</a>{onIntegrityCheck === undefined ? null : <button className="button ghost" disabled={diagnostics?.database.integrityChecking === true} onClick={() => void checkIntegrity()} type="button">{t("settings.checkLocalDataAgain")}</button>}<button className="button danger" onClick={() => void api.emergencyStopAll().then(() => setNotice(noticeMessage("settings.allWorkHasBeenStoppedUnconfirmedPartnerActivityIs")))} type="button">{t("settings.emergencyStopAllWork")}</button></div>}</header>{notice === null ? null : <Notice tone={notice.includes(t("settings.unavailable")) ? "danger" : "info"}>{notice}</Notice>}{diagnostics === null ? <LoadingPage /> : <><div className="metric-strip"><div><span>{t("settings.dataVersion")}</span><strong>v{diagnostics.schemaVersion}</strong></div><div><span>{t("settings.workPartners")}</span><strong>{diagnostics.agents.connections}</strong></div><div><span>{t("settings.collaborating")}</span><strong>{diagnostics.agents.activeInvocations ?? 0}</strong></div><div><span>{t("settings.takingAction")}</span><strong>{diagnostics.runtime.activeWakes ?? 0}</strong></div><div><span>{t("settings.waitingToProcess")}</span><strong>{diagnostics.runtime.pendingOutbox}</strong></div><div><span>{t("settings.statusUpdates")}</span><strong>{diagnostics.sse.events}</strong></div></div><div className="diagnostic-table"><div><span>{t("settings.localData")}</span><strong>{dataHealthy ? t("settings.dataHealthy") : t("settings.dataNeedsAttention")}</strong><i className={dataHealthy ? "ok" : "warn"}>{integrityLabel}</i></div><div><span>{t("settings.dailySchedule")}</span><strong>{diagnostics.runtime.enabledSchedules ?? 0}  {t("settings.routines")} {diagnostics.runtime.scheduledAlarms ?? 0}  {t("settings.alarms")}</strong><i className={(diagnostics.runtime.staleWakeTurns ?? 0) > 0 ? "warn" : "ok"}>{(diagnostics.runtime.staleWakeTurns ?? 0) > 0 ? t("settings.valueActionsNeedConfirmation", { p0: String(diagnostics.runtime.staleWakeTurns) }) : t("settings.healthy")}</i></div><div><span>{t("settings.accessFromOtherDevices")}</span><strong>{listenerStatusLabel(diagnostics.web.lan)}</strong><i className={diagnostics.web.lan === undefined ? "muted" : "ok"}>{diagnostics.web.lan === undefined ? t("settings.thisComputerOnly") : t("settings.configured")}</i></div><div><span>{t("settings.signedInDevices")}</span><strong>{diagnostics.web.sessions}  {t("settings.activeDevices")}</strong><i className="ok">{t("settings.protected")}</i></div><div><span>{t("settings.waitingForYourDecision")}</span><strong>{interactions.length}  {t("settings.pendingItems")}</strong><i className={interactions.length > 0 ? "warn" : "ok"}>{interactions.length > 0 ? t("settings.needsAttention") : t("settings.healthy")}</i></div></div>{api === undefined ? null : <PartnerMemoryDebug api={api} />}</>}</section>;
}

export function SettingsPanel({ api, diagnostics, interactions = [] }: { api: DigitalLifeApi; diagnostics: DiagnosticsDto | null; interactions?: InteractionDto[] }) {
  useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>("models");
  const [currentDiagnostics, setCurrentDiagnostics] = useState<DiagnosticsDto | null>(diagnostics);
  const [backups, setBackups] = useState<Awaited<ReturnType<DigitalLifeApi["listBackups"]>>["items"]>([]);
  const [sessions, setSessions] = useState<Awaited<ReturnType<DigitalLifeApi["listSessions"]>>["items"]>([]);
  const [settings, setSettings] = useState<SystemSettingsDto | null>(null);
  const [lanDraft, setLanDraft] = useState<{ address: string; enabled: boolean; launchAtLogin: boolean; port: number; riskAccepted: boolean } | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [notice, setNotice] = useNotice();
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
    const timer = setTimeout(() => void loadOperations().catch(() => setNotice(noticeMessage("settings.couldNotLoadTheseSettings"))), 0);
    return () => clearTimeout(timer);
  }, [loadOperations, setNotice]);
  useEffect(() => {
    if (diagnostics !== null) return;
    const timer = setTimeout(() => void loadDiagnostics().catch(() => setNotice(noticeMessage("settings.couldNotLoadRuntimeStatus"))), 0);
    return () => clearTimeout(timer);
  }, [diagnostics, loadDiagnostics, setNotice]);
  useEffect(() => {
    if (activeTab !== "diagnostics") return;
    const initial = setTimeout(() => void loadDiagnostics().catch(() => setNotice(noticeMessage("settings.couldNotRefreshRuntimeStatus"))), 0);
    const interval = setInterval(() => void loadDiagnostics().catch(() => setNotice(noticeMessage("settings.couldNotRefreshRuntimeStatus"))), DIAGNOSTICS_REFRESH_MS);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, [activeTab, loadDiagnostics, setNotice]);
  const checkDatabaseIntegrity = async () => {
    await api.checkDatabaseIntegrity();
    await loadDiagnostics();
  };
  const createBackup = async () => {
    setNotice(noticeMessage("settings.savingABackup"));
    try { await api.createBackup(); await loadOperations(); setNotice(noticeMessage("settings.backupCompletedAndVerifiedByJoi")); }
    catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("settings.backupFailed")); }
  };
  const restore = async (backupId: string) => {
    if (!window.confirm(t("settings.joiWillIsolateCurrentDataAndSignOutOther"))) return;
    setNotice(noticeMessage("settings.checkingTheBackupAndPreparingToRestart"));
    try { await api.restoreBackup(backupId); setNotice(noticeMessage("settings.restoreQueuedTheAppWillRestartShortly")); }
    catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("settings.restoreCouldNotBeStarted")); }
  };
  const updateRuntimeSettings = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (lanDraft === null) return;
    if (!Number.isInteger(lanDraft.port) || lanDraft.port < 1024 || lanDraft.port > 65_535) { setNotice(noticeMessage("settings.theAccessPortMustBeBetween1024And65535")); return; }
    if (lanDraft.enabled && lanDraft.address === "") { setNotice(noticeMessage("settings.chooseThisComputerSLanAddressFirst")); return; }
    if (lanDraft.enabled && !lanDraft.riskAccepted) { setNotice(noticeMessage("settings.acknowledgeTheRisksOfUnencryptedLanAccessFirst")); return; }
    setNotice(noticeMessage("settings.savingLocalSettings"));
    setSettingsSaving(true);
    try {
      const next = await api.updateSettings({
        lan: { address: lanDraft.address, enabled: lanDraft.enabled, port: lanDraft.port, riskAccepted: lanDraft.riskAccepted },
        launchAtLogin: lanDraft.launchAtLogin,
      });
      setSettings(next); setLanDraft({ ...next.lan, launchAtLogin: next.launchAtLogin });
      const effective = next.lan.effective ?? (next.lan.enabled
        ? { status: "blocked" as const, reasonCode: "lan_not_applied" as const, message: t("settings.theLanConfigurationHasNotBeenAppliedToThe") }
        : { status: "disabled" as const });
      if (effective.status === "listening" && effective.pending === undefined) setNotice(noticeMessage("settings.settingsSavedLanAccessIsNowActive"));
      else if (effective.status === "listening" && effective.pending !== undefined) setNotice(noticeMessage("settings.settingsSavedButTheNewAddressIsNotActive"));
      else if (effective.status === "blocked") setNotice(noticeMessage("settings.settingsSavedButTheAddressOrPortCannotBe"));
      else setNotice(noticeMessage("settings.settingsSavedLanAccessIsNowDisabled"));
    } catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("settings.settingsCouldNotBeSaved")); }
    finally { setSettingsSaving(false); }
  };
  const changePassword = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Capture the form element before awaiting: event.currentTarget is nulled once dispatch returns.
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const current = form.get("currentPassword"); const next = form.get("newPassword");
    const currentPassword = typeof current === "string" ? current : ""; const newPassword = typeof next === "string" ? next : "";
    try { await api.changePassword(currentPassword, newPassword); formElement.reset(); await loadOperations(); setNotice(noticeMessage("settings.adminPasswordUpdatedOtherDevicesMustSignInAgain")); }
    catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("settings.passwordCouldNotBeUpdated")); }
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
      setSettings(next); setLanDraft({ ...next.lan, launchAtLogin: next.launchAtLogin }); setNotice(noticeMessage("settings.lanAddressListRefreshed"));
    } catch (error) { setNotice(error instanceof ApiError ? error.displayMessage : noticeMessage("settings.couldNotRefreshLanAddresses")); }
  };
  const addressOptions = settings === null ? [] : [
    ...(settings.lan.availableAddresses ?? []),
    ...(settings.lan.address !== "" && !(settings.lan.availableAddresses ?? []).some((item) => item.address === settings.lan.address)
      ? [{ address: settings.lan.address, available: false }]
      : []),
  ];
  const effective = settings?.lan.effective ?? (settings?.lan.enabled
    ? { status: "blocked" as const, reasonCode: "lan_not_applied" as const, message: t("settings.theLanConfigurationHasNotBeenAppliedToThe") }
    : settings === null ? undefined : { status: "disabled" as const });
  const effectiveLabel = effective === undefined || effective.status === "disabled"
    ? t("settings.localAccessOnly")
    : effective.status === "blocked" ? t("settings.sharingIsTemporarilyUnavailable") : effective.pending === undefined ? t("settings.availableToTrustedDevices") : t("settings.newConfigurationNotApplied");
  const selectedTab = SETTINGS_TABS.find((tab) => tab.key === activeTab) ?? SETTINGS_TABS[0];
  return <section className="page-section settings-page">
    <header className="page-title-row settings-page-header"><div className="settings-page-heading"><p className="eyebrow">{t("settings.makeJoiWorkYourWay")}</p><h1>{t("settings.joiSettings")}</h1><p>{t("settings.manageModelConnectionsDevicesSecurityAndData")}</p></div><LanguageSelector /></header>
    {notice === null ? null : <Notice>{notice}</Notice>}
    <div aria-label={t("settings.settingsCategories")} className="settings-tabs" role="tablist">
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
        <section><NetworkIcon aria-hidden /><div><h2>{t("settings.accessFromOtherDevices")}</h2><p>{t("settings.devicesOnTheSameTrustedNetworkCanAccessJoi")}</p>{settings === null || lanDraft === null ? <span className="status-dot muted">{t("settings.loading")}</span> : <>
          <span className={`status-dot ${effective?.status === "blocked" ? "warn" : effective?.status === "listening" ? "ok" : "muted"}`}>{effectiveLabel}</span>
          {effective?.status === "listening" ? <small>{effective.pending === undefined ? t("settings.currentAddressValueValue", { p0: effective.address, p1: String(effective.port) }) : t("settings.stillListeningOnValueValueTheNewConfigurationIs", { p0: effective.address, p1: String(effective.port) })}</small> : null}
          {effective?.status === "blocked" ? <small className="field-hint">{translateNotice(errorNotice(effective.reasonCode))}</small> : null}
          <form className="inline-settings" noValidate onSubmit={(event) => void updateRuntimeSettings(event)}>
            <label className="inline-check" htmlFor="lan-enabled"><input checked={lanDraft.enabled} id="lan-enabled" name="lanEnabled" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, enabled: event.target.checked })} type="checkbox" />{t("settings.allowLanDeviceAccess")}</label>
            <label htmlFor="lan-address">{t("settings.thisComputerSLanAddress")}<select required={lanDraft.enabled} id="lan-address" name="lanAddress" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, address: event.target.value })} value={lanDraft.address}><option value="">{t("settings.chooseAnAddress")}</option>{addressOptions.map((item) => <option disabled={!item.available} key={item.address} value={item.address}>{item.address}{item.available ? "" : t("settings.currentlyUnavailable")}</option>)}</select></label>
            <label htmlFor="lan-port">{t("settings.accessPort")}<input id="lan-port" min="1024" name="lanPort" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, port: Number(event.target.value) })} type="number" value={lanDraft.port} /></label>
            {lanDraft.enabled ? <label className="inline-check" htmlFor="lan-risk"><input checked={lanDraft.riskAccepted} id="lan-risk" name="lanRiskAccepted" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, riskAccepted: event.target.checked })} type="checkbox" />{t("settings.iUnderstandThatOthersOnThisNetworkMaySee")}</label> : null}
            <label className="inline-check" htmlFor="launch-at-login"><input checked={lanDraft.launchAtLogin} id="launch-at-login" name="launchAtLogin" onChange={(event) => setLanDraft((current) => current === null ? current : { ...current, launchAtLogin: event.target.checked })} type="checkbox" />{t("settings.launchJoiAtLogin")}</label>
            <div className="row-actions"><button className="button quiet" disabled={settingsSaving} type="submit">{settingsSaving ? t("settings.saving") : t("settings.saveAccessSettings")}</button><button className="button ghost" disabled={settingsSaving} onClick={() => void refreshLanSettings()} type="button">{t("settings.refreshAddresses")}</button></div>
          </form>
        </>}</div></section>
      </> : null}
      {activeTab === "security" ? <section><ShieldWarningIcon aria-hidden /><div><h2>{t("settings.passwordAndDevices")}</h2><p>{t("settings.joiShowsOnlyDeviceTypesAndRecentActivityChanging")}</p><div className="session-list">{sessions.slice(0, SESSION_DISPLAY_LIMIT).map((session, index) => <span key={session.deviceId}>{session.current ? t("settings.currentDevice") : session.kind === "desktop" ? t("settings.anotherDesktopWindow") : t("settings.lanDeviceValue", { p0: String(index + 1) })} · {new Date(session.lastActivityAt).toLocaleString(currentLocale())}</span>)}</div><form className="inline-settings" onSubmit={(event) => void changePassword(event)}><label>{t("settings.currentPassword")}<input autoComplete="current-password" minLength={ADMIN_PASSWORD_MIN_LENGTH} name="currentPassword" required type="password" /></label><label>{t("settings.newPassword")}<input autoComplete="new-password" minLength={ADMIN_PASSWORD_MIN_LENGTH} name="newPassword" required type="password" /></label><div className="row-actions"><button className="button quiet" type="submit">{t("settings.changePassword")}</button><button className="button ghost" onClick={() => void api.logoutAllLan().then(loadOperations).then(() => setNotice(noticeMessage("settings.allLanDevicesHaveBeenSignedOut")))} type="button">{t("settings.signOutAllLanDevices")}</button></div></form><span className={`status-dot ${currentDiagnostics?.storage?.state === "low" ? "warn" : "ok"}`}>{currentDiagnostics?.storage?.state === "low" ? t("settings.lowDiskSpace") : t("settings.credentialsStoredSeparately")}</span></div></section> : null}
      {activeTab === "data" ? <section className="backup-settings"><ClockCounterClockwiseIcon aria-hidden /><div><h2>{t("settings.backupAndRestore")}</h2><p>{t("settings.backupsExcludePartnerCredentialsAfterRestoringOtherDevicesMust")}</p><span className="status-dot muted">{t("settings.dataFormatV")}{currentDiagnostics?.schemaVersion ?? "-"} · {backups.length}  {t("settings.availableBackups")}</span>{backups.slice(0, 3).map((backup) => <div className="backup-row" key={backup.backupId}><span>{new Date(backup.createdAt).toLocaleString(currentLocale())} · {(backup.databaseBytes / 1024 / 1024).toFixed(1)} MB</span><button className="button ghost" onClick={() => void restore(backup.backupId)} type="button">{t("common.resume")}</button></div>)}</div><button className="button quiet" onClick={() => void createBackup()} type="button">{t("settings.createBackup")}</button></section> : null}
      {activeTab === "diagnostics" ? <SystemPanel api={api} diagnostics={currentDiagnostics} interactions={interactions} onIntegrityCheck={checkDatabaseIntegrity} /> : null}
    </div>
  </section>;
}

export function ConsoleApp({ api }: { api: DigitalLifeApi }) {
  useI18n();
  const [section, setSection] = useState<Section>("joi");
  const [focusedGoalId, setFocusedGoalId] = useState<string | undefined>(undefined);
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState<string | undefined>();
  const [scheduledGoalId, setScheduledGoalId] = useState<string | undefined>();
  const contentRef = useRef<HTMLElement>(null);
  const [partnersTab, setPartnersTab] = useState<"partners" | "scenarios">("partners");
  const go = (next: Section, tab: "partners" | "scenarios" = "partners") => { setPartnersTab(tab); setSection(next); };
  const [interactions, setInteractions] = useState<InteractionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useNotice();
  const [streamState, setStreamState] = useState<"connected" | "connecting" | "reconnecting">("connecting");
  const statusInFlight = useRef<Promise<void> | null>(null);
  const load = useCallback((): Promise<void> => {
    if (statusInFlight.current !== null) return statusInFlight.current;
    const pending = api.listInteractions()
      .then((interactionPage) => { setInteractions(interactionPage.items); setError(null); setStreamState("connected"); })
      .catch((reason: unknown) => { setError(reason instanceof ApiError ? reason.displayMessage : noticeMessage("settings.couldNotLoadTheLatestStatus")); setStreamState("reconnecting"); })
      .finally(() => {
        setLoading(false);
        if (statusInFlight.current === pending) statusInFlight.current = null;
      });
    statusInFlight.current = pending;
    return pending;
  }, [api, setError]);
  // SSE transport retired (ADR 0009): the console converges state by polling.
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    const interval = setInterval(() => void load(), 2_500);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [load]);
  const reconnectStream = () => { setStreamState("connecting"); void load(); };
  useEffect(() => { if (contentRef.current !== null) contentRef.current.scrollTop = 0; }, [section, selectedWorkbenchId]);
  return <div className="app-shell"><aside className="sidebar"><JoiBrand /><nav aria-label={t("settings.mainNavigation")}>{NAVIGATION.map(({ icon: Icon, key, label }) => <button aria-current={section === key ? "page" : undefined} key={key} onClick={() => { if (key === "lives") setSelectedWorkbenchId(undefined); if (key === "automations") setScheduledGoalId(undefined); setFocusedGoalId(undefined); setSection(key); }} type="button"><Icon aria-hidden /><span>{label}</span></button>)}</nav><footer>{streamState === "reconnecting" ? <div className="stream-status"><span className={`stream-indicator ${streamState}`} /><span title={t("settings.youCanStillUseThisPageAndRefreshStatus")}>{t("settings.statusUpdatesDisconnected")}</span></div> : null}{streamState === "reconnecting" ? <button aria-label={t("settings.reconnectStatusUpdates")} className="icon-button stream-retry" onClick={reconnectStream} title={t("settings.reconnectStatusUpdates")} type="button"><ArrowClockwiseIcon aria-hidden /></button> : null}<button aria-label={t("settings.signOut")} className="icon-button" onClick={() => void api.logout().finally(() => window.location.reload())} type="button"><SignOutIcon /></button></footer></aside><main className="console-main" ref={contentRef}>{error === null ? null : <Notice tone="danger"><WarningCircleIcon aria-hidden />{error}<button className="button quiet" onClick={() => void load()} type="button">{t("onboarding.tryAgain")}</button></Notice>}{loading ? <LoadingPage /> : section === "joi" ? <JoiHome api={api} {...(focusedGoalId === undefined ? {} : { focusGoalId: focusedGoalId })} onNavigate={go} onScheduleGoal={(goalId) => { setScheduledGoalId(goalId); setSection("automations"); }} /> : section === "lives" ? <WorkbenchManager api={api} {...(selectedWorkbenchId === undefined ? {} : { initialWorkbenchId: selectedWorkbenchId })} /> : section === "agents" ? <PartnerPage api={api} onManageProviders={() => setSection("settings")} tab={partnersTab} onTabChange={setPartnersTab} /> : section === "automations" ? <AutomationPanel api={api} {...(scheduledGoalId === undefined ? {} : { initialGoalId: scheduledGoalId })} onOpenJoi={() => setSection("joi")} /> : section === "statistics" ? <StatisticsPage api={api} onOpenGoal={(goalId) => { setFocusedGoalId(goalId); setSection("joi"); }} /> : section === "archived" ? <ArchivedGoals api={api} onContinued={(goalId) => { setFocusedGoalId(goalId); setSection("joi"); }} /> : <SettingsPanel api={api} diagnostics={null} interactions={interactions} />}</main></div>;
}
