import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startDesktopRuntime } from "./composition/desktop-runtime-client.js";
import { ElectronCredentialVault } from "./infrastructure/security/electron-credential-vault.js";
import { ElectronResultExporter } from "./infrastructure/artifacts/electron-result-export.js";
import { transcodeBitmapToPng } from "./infrastructure/artifacts/bitmap-transcoder.js";
import { DomainError } from "./domain/errors.js";
import { trayMenuTemplate } from "./infrastructure/operations/tray-menu.js";
import { DesktopUpdater } from "./infrastructure/operations/desktop-updater.js";
import { PRODUCT_NAME, type DesktopBootstrapNonce, type DesktopRuntimeInfo } from "../shared/product.js";
import { resolveLocale, translate, type UiLocalePreference } from "../shared/i18n/index.js";
import { CODEX_AUTHORIZATION_WINDOW, isCodexAuthorizationUrl } from "../shared/codex-authorization.js";
import { isJoiReleaseUrl, JOI_RELEASE_WINDOW } from "../shared/desktop-update.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const isTest = process.env.JOI_TEST === "1";
const developmentUrl = process.env.VITE_DEV_SERVER_URL;
const developmentApiPort = developmentUrl === undefined ? undefined : process.env.JOI_DEV_API_PORT;
const applicationIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "resources", "branding", "icon.png")
  : path.resolve(currentDirectory, "../../../resources/branding/icon.png");
const retainedDevDataPath = !app.isPackaged && isTest && developmentUrl !== undefined
  ? process.env.JOI_DEV_USER_DATA_DIR?.trim() : undefined;
if (retainedDevDataPath !== undefined && !path.isAbsolute(retainedDevDataPath)) {
  throw new Error("JOI_DEV_USER_DATA_DIR must be an absolute path.");
}
const testUserDataPath = isTest && retainedDevDataPath === undefined
  ? path.join(os.tmpdir(), `joi-e2e-${String(process.pid)}-${randomUUID()}`)
  : undefined;

const isolatedDataPath = retainedDevDataPath ?? testUserDataPath;
if (isolatedDataPath !== undefined) {
  app.setPath("userData", isolatedDataPath);
}

// An ephemeral test profile is unique to its process. Reusable profiles require a lock.
const hasSingleInstanceLock = testUserDataPath !== undefined || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let runtime: Awaited<ReturnType<typeof startDesktopRuntime>> | null = null;
let tray: Tray | null = null;
let uiLocale: UiLocalePreference = "system";
const nativeText = (key: "common.trayOpen" | "common.trayStop" | "common.trayLogin" | "common.trayQuit" | "common.directoryPicker") => translate(resolveLocale(uiLocale, app.getPreferredSystemLanguages()), key);
let isQuitting = false;
let restartRequested = false;
let pendingWindowsUpdate: string | undefined;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function startRuntime(desktopUpdate: DesktopUpdater): Promise<void> {
  const vault = new ElectronCredentialVault();
  const userDataDirectory = app.getPath("userData");
  const loopbackPort = developmentApiPort === undefined ? undefined : Number(developmentApiPort);
  if (loopbackPort !== undefined && (!Number.isInteger(loopbackPort) || loopbackPort < 1 || loopbackPort > 65_535)) {
    throw new Error("Invalid Joi development API port.");
  }
  runtime = await startDesktopRuntime({
    systemLanguages: app.getPreferredSystemLanguages(),
    userDataDirectory,
    migrationsDirectory: app.isPackaged ? path.join(process.resourcesPath, "resources", "migrations") : path.resolve("resources/migrations"),
    rendererDirectory: path.resolve(currentDirectory, "../../renderer"),
    runDirectory: path.join(isTest ? userDataDirectory : app.getPath("home"), "joi", "runs"),
    remoteSidecarPath: app.isPackaged
      ? path.join(process.resourcesPath, "resources", "native", process.platform, `joi-remote-sidecar${process.platform === "win32" ? ".exe" : ""}`)
      : path.resolve("native", "joi-remote", "target", "release", `joi-remote-sidecar${process.platform === "win32" ? ".exe" : ""}`),
    appVersion: app.getVersion(), isTest,
    ...(loopbackPort === undefined ? {} : { loopbackPort }),
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    credentialStorageAvailable: vault.isAvailable(),
  }, {
    desktopUpdate,
    vault,
    getLaunchAtLogin: () => app.getLoginItemSettings().openAtLogin,
    setUiLocale: (preference) => { uiLocale = preference; rebuildTrayMenu(); },
    setLaunchAtLogin: (enabled) => { app.setLoginItemSettings({ openAtLogin: enabled }); rebuildTrayMenu(); },
    directoryPicker: async () => {
      try {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: nativeText("common.directoryPicker") });
        return result.canceled ? null : result.filePaths[0] ?? null;
      } catch { return null; }
    },
    artifactOpen: async (input) => {
      try {
        if (input.mode === "REVEAL") shell.showItemInFolder(input.targetPath);
        else if (await shell.openPath(input.targetPath) !== "") throw new Error("shell_open_failed");
      } catch { throw new DomainError("workbench_artifact_open_failed", "The artifact could not be opened."); }
    },
    transcodeBitmap: (input) => Promise.resolve(transcodeBitmapToPng(input)),
    requestRestart: requestApplicationRestart,
    createExporter: (jobs) => new ElectronResultExporter({ jobs, downloads: isTest ? path.join(userDataDirectory, "downloads") : app.getPath("downloads"),
      fontPath: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), "resources", "fonts", "NotoSansSC.ttf") }),
  }, () => { process.stderr.write("Runtime worker stopped unexpectedly.\n"); app.exit(1); });
}

function createMainWindow() {
  const window = new BrowserWindow({
    backgroundColor: "#111715",
    height: 760,
    icon: applicationIconPath,
    minHeight: 640,
    minWidth: 960,
    show: false,
    title: PRODUCT_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      sandbox: true,
    },
    width: 1180,
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(({ frameName, url }) => {
    if (frameName === JOI_RELEASE_WINDOW) {
      if (isJoiReleaseUrl(url)) void shell.openExternal(url).catch(() => undefined);
      return { action: "deny" };
    }
    if (frameName !== CODEX_AUTHORIZATION_WINDOW) return { action: "allow" };
    if (isCodexAuthorizationUrl(url)) void shell.openExternal(url).catch(() => undefined);
    return { action: "deny" };
  });

  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (!isQuitting && !isTest) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on("closed", () => {
    mainWindow = null;
  });

  if (developmentUrl !== undefined) {
    void window.loadURL(developmentUrl);
  } else {
    if (runtime === null) throw new Error("Runtime listener is not ready.");
    void window.loadURL(runtime.apiOrigin);
  }

  return window;
}

function showMainWindow() {
  mainWindow ??= createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function requestApplicationRestart() {
  restartRequested = true;
  isQuitting = true;
  app.quit();
}

function requestApplicationQuit() {
  isQuitting = true;
  app.quit();
}

async function createDesktopUpdater(): Promise<DesktopUpdater> {
  let mode: "disabled" | "open" | "restart" = "disabled";
  if (app.isPackaged && !isTest) {
    if (process.platform === "darwin") mode = "open";
    if (process.platform === "win32" && existsSync(path.join(path.dirname(process.execPath), "Uninstall joi.exe"))) mode = "restart";
  }
  const directory = path.join(app.getPath("userData"), "desktop-updates");
  if (mode !== "disabled") await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  return new DesktopUpdater({
    arch: process.arch,
    currentVersion: app.getVersion(),
    directory,
    mode,
    install: async (installer) => {
      if (isQuitting) throw new Error("application_quitting");
      if (mode === "open") {
        if (await shell.openPath(installer) !== "") throw new Error("installer_open_failed");
      } else {
        pendingWindowsUpdate = installer;
        requestApplicationQuit();
      }
    },
  });
}

async function launchWindowsUpdate(installer: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(installer, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function rebuildTrayMenu() {
  if (tray === null) return;
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(uiLocale, app.getPreferredSystemLanguages(), launchAtLogin, {
    open: showMainWindow,
    stop: () => { void runtime?.emergencyStop(); },
    quit: requestApplicationQuit,
    setLaunchAtLogin: (enabled) => { app.setLoginItemSettings({ openAtLogin: enabled }); rebuildTrayMenu(); },
  })));
}

function createRuntimeTray() {
  if (isTest || tray !== null) return;
  const icon = nativeImage.createFromPath(applicationIconPath).resize({ height: 32, quality: "best", width: 32 });
  tray = new Tray(icon);
  tray.setToolTip(PRODUCT_NAME);
  tray.on("click", showMainWindow);
  rebuildTrayMenu();
}

async function shutdownRuntime(): Promise<void> {
  await runtime?.close();
  runtime = null;
  tray?.destroy();
  tray = null;
}

ipcMain.handle("desktop:runtime-info", (): DesktopRuntimeInfo => {
  if (runtime === null) throw new Error("Runtime is not ready.");
  return {
    apiOrigin: runtime.apiOrigin,
    uiLocale,
    systemLanguages: app.getPreferredSystemLanguages(),
    platform: process.platform,
    productName: PRODUCT_NAME,
    version: app.getVersion(),
  };
});

ipcMain.handle("desktop:create-bootstrap-nonce", async (): Promise<DesktopBootstrapNonce> => {
  if (runtime === null) throw new Error("Runtime is not ready.");
  return runtime.issueDesktopBootstrap();
});

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (mainWindow === null) {
      mainWindow = createMainWindow();
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady()
    .then(async () => {
      const desktopUpdate = await createDesktopUpdater();
      await startRuntime(desktopUpdate);
      mainWindow = createMainWindow();
      createRuntimeTray();
      if (desktopUpdate.status().mode !== "disabled") {
        const check = () => { desktopUpdate.command({ action: "check" }); };
        check();
        const checks = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
        checks.unref();
        app.once("before-quit", () => clearInterval(checks));
      }
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow();
        }
      });
    })
    .catch((_error: unknown) => {
      process.stderr.write(`Failed to start ${PRODUCT_NAME} runtime.\n`);
      app.exit(1);
    });

  app.on("window-all-closed", () => {
    if (isTest) app.quit();
  });

  app.on("before-quit", (event) => {
    isQuitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownPromise !== null) return;
    shutdownPromise = shutdownRuntime();
    void shutdownPromise.then(async () => {
      if (pendingWindowsUpdate !== undefined) {
        try { await launchWindowsUpdate(pendingWindowsUpdate); }
        catch {
          const locale = resolveLocale(uiLocale, app.getPreferredSystemLanguages());
          dialog.showErrorBox(PRODUCT_NAME, translate(locale, "settings.updateInstallFailed"));
          app.relaunch();
        }
      } else if (restartRequested) {
        app.relaunch();
      }
      shutdownComplete = true;
      app.quit();
    }).catch(() => app.exit(1));
  });

  app.on("will-quit", () => {
    if (testUserDataPath !== undefined) {
      try {
        rmSync(testUserDataPath, { force: true, recursive: true });
      } catch {
        // The temporary path can remain locked briefly on Windows; the OS temp cleanup is the fallback.
      }
    }
  });
}
