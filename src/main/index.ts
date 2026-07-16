import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AgentService } from "./application/agents/agent-service.js";
import { DelegationService } from "./application/agents/delegation-service.js";
import { InteractionService } from "./application/agents/interaction-service.js";
import { AgentOnboardingService } from "./application/agents/agent-onboarding-service.js";
import { A2aGatewayService } from "./application/a2a/a2a-gateway-service.js";
import { AuthService } from "./application/auth/auth-service.js";
import { ContinuityService } from "./application/continuity/continuity-service.js";
import { EventService } from "./application/events/event-service.js";
import { LifeRuntimeService } from "./application/lives/life-runtime-service.js";
import { LifeService } from "./application/lives/life-service.js";
import { OperationsService } from "./application/operations/operations-service.js";
import { applyPendingRestore, BackupService } from "./infrastructure/operations/backup-service.js";
import { SystemSettingsService } from "./infrastructure/operations/system-settings-service.js";
import { RuntimeMarker, type StartupEvidence } from "./infrastructure/runtime/runtime-marker.js";
import { OutboxDispatcher } from "./application/operations/outbox-dispatcher.js";
import { SseService } from "./application/sse/sse-service.js";
import { ArtifactService } from "./infrastructure/artifacts/artifact-service.js";
import { LifeFileDeletionService } from "./infrastructure/artifacts/life-file-deletion-service.js";
import { AttachmentService } from "./infrastructure/artifacts/user-attachment-service.js";
import { AlarmScheduler } from "./application/rhythm/alarm-scheduler.js";
import { ScheduleScheduler } from "./application/rhythm/schedule-scheduler.js";
import { BudgetService } from "./application/rhythm/budget-service.js";
import { IdleExplorationScheduler } from "./application/rhythm/idle-exploration-scheduler.js";
import { ExpressionDeliveryScheduler } from "./application/rhythm/expression-delivery-scheduler.js";
import { TodoScheduler } from "./application/rhythm/todo-scheduler.js";
import { ActionProcessor } from "./application/wakes/action-processor.js";
import { WakeArbiter } from "./application/wakes/wake-arbiter.js";
import { WakeAuditService } from "./application/wakes/wake-audit-service.js";
import { WakeContextAssembler } from "./application/wakes/wake-context-assembler.js";
import { WakeCoordinator } from "./application/wakes/wake-coordinator.js";
import { WakeRepairService } from "./application/wakes/wake-repair-service.js";
import { WakeRecoveryService } from "./application/wakes/wake-recovery-service.js";
import { WakeRunner } from "./application/wakes/wake-runner.js";
import { InMemorySseBroker } from "./infrastructure/http/in-memory-sse-broker.js";
import { A2aAgentDiscovery } from "./infrastructure/a2a/a2a-agent-discovery.js";
import { OutboundNetworkPolicy } from "./infrastructure/a2a/outbound-network-policy.js";
import { SdkA2aInvocationTransport } from "./infrastructure/a2a/sdk-a2a-invocation-transport.js";
import { SecureArtifactDownloader } from "./infrastructure/a2a/secure-artifact-downloader.js";
import { A2aWakeAgentExecutor } from "./infrastructure/a2a/a2a-wake-agent-executor.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "./infrastructure/persistence/runtime-database.js";
import { InMemoryEventSignal } from "./infrastructure/runtime/in-memory-event-signal.js";
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
  ? path.join(os.tmpdir(), `joi-e2e-${String(process.pid)}`)
  : undefined;

if (testUserDataPath !== undefined) {
  app.setPath("userData", testUserDataPath);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let authService: AuthService | null = null;
let runtimeDatabase: RuntimeDatabase | null = null;
let runtimeListeners: RuntimeListeners | null = null;
let outboxTimer: NodeJS.Timeout | null = null;
let tray: Tray | null = null;
let runtimeMarker: RuntimeMarker | null = null;
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
  runtimeMarker = new RuntimeMarker(userDataDirectory);
  startupEvidence = await runtimeMarker.start(clock.now());
  const migrationsDirectory = app.isPackaged
    ? path.join(process.resourcesPath, "resources", "migrations")
    : path.resolve("resources/migrations");
  await applyPendingRestore(userDataDirectory, migrationsDirectory);
  const settings = new SystemSettingsService({
    getLaunchAtLogin: () => app.getLoginItemSettings().openAtLogin,
    setLaunchAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
    settingsPath: path.join(userDataDirectory, "settings.json"),
  });
  const runtimeSettings = await settings.get();
  const database = await openRuntimeDatabase({
    databasePath: path.join(userDataDirectory, "runtime.sqlite"),
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
  const broker = new InMemorySseBroker();
  const sse = new SseService({ broker, clock, store: database.store });
  const auth = new AuthService({
    clock,
    nonces: new InMemoryBootstrapNonceStore(),
    rateLimiter: new LoginRateLimiter(clock),
    security: new NodeSecurityPrimitives(),
    store: database.store,
  });
  const policy = new OutboundNetworkPolicy({
    resolve: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((record) => record.address),
  });
  const vault = new ElectronCredentialVault();
  const artifactStorage = new ArtifactService({ rootDirectory: path.join(userDataDirectory, "artifacts"), store: database.store });
  const attachmentStorage = new AttachmentService({
    clock,
    ids,
    rootDirectory: path.join(userDataDirectory, "artifacts"),
    store: database.store,
  });
  const agentOnboarding = new AgentOnboardingService({
    clock,
    discovery: new A2aAgentDiscovery({ policy }),
    ids,
    store: database.store,
    vault,
  });
  const a2aGateway = new A2aGatewayService({
    artifactDownloader: new SecureArtifactDownloader({
      policy,
      rootDirectory: path.join(userDataDirectory, "artifacts"),
    }),
    clock,
    ids,
    store: database.store,
    transport: new SdkA2aInvocationTransport({ policy }),
    vault,
  });
  const recoveredWakeIds = await new WakeRecoveryService({ clock, publisher: sse, store: database.store }).recover();
  const eventSignal = new InMemoryEventSignal();
  const events = new EventService({ clock, ids, publisher: sse, signal: eventSignal, store: database.store });
  const lifeRuntime = new LifeRuntimeService({ clock, events, store: database.store });
  const wakeRunner = new WakeRunner({
    actions: new ActionProcessor({ clock, publisher: sse, store: database.store }),
    arbiter: new WakeArbiter({ clock, ids, publisher: sse, store: database.store }),
    audit: new WakeAuditService({ clock, ids, store: database.store }),
    clock,
    context: new WakeContextAssembler({ clock, store: database.store }),
    executor: new A2aWakeAgentExecutor(a2aGateway, database.store, async ({ affairId, artifact, lifeId }) => {
      await events.ingest({
        ...(affairId === undefined ? {} : { affairId }),
        dedupeKey: artifact.artifactId,
        lifeId,
        payload: {
          agentConnectionId: (await database.store.getLife(lifeId))?.mainAgentConnectionId ?? "unknown",
          artifactId: artifact.artifactId,
          filename: artifact.filename,
          invocationId: artifact.invocationId,
          mimeType: artifact.mimeType,
          sha256: artifact.sha256,
          size: artifact.size,
        },
        source: "agent",
        type: "agent.artifact_created",
      });
    }, attachmentStorage),
    ids,
    repair: new WakeRepairService({ clock, ids, publisher: sse, store: database.store }),
    store: database.store,
  });
  const wakeCoordinator = new WakeCoordinator({
    canRun: async () => {
      const disk = await statfs(userDataDirectory);
      return disk.bavail * disk.bsize >= 256 * 1024 * 1024;
    },
    leaseOwner: `runtime_${String(process.pid)}`,
    onError: () => process.stderr.write("A joi Wake ended with an error.\n"),
    runner: wakeRunner,
  });
  const delegations = new DelegationService({
    artifacts: artifactStorage,
    clock,
    events,
    gateway: a2aGateway,
    notify: (lifeId) => wakeCoordinator.notify(lifeId),
    store: database.store,
  });
  const interactions = new InteractionService({ events, gateway: a2aGateway, notify: (lifeId) => wakeCoordinator.notify(lifeId), store: database.store });
  const budgets = new BudgetService({
    clock,
    events,
    notify: (lifeId) => wakeCoordinator.notify(lifeId),
    store: database.store,
  });
  const idleExploration = new IdleExplorationScheduler({
    clock,
    events,
    notify: (lifeId) => wakeCoordinator.notify(lifeId),
    store: database.store,
  });
  const alarmScheduler = new AlarmScheduler({
    clock,
    ids,
    notify: (lifeId) => wakeCoordinator.notify(lifeId),
    publisher: sse,
    store: database.store,
  });
  const scheduleScheduler = new ScheduleScheduler({
    clock,
    ids,
    notify: (lifeId) => wakeCoordinator.notify(lifeId),
    publisher: sse,
    store: database.store,
  });
  const todoScheduler = new TodoScheduler({
    clock,
    ids,
    notify: (lifeId) => wakeCoordinator.notify(lifeId),
    publisher: sse,
    store: database.store,
  });
  const expressionDelivery = new ExpressionDeliveryScheduler({ clock, publisher: sse, store: database.store });
  const outboxDispatcher = new OutboxDispatcher({
    clock,
    handlers: {
      "a2a.send": async (record) => {
        const invocationId = record.payload.invocationId;
        if (typeof invocationId !== "string") throw new Error("A2A outbox record is missing invocationId.");
        const invocation = await a2aGateway.recover(invocationId);
        if (invocation.status === "WAITING_RETRY" || invocation.status === "SENT_NO_ACCEPT") {
          throw new Error("A2A invocation is waiting for retry.");
        }
      },
      "delegation.send": async (record) => {
        const delegationId = record.payload.delegationId;
        if (typeof delegationId !== "string") throw new Error("Delegation outbox record is missing delegationId.");
        await delegations.dispatch(delegationId);
      },
      "interaction.answer": async (record) => {
        const interactionId = record.payload.interactionId;
        const answer = record.payload.answer;
        if (typeof interactionId !== "string" || typeof answer !== "string") throw new Error("Interaction outbox record is invalid.");
        await interactions.answer(interactionId, answer);
      },
    },
    onError: () => process.stderr.write("An outbox delivery will be retried.\n"),
    owner: `outbox_${String(process.pid)}`,
    store: database.store,
  });
  drainRuntime = async () => {
    await wakeCoordinator.shutdown(10_000);
    for (let batch = 0; batch < 10; batch += 1) {
      if (await outboxDispatcher.dispatchOnce(100) === 0) break;
    }
  };
  await outboxDispatcher.dispatchOnce();
  await alarmScheduler.tick();
  await scheduleScheduler.tick();
  await todoScheduler.tick();
  await expressionDelivery.tick();
  await budgets.tick();
  await idleExploration.tick();
  for (const wakeId of recoveredWakeIds) {
    const wake = await database.store.getWake(wakeId);
    if (wake !== null) wakeCoordinator.notify(wake.lifeId);
  }
  const lives = new LifeService({
    clock,
    files: new LifeFileDeletionService({ ids, rootDirectory: path.join(userDataDirectory, "artifacts"), store: database.store }),
    ids,
    publisher: sse,
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
  const operations = new OperationsService({
    backup,
    clock,
    startup: startupEvidence,
    store: database.store,
    webHealth: () => ({
      ...(runtimeListeners?.lan === undefined ? {} : { lan: runtimeListeners.lan }),
      ...(runtimeListeners?.loopback === undefined ? {} : { loopback: { status: runtimeListeners.loopback.status } }),
    }),
  });
  const dependencies = {
    a2aGateway,
    agentOnboarding,
    agents: new AgentService({ clock, ids, store: database.store }),
    attachments: attachmentStorage,
    artifacts: artifactStorage,
    auth,
    budgets,
    continuity: new ContinuityService({ clock, publisher: sse, store: database.store }),
    events,
    globalEmergencyStop: async () => { await emergencyStopAll?.(); },
    interactions,
    lifeRuntime,
    lives,
    operations,
    requestRestart: () => requestApplicationRestart(),
    settings,
    sse,
    wakeCoordinator,
  };
  emergencyStopAll = async () => {
    let after: { createdAt: string; lifeId: string } | undefined;
    do {
      const page = await lives.list({ ...(after === undefined ? {} : { after }), limit: 100 });
      for (const life of page.items) {
        wakeCoordinator.emergencyStop(life.lifeId);
        await lifeRuntime.emergencyStop(life.lifeId);
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
    outboxTimer = setInterval(() => {
      void Promise.all([
        outboxDispatcher.dispatchOnce(), alarmScheduler.tick(), scheduleScheduler.tick(), todoScheduler.tick(),
        expressionDelivery.tick(), budgets.tick(), idleExploration.tick(),
      ])
        .catch(() => process.stderr.write("Runtime background dispatch cycle failed.\n"));
    }, 2_000);
    outboxTimer.unref();
  } catch (error) {
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
    { click: () => void emergencyStopAll?.(), label: "紧急停止全部生命" },
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
  await drainRuntime?.();
  drainRuntime = null;
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
