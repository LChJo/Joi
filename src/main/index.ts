import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentService } from "./application/agents/agent-service.js";
import { AuthService } from "./application/auth/auth-service.js";
import { LifeService } from "./application/lives/life-service.js";
import { RemoteCommandService } from "./application/remote/remote-command-service.js";
import { RemoteHomeQueryService } from "./application/remote/remote-home-queries.js";
import type { RemoteAccessControl } from "./application/ports/remote-access.js";
import type { SsePublisher } from "./application/ports/runtime-store.js";
import { DomainError } from "./domain/errors.js";
import { wirePersistence } from "./composition/wire-persistence.js";
import { wireModelSources } from "./composition/wire-model-sources.js";
import { wirePartners } from "./composition/wire-partners.js";
import { wireWorkbenches } from "./composition/wire-workbenches.js";
import { wireJoi } from "./composition/wire-joi.js";
import { wireRuntime } from "./composition/wire-runtime.js";
import { wireOperations } from "./composition/wire-operations.js";
import { LifeFileDeletionService } from "./infrastructure/artifacts/life-file-deletion-service.js";
import { applyPendingRestore, BackupService } from "./infrastructure/operations/backup-service.js";
import { LocalSkillScanner } from "./infrastructure/skills/local-skill-scanner.js";
import { SystemSettingsService } from "./infrastructure/operations/system-settings-service.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "./infrastructure/persistence/runtime-database.js";
import { emitRuntimeDiagnostic, runtimeDiagnosticErrorCode } from "./application/ports/runtime-diagnostics.js";
import { JsonLineRuntimeDiagnostics } from "./infrastructure/runtime/json-line-runtime-diagnostics.js";
import { FileRemoteAccessStore } from "./infrastructure/remote/file-remote-access-store.js";
import { IrohSidecarTransport } from "./infrastructure/remote/iroh-sidecar-transport.js";
import { RemoteAccessHost } from "./infrastructure/remote/remote-access-host.js";
import { RuntimeMarker, type StartupEvidence } from "./infrastructure/runtime/runtime-marker.js";
import {
  InMemoryBootstrapNonceStore,
  LoginRateLimiter,
  NodeSecurityPrimitives,
} from "./infrastructure/security/security-services.js";
import { ElectronCredentialVault } from "./infrastructure/security/electron-credential-vault.js";
import { createApiHandler } from "./interfaces/http/api-handler.js";
import { startRuntimeListeners, type RuntimeListeners } from "./interfaces/http/runtime-listeners.js";
import { createStaticRendererHandler } from "./interfaces/http/static-renderer-handler.js";
import { createRecoveryModeHandler } from "./interfaces/http/recovery-mode-handler.js";
import { PRODUCT_NAME, type DesktopBootstrapNonce, type DesktopRuntimeInfo } from "../shared/product.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const isTest = process.env.JOI_TEST === "1";
const applicationIconPath = app.isPackaged
  ? path.join(process.resourcesPath, "resources", "branding", "icon.png")
  : path.resolve(currentDirectory, "../../../resources/branding/icon.png");
const testUserDataPath = isTest
  ? path.join(os.tmpdir(), `joi-e2e-${String(process.pid)}-${randomUUID()}`)
  : undefined;

if (testUserDataPath !== undefined) {
  app.setPath("userData", testUserDataPath);
}

// E2E uses an isolated userData directory and must be able to run while a developer instance is open.
const hasSingleInstanceLock = isTest || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let authService: AuthService | null = null;
let runtimeDatabase: RuntimeDatabase | null = null;
let databaseIntegrityMonitor: ReturnType<typeof wireOperations>["integrity"] | null = null;
let runtimeListeners: RuntimeListeners | null = null;
let outboxTimer: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let runtimeMarker: RuntimeMarker | null = null;
let remoteAccessHost: RemoteAccessControl | null = null;
let startupEvidence: StartupEvidence | undefined;
let emergencyStopAll: (() => Promise<void>) | null = null;
let drainRuntime: (() => Promise<void>) | null = null;
let isQuitting = false;
let restartRequested = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

const clock = { now: () => new Date() };
const ids = { next: (prefix: string) => `${prefix}_${randomUUID()}` };
async function startRuntime(): Promise<void> {
  const userDataDirectory = app.getPath("userData");
  const runtimeDiagnostics = new JsonLineRuntimeDiagnostics({
    clock,
    directory: path.join(userDataDirectory, "diagnostics"),
  });
  runtimeMarker = new RuntimeMarker(userDataDirectory);
  startupEvidence = await runtimeMarker.start(clock.now());
  const migrationsDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "resources", "migrations")
    : path.resolve("resources/migrations");
  await applyPendingRestore(userDataDirectory, migrationsDirectory);
  const settings = new SystemSettingsService({
    getLaunchAtLogin: () => app.getLoginItemSettings().openAtLogin,
    getLanRuntimeState: () => runtimeListeners?.lanState(),
    reconfigureLan: async (target) => {
      if (runtimeListeners === null) {
        return target === undefined
          ? { status: "disabled" as const }
          : { status: "blocked" as const, reasonCode: "lan_runtime_unavailable", message: "LAN 监听器尚未就绪。" };
      }
      return runtimeListeners.reconfigureLan(target);
    },
    setLaunchAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
    settingsPath: path.join(userDataDirectory, "settings.json"),
    validateJoiSkills: (refs) => new LocalSkillScanner().validateRefs("pi-core", refs),
  });
  const runtimeSettings = await settings.get();
  const databasePath = path.join(userDataDirectory, "runtime.sqlite");
  const database = await openRuntimeDatabase({
    databasePath,
    migrationsDirectory,
  });
  if (database.inspect().mode === "read-only-recovery") {
    const recoveryBackups = new BackupService({
      appVersion: app.getVersion(),
      artifactsDirectory: path.join(userDataDirectory, "artifacts"),
      backupsDirectory: path.join(userDataDirectory, "backups"),
      clock,
      database,
      migrationsDirectory,
      userDataDirectory,
    });
    runtimeListeners = await startRuntimeListeners({
      handler: createRecoveryModeHandler({ backups: recoveryBackups, requestRestart: () => requestApplicationRestart() }),
      loopbackPort: isTest ? 0 : 43_130,
    });
    runtimeDatabase = database;
    return;
  }
  // SSE transport retired (ADR 0009): publishers are no-ops; actors converge state by traversal.
  const noOpPublisher: SsePublisher = { publish: () => undefined };
  const auth = new AuthService({
    clock,
    nonces: new InMemoryBootstrapNonceStore(),
    rateLimiter: new LoginRateLimiter(clock),
    security: new NodeSecurityPrimitives(),
    store: database.store,
  });
  const vault = new ElectronCredentialVault();
  const pid = String(process.pid);
  const persistence = wirePersistence({ clock, database, pid, userDataDirectory,
    runDirectory: path.join(isTest ? userDataDirectory : app.getPath("home"), "joi", "runs"),
  });
  const modelSourceStack = wireModelSources({ clock, ids, persistence, vault });
  const partnerStack = wirePartners({ clock, diagnostics: runtimeDiagnostics, ids, modelSourceStack, persistence });
  const workbenchStack = wireWorkbenches({
    artifactOpener: {
      open: async (input) => {
        try {
          if (input.mode === "REVEAL") {
            shell.showItemInFolder(input.targetPath);
            return;
          }
          const failure = await shell.openPath(input.targetPath);
          if (failure !== "") throw new Error("shell_open_failed");
        } catch {
          throw new DomainError("workbench_artifact_open_failed", "The artifact could not be opened.");
        }
      },
    },
    clock, diagnostics: runtimeDiagnostics, ids, partnerStack, persistence,
  });
  const directoryPicker = async () => {
    try {
      const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "绑定 Workbench 工作目录" });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    } catch {
      return null;
    }
  };
  const joiStack = wireJoi({
    settings,
    clock,
    database,
    directoryPicker,
    diagnostics: runtimeDiagnostics,
    ids,
    modelSourceStack,
    partnerStack,
    persistence,
    userDataDirectory,
    workbenchStack,
  });
  const runtimeStack = wireRuntime({
    clock,
    database,
    diagnostics: runtimeDiagnostics,
    ids,
    joiStack,
    modelSourceStack,
    partnerStack,
    persistence,
    publisher: noOpPublisher,
    userDataDirectory,
    vault,
    workbenchStack,
  });
  drainRuntime = runtimeStack.drain;
  await partnerStack.partnerInstances.recoverOnBoot();
  await runtimeStack.outboxDispatcher.dispatchOnce();
  await runtimeStack.actorTree.tick(clock.now());
  const remoteAccess = new RemoteAccessHost({
    clock,
    diagnostics: runtimeDiagnostics,
    commands: new RemoteCommandService({ homeFeed: workbenchStack.joiHomeFeed, inbox: joiStack.joiInbox, workbenchRegistry: workbenchStack.workbenchRegistry,
      queries: new RemoteHomeQueryService({ homeFeed: workbenchStack.joiHomeFeed, inputs: persistence.joiInboxRepository,
        agents: workbenchStack.workbenchAgents, workbenches: persistence.workbenches, partners: partnerStack.partners }),
    }),
    store: new FileRemoteAccessStore(path.join(userDataDirectory, "remote-access.json")),
    transport: new IrohSidecarTransport(app.isPackaged
      ? path.join(process.resourcesPath, "resources", "native", process.platform, `joi-remote-sidecar${process.platform === "win32" ? ".exe" : ""}`)
      : path.resolve("native", "joi-remote", "target", "release", `joi-remote-sidecar${process.platform === "win32" ? ".exe" : ""}`)),
    vault,
  });
  await remoteAccess.start();
  remoteAccessHost = remoteAccess;
  const lives = new LifeService({
    clock,
    files: new LifeFileDeletionService({ ids, rootDirectory: path.join(userDataDirectory, "artifacts"), store: database.store }),
    ids,
    publisher: noOpPublisher,
    store: database.store,
  });
  const backup = new BackupService({
    appVersion: app.getVersion(),
    artifactsDirectory: path.join(userDataDirectory, "artifacts"),
    backupsDirectory: path.join(userDataDirectory, "backups"),
    clock,
    database,
    migrationsDirectory,
    userDataDirectory,
  });
  const operationsBundle = wireOperations({
    backup,
    clock,
    databasePath,
    startup: startupEvidence,
    store: database.store,
    webHealth: () => {
      const lanState = runtimeListeners?.lanState();
      return {
        ...(runtimeListeners?.lan === undefined || lanState === undefined ? {} : {
          lan: lanState.status === "listening"
            ? { status: "listening", ...(lanState.pending === undefined ? {} : { code: lanState.pending.reasonCode }) }
            : { status: "error", code: lanState.status === "blocked" ? lanState.reasonCode : "lan_disabled" },
        }),
        ...(runtimeListeners?.loopback === undefined ? {} : { loopback: { status: runtimeListeners.loopback.status } }),
      };
    },
  });
  const { integrity, operations } = operationsBundle;
  databaseIntegrityMonitor = integrity;
  const dependencies = {
    a2aGateway: runtimeStack.a2aGateway,
    agentOnboarding: runtimeStack.agentOnboarding,
    automation: joiStack.automation,
    agents: new AgentService({ clock, ids, store: database.store }),
    artifacts: runtimeStack.artifactStorage,
    auth,
    workbenchChanges: workbenchStack.workbenchChanges,
    workbenchManagement: workbenchStack.workbenchManagement,
    workbenchAgents: workbenchStack.workbenchAgents,
    workbenchRegistry: workbenchStack.workbenchRegistry,
    workbenchWorkspaces: workbenchStack.workbenchWorkspaces,
    workbenches: persistence.workbenches,
    continuity: runtimeStack.continuity,
    events: runtimeStack.events,
    globalEmergencyStop: async () => { await emergencyStopAll?.(); },
    engines: partnerStack.engineCatalog,
    instances: partnerStack.partnerInstances,
    interactions: runtimeStack.interactions,
    joiActivity: persistence.joiInboxRepository,
    joiHomeFeed: workbenchStack.joiHomeFeed,
    resultExports: runtimeStack.resultExports,
    joiAttachments: joiStack.joiAttachmentStorage,
    joiInbox: joiStack.joiInbox,
    evolution: joiStack.evolution,
    evolutionDryRun: joiStack.evolutionDryRun,
    statistics: modelSourceStack.statistics,
    knowledge: partnerStack.partnerKnowledge,
    partnerModelProbe: partnerStack.partnerModelProbe,
    lives,
    memory: partnerStack.partnerMemory,
    directoryPicker,
    skills: partnerStack.partnerSkillCatalog,
    modelSources: modelSourceStack.modelSources,
    operations,
    partners: partnerStack.partners,
    scenarioPacks: partnerStack.scenarioPacks,
    requestRestart: () => requestApplicationRestart(),
    remoteAccess,
    settings,
    work: workbenchStack.workRepository,
  };
  emergencyStopAll = async () => {
    joiStack.evolution.emergencyStop();
    await joiStack.joiInbox.emergencyStopQueued();
    let after: { createdAt: string; lifeId: string } | undefined;
    do {
      const page = await lives.list({ ...(after === undefined ? {} : { after }), limit: 100 });
      for (const life of page.items) {
        runtimeStack.legacyRunControl.emergencyStop(life.lifeId);
        await runtimeStack.lifeRuntime.emergencyStop(life.lifeId);
      }
      after = page.next;
    } while (after !== undefined);
  };

  try {
    const listeners = await startRuntimeListeners({
      handler: createStaticRendererHandler(
        createApiHandler(dependencies),
        path.resolve(currentDirectory, "../../renderer"),
      ),
      ...(runtimeSettings.lan.enabled ? { lan: { address: runtimeSettings.lan.address, port: runtimeSettings.lan.port } } : {}),
      loopbackPort: isTest ? 0 : 43_130,
    });
    authService = auth;
    runtimeDatabase = database;
    runtimeListeners = listeners;
    integrity.start();
    let rootTickInFlight: Promise<void> | null = null;
    outboxTimer = setInterval(() => {
      if (rootTickInFlight !== null) return;
      const pass = (async () => {
        await runtimeStack.actorTree.tick(clock.now());
        await runtimeStack.outboxDispatcher.dispatchOnce();
      })();
      rootTickInFlight = pass;
      void pass
        .catch((error: unknown) => {
          // Keep the error object: a bare message here was the blind spot that hid every
          // uncaught failure in the whole tick chain.
          const errorCode = runtimeDiagnosticErrorCode(error);
          emitRuntimeDiagnostic(runtimeDiagnostics, "joi.runtime.tick_failed", { errorCode });
          process.stderr.write(`Runtime background dispatch cycle failed (${errorCode}).\n`);
        })
        .finally(() => {
          if (rootTickInFlight === pass) rootTickInFlight = null;
        });
    }, 2_000);
    outboxTimer.unref();
  } catch (error) {
    integrity.close();
    databaseIntegrityMonitor = null;
    database.close();
    throw error;
  }
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

  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl !== undefined) {
    void window.loadURL(developmentUrl);
  } else {
    if (runtimeListeners === null) throw new Error("Runtime listener is not ready.");
    void window.loadURL(runtimeListeners.loopback.url);
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

function rebuildTrayMenu() {
  if (tray === null) return;
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { click: showMainWindow, label: "打开 joi" },
    { type: "separator" },
    { click: () => void emergencyStopAll?.(), label: "紧急停止全部智能体" },
    {
      checked: launchAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); rebuildTrayMenu(); },
      label: "开机时启动",
      type: "checkbox",
    },
    { type: "separator" },
    { click: requestApplicationQuit, label: "退出 joi" },
  ]));
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
  if (outboxTimer !== null) {
    clearInterval(outboxTimer);
    outboxTimer = null;
  }
  const listeners = runtimeListeners;
  runtimeListeners = null;
  if (listeners !== null) await listeners.close();
  await remoteAccessHost?.close();
  remoteAccessHost = null;
  await drainRuntime?.();
  drainRuntime = null;
  databaseIntegrityMonitor?.close();
  databaseIntegrityMonitor = null;
  runtimeDatabase?.close();
  runtimeDatabase = null;
  authService = null;
  emergencyStopAll = null;
  tray?.destroy();
  tray = null;
  await runtimeMarker?.clean();
  runtimeMarker = null;
}

ipcMain.handle("desktop:runtime-info", (): DesktopRuntimeInfo => {
  if (runtimeListeners === null) throw new Error("Runtime is not ready.");
  return {
    apiOrigin: runtimeListeners.loopback.url,
    platform: process.platform,
    productName: PRODUCT_NAME,
    version: app.getVersion(),
  };
});

ipcMain.handle("desktop:create-bootstrap-nonce", async (): Promise<DesktopBootstrapNonce> => {
  if (authService === null) throw new Error("Runtime is not ready.");
  return authService.issueDesktopBootstrap();
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
      await startRuntime();
      mainWindow = createMainWindow();
      createRuntimeTray();
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
    shutdownPromise ??= shutdownRuntime();
    void shutdownPromise.then(() => {
      shutdownComplete = true;
      if (restartRequested) app.relaunch();
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
