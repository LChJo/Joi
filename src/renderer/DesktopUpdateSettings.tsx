import { ArrowCircleUpIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { isJoiReleaseUrl, JOI_RELEASE_WINDOW, type DesktopUpdateCommand, type DesktopUpdateStatus } from "../shared/desktop-update";
import type { DigitalLifeApi } from "./api";
import { t } from "./i18n";

const ACTIVE_POLL_MS = 750;
const IDLE_POLL_MS = 15_000;

function isBusy(phase: DesktopUpdateStatus["phase"] | undefined): boolean {
  return phase === "checking" || phase === "downloading" || phase === "installing";
}

function statusMessage(status: DesktopUpdateStatus): string | undefined {
  if (status.mode === "disabled") return t("settings.updateUnavailable");
  switch (status.phase) {
    case "checking": return t("settings.updateChecking");
    case "unpublished": return t("settings.updateUnpublished");
    case "current": return t("settings.updateUpToDate");
    case "available":
      return status.mode === "manual" ? t("settings.updateNoInstaller") : undefined;
    case "downloading": return t("settings.updateDownloading");
    case "ready": return status.mode === "open" ? t("settings.updateMacInstructions") : t("settings.updateVerified");
    case "installing": return t("settings.updateInstalling");
    case "idle": return undefined;
  }
}

const errorMessages = {
  checkFailed: "settings.updateCheckFailed",
  downloadFailed: "settings.updateDownloadFailed",
  installFailed: "settings.updateInstallFailed",
} as const;

export function DesktopUpdateSettings({ api }: { api: DigitalLifeApi }) {
  const [status, setStatus] = useState<DesktopUpdateStatus>();
  const [readFailed, setReadFailed] = useState(false);
  const [commandFailed, setCommandFailed] = useState(false);
  const [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!api.desktop || pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      let delay = IDLE_POLL_MS;
      try {
        const next = await api.desktopUpdate(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        setReadFailed(false);
        if (isBusy(next.phase)) delay = ACTIVE_POLL_MS;
      } catch {
        if (controller.signal.aborted) return;
        setReadFailed(true);
      }
      timer = setTimeout(() => void read(), delay);
    };
    timer = setTimeout(() => void read(), 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, pending, refresh]);

  const command = async (input: DesktopUpdateCommand) => {
    setPending(true);
    setCommandFailed(false);
    try { setStatus(await api.updateDesktop(input)); }
    catch { setCommandFailed(true); }
    finally { setPending(false); }
  };

  const phase = status?.phase;
  const mode = status?.mode;
  const busy = pending || isBusy(phase);
  const latestVersion = status?.latestVersion;
  const releaseUrl = status?.releaseUrl;
  const enabled = status !== undefined && status.mode !== "disabled";
  const message = !api.desktop ? t("settings.updateDesktopOnly")
    : status === undefined ? readFailed ? undefined : t("settings.loading") : statusMessage(status);
  const error = readFailed || commandFailed ? t("settings.updateStatusFailed")
    : status?.error === undefined ? undefined : t(errorMessages[status.error]);
  return <section className="desktop-update-settings">
    <ArrowCircleUpIcon aria-hidden />
    <div>
      <h2>{t("settings.softwareUpdate")}</h2>
      <div className="desktop-update-summary" role="status">
        {status === undefined ? null : <p>{t("settings.updateCurrentVersion", { p0: status.currentVersion })}</p>}
        {latestVersion === undefined ? null : <p>{t("settings.updateLatestVersion", { p0: latestVersion })}</p>}
        {message === undefined ? null : <p>{message}</p>}
      </div>
      {error === undefined ? null : <p role="alert">{error}</p>}
      {phase === "downloading" ? <progress aria-label={t("settings.updateDownloading")} max={status?.progress?.totalBytes}
        value={status?.progress?.totalBytes === undefined ? undefined : status.progress.bytes} /> : null}
      {api.desktop ? <div className="row-actions">
        {status === undefined && readFailed ? <button className="button quiet" onClick={() => setRefresh((value) => value + 1)} type="button">{t("onboarding.tryAgain")}</button> : null}
        {enabled && phase !== "ready" && phase !== "downloading" && phase !== "installing"
          ? <button className="button quiet" disabled={busy} onClick={() => void command({ action: "check" })} type="button">{t("settings.updateCheck")}</button> : null}
        {phase === "available" && mode !== "manual" && latestVersion !== undefined
          ? <button className="button primary" disabled={busy} onClick={() => void command({ action: "download", version: latestVersion })} type="button">{t("settings.updateDownload")}</button> : null}
        {phase === "ready" && latestVersion !== undefined
          ? <button className="button primary" disabled={busy} onClick={() => void command({ action: "install", version: latestVersion })} type="button">
            {t(mode === "open" ? "settings.updateOpenInstaller" : "settings.updateRestartInstall")}
          </button> : null}
        {releaseUrl !== undefined && isJoiReleaseUrl(releaseUrl)
          ? <a className="button ghost" href={releaseUrl} rel="noopener noreferrer" target={JOI_RELEASE_WINDOW}>{t("settings.updateReleaseNotes")}</a> : null}
      </div> : null}
    </div>
  </section>;
}
