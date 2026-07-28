import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { rmSync } from "node:fs";
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
import { ModelSourceService } from "./application/model-sources/model-source-service.js";
import { ReasoningSourceSelector } from "./application/model-sources/reasoning-source-selector.js";
import { JoiInboxService } from "./application/joi/joi-inbox-service.js";
import { JoiCoordinator } from "./application/joi/joi-coordinator.js";
import { JoiInputScheduler } from "./application/joi/joi-input-scheduler.js";
import { AvatarRegistryService } from "./application/joi/avatar-registry-service.js";
import { PartnerRegistryService } from "./application/partners/partner-registry-service.js";
import { WorkOrchestrationService } from "./application/work/work-orchestration-service.js";
import { applyPendingRestore, BackupService } from "./infrastructure/operations/backup-service.js";
import { SystemSettingsService } from "./infrastructure/operations/system-settings-service.js";
import { RuntimeMarker, type StartupEvidence } from "./infrastructure/runtime/runtime-marker.js";
import { OutboxDispatcher } from "./application/operations/outbox-dispatcher.js";
import { SseService } from "./application/sse/sse-service.js";
import { ArtifactService } from "./infrastructure/artifacts/artifact-service.js";
import { LifeFileDeletionService } from "./infrastructure/artifacts/life-file-deletion-service.js";
import { AttachmentService } from "./infrastructure/artifacts/user-attachment-service.js";
import { JoiAttachmentService } from "./infrastructure/artifacts/joi-attachment-service.js";
import { AlarmScheduler } from "./application/rhythm/alarm-scheduler.js";
import { ScheduleScheduler } from "./application/rhythm/schedule-scheduler.js";
import { BudgetService } from "./application/rhythm/budget-service.js";
import { IdleExplorationScheduler } from "./application/rhythm/idle-exploration-scheduler.js";
import { ExpressionDeliveryScheduler } from "./application/rhythm/expression-delivery-scheduler.js";
import { TodoScheduler } from "./application/rhythm/todo-scheduler.js";
import { InMemorySseBroker } from "./infrastructure/http/in-memory-sse-broker.js";
import { A2aAgentDiscovery } from "./infrastructure/a2a/a2a-agent-discovery.js";
import { OutboundNetworkPolicy } from "./infrastructure/a2a/outbound-network-policy.js";
import { SdkA2aInvocationTransport } from "./infrastructure/a2a/sdk-a2a-invocation-transport.js";
import { SecureArtifactDownloader } from "./infrastructure/a2a/secure-artifact-downloader.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "./infrastructure/persistence/runtime-database.js";
import { SqliteModelSourceRepository } from "./infrastructure/persistence/sqlite-model-source-repository.js";
import { SqlitePiCredentialRepository } from "./infrastructure/persistence/sqlite-pi-credential-repository.js";
import { SqliteJoiInboxRepository } from "./infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqlitePartnerRegistryRepository } from "./infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqlitePiReasoningSessionStore } from "./infrastructure/persistence/sqlite-pi-reasoning-session-store.js";
import { SqliteWorkPlanRepository } from "./infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqliteDispatchPolicyGate } from "./infrastructure/persistence/sqlite-dispatch-policy-gate.js";
import { SqliteWorkspaceLeaseManager } from "./infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { SqlitePartnerPromptStore } from "./infrastructure/persistence/sqlite-partner-prompt-store.js";
import { LegacyLifeStoreAdapter } from "./infrastructure/persistence/legacy-life-store-adapter.js";
import { ModelSourceNetworkPolicy } from "./infrastructure/pi/model-source-network-policy.js";
import { PiModelSourceCatalog } from "./infrastructure/pi/pi-model-source-catalog.js";
import { PiModelSourceValidator } from "./infrastructure/pi/pi-model-source-validator.js";
import { SafeStoragePiCredentialStore } from "./infrastructure/pi/pi-credential-store-adapter.js";
import { ConfiguredPiReasoningRuntime } from "./infrastructure/pi/configured-pi-reasoning-runtime.js";
import { PiAvatarRoutingRuntime } from "./infrastructure/pi/pi-avatar-routing-runtime.js";
import { RepositoryPiConfiguredModelResolver } from "./infrastructure/pi/pi-configured-model-resolver.js";
import { createJoiReasoningTools } from "./infrastructure/pi/joi-reasoning-tools.js";
import { SqliteA2aPartnerDispatchHandler } from "./infrastructure/a2a/sqlite-partner-dispatch-handler.js";
import { LocalPiPartnerAdapter } from "./infrastructure/pi/local-pi-partner-adapter.js";
import { PiCodingPartnerRunner } from "./infrastructure/pi/pi-coding-partner-runner.js";
import { BuiltinPiCodingToolFactory } from "./infrastructure/pi/pi-coding-tool-factory.js";
import { PiReasoningFailureClassifier } from "./infrastructure/pi/pi-reasoning-failure-classifier.js";
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
  const orchestrationEvents = {
    emit: async (type: string, entityId: string, payload: Record<string, unknown>): Promise<void> => {
      const event = await database.store.appendSseEvent({ entityId, payload, type });
      await Promise.resolve(sse.publish(event));
    },
  };
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
  const modelSourceNetworkPolicy = new ModelSourceNetworkPolicy({
    resolve: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((record) => record.address),
  });
  const piCredentials = new SafeStoragePiCredentialStore({
    records: new SqlitePiCredentialRepository(database),
    vault,
  });
  const modelSourceRepository = new SqliteModelSourceRepository(database);
  const modelSources = new ModelSourceService({
    catalog: new PiModelSourceCatalog(),
    clock,
    endpointPolicy: modelSourceNetworkPolicy,
    ids,
    repository: modelSourceRepository,
    secrets: piCredentials,
    validator: new PiModelSourceValidator({ clock, credentials: piCredentials }),
  });
  const joiInboxRepository = new SqliteJoiInboxRepository(database);
  const joiInbox = new JoiInboxService({
    clock,
    ids,
    repository: joiInboxRepository,
  });
  const partnerRepository = new SqlitePartnerRegistryRepository(database);
  const partnerPrompts = new SqlitePartnerPromptStore(database);
  const partners = new PartnerRegistryService({
    clock,
    events: orchestrationEvents,
    ids,
    prompts: partnerPrompts,
    repository: partnerRepository,
  });
  const avatars = new LegacyLifeStoreAdapter(database);
  const avatarRegistry = new AvatarRegistryService({ clock, ids, repository: avatars });
  const workRepository = new SqliteWorkPlanRepository(database);
  const work = new WorkOrchestrationService({
    clock,
    events: orchestrationEvents,
    ids,
    partners,
    policy: new SqliteDispatchPolicyGate({ clock, database }),
    reassignment: workRepository,
    repository: workRepository,
  });
  const reasoningSources = new ReasoningSourceSelector(modelSourceRepository);
  const configuredModelResolver = new RepositoryPiConfiguredModelResolver({
    credentials: piCredentials,
    repository: modelSourceRepository,
  });
  const joiReasoning = new ConfiguredPiReasoningRuntime({
    resolver: configuredModelResolver,
    sessionStore: new SqlitePiReasoningSessionStore(database),
    tools: (turn) => createJoiReasoningTools({ avatarId: turn.avatarId, avatars, partners, turnId: turn.turnId, work }),
  });
  const joiCoordinator = new JoiCoordinator({
    avatars,
    avatarRegistry,
    clock,
    failureClassifier: new PiReasoningFailureClassifier(),
    ids,
    events: orchestrationEvents,
    router: new PiAvatarRoutingRuntime({ resolver: configuredModelResolver, sources: reasoningSources }),
    runtime: joiReasoning,
    sources: reasoningSources,
    store: joiInboxRepository,
  });
  const joiInputScheduler = new JoiInputScheduler({
    handle: (inputId) => joiCoordinator.handle(inputId),
    onError: () => process.stderr.write("A joi input remains available for recovery.\n"),
  });
  const processJoiInput = (inputId: string): void => joiInputScheduler.notify(inputId);
  const processPendingJoiInputs = (): void => {
    void joiInboxRepository.list()
      .then((records) => records.filter((record) => record.status === "PENDING").forEach((record) => processJoiInput(record.inputId)))
      .catch(() => process.stderr.write("Pending joi inputs remain available for recovery.\n"));
  };
  const artifactStorage = new ArtifactService({ rootDirectory: path.join(userDataDirectory, "artifacts"), store: database.store });
  const attachmentStorage = new AttachmentService({
    clock,
    ids,
    rootDirectory: path.join(userDataDirectory, "artifacts"),
    store: database.store,
  });
  const joiAttachmentStorage = new JoiAttachmentService({
    clock,
    database,
    ids,
    rootDirectory: path.join(userDataDirectory, "artifacts"),
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
  const eventSignal = new InMemoryEventSignal();
  const events = new EventService({ clock, ids, publisher: sse, signal: eventSignal, store: database.store });
  const lifeRuntime = new LifeRuntimeService({ clock, events, store: database.store });
  const notifyJoi = (avatarId: string, type: string): void => {
    const signalId = ids.next("runtime_signal");
    void joiInboxRepository.enqueueSystemSignal({ avatarId, signalId, type })
      .then(processJoiInput)
      .catch(() => process.stderr.write("A runtime signal remains available for recovery.\n"));
  };
  const legacyRunControl = {
    emergencyStop: (avatarId: string): void => { void lifeRuntime.emergencyStop(avatarId); },
    notify: (avatarId: string): void => notifyJoi(avatarId, "legacy.user_requested"),
  };
  const delegations = new DelegationService({
    artifacts: artifactStorage,
    clock,
    events,
    gateway: a2aGateway,
    notify: (avatarId) => notifyJoi(avatarId, "partner.delegation_changed"),
    store: database.store,
  });
  const interactions = new InteractionService({ events, gateway: a2aGateway, notify: (avatarId) => notifyJoi(avatarId, "partner.interaction_changed"), store: database.store });
  const budgets = new BudgetService({
    clock,
    events,
    notify: (avatarId) => notifyJoi(avatarId, "budget.changed"),
    store: database.store,
  });
  const idleExploration = new IdleExplorationScheduler({
    clock,
    events,
    notify: (avatarId) => notifyJoi(avatarId, "idle.exploration_due"),
    store: database.store,
  });
  const alarmScheduler = new AlarmScheduler({
    clock,
    ids,
    notify: (avatarId) => notifyJoi(avatarId, "schedule.alarm_due"),
    publisher: sse,
    store: database.store,
  });
  const scheduleScheduler = new ScheduleScheduler({
    clock,
    ids,
    notify: (avatarId) => notifyJoi(avatarId, "schedule.rhythm_due"),
    publisher: sse,
    store: database.store,
  });
  const todoScheduler = new TodoScheduler({
    clock,
    ids,
    notify: (avatarId) => notifyJoi(avatarId, "todo.due"),
    publisher: sse,
    store: database.store,
  });
  const expressionDelivery = new ExpressionDeliveryScheduler({ clock, publisher: sse, store: database.store });
  const workspaceLeases = new SqliteWorkspaceLeaseManager({ clock, database, owner: `partner_${String(process.pid)}` });
  const localPartner = new LocalPiPartnerAdapter(new PiCodingPartnerRunner({
    prompts: partnerPrompts,
    resolver: configuredModelResolver,
    sources: reasoningSources,
    tools: new BuiltinPiCodingToolFactory(),
  }));
  const partnerDispatch = new SqliteA2aPartnerDispatchHandler({
    clock,
    database,
    gateway: a2aGateway,
    leases: workspaceLeases,
    local: localPartner,
    onResult: async (event) => {
      await orchestrationEvents.emit("work.partner_result", event.eventId, event);
      const inputId = await joiInboxRepository.enqueuePartnerResult(event);
      processJoiInput(inputId);
    },
    partners: partnerRepository,
  });
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
      "partner.dispatch": (record) => partnerDispatch.handle(record),
    },
    onError: () => process.stderr.write("An outbox delivery will be retried.\n"),
    owner: `outbox_${String(process.pid)}`,
    store: database.store,
  });
  drainRuntime = async () => {
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
    avatarRegistry,
    avatars,
    budgets,
    continuity: new ContinuityService({ clock, publisher: sse, store: database.store }),
    events,
    globalEmergencyStop: async () => { await emergencyStopAll?.(); },
    interactions,
    joiActivity: joiInboxRepository,
    joiAttachments: joiAttachmentStorage,
    joiInbox,
    lifeRuntime,
    lives,
    modelSources,
    onJoiMessageAccepted: (inputId: string) => {
      void orchestrationEvents.emit("joi.message.accepted", inputId, { inputId })
        .catch(() => process.stderr.write("A joi status update remains available for replay.\n"));
      processJoiInput(inputId);
    },
    onModelSourceReady: processPendingJoiInputs,
    operations,
    partners,
    requestRestart: () => requestApplicationRestart(),
    settings,
    sse,
    wakeCoordinator: legacyRunControl,
    work: workRepository,
  };
  processPendingJoiInputs();
  emergencyStopAll = async () => {
    let after: { createdAt: string; lifeId: string } | undefined;
    do {
      const page = await lives.list({ ...(after === undefined ? {} : { after }), limit: 100 });
      for (const life of page.items) {
        legacyRunControl.emergencyStop(life.lifeId);
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
