import { randomUUID } from "node:crypto";
import path from "node:path";

import { AgentService } from "../application/agents/agent-service.js";
import { AuthService } from "../application/auth/auth-service.js";
import { LifeService } from "../application/lives/life-service.js";
import { RemoteCommandService } from "../application/remote/remote-command-service.js";
import { RemoteHomeQueryService } from "../application/remote/remote-home-queries.js";
import type { RemoteAccessControl } from "../application/ports/remote-access.js";
import type { SsePublisher } from "../application/ports/runtime-store.js";
import { wirePersistence } from "./wire-persistence.js";
import { wireModelSources } from "./wire-model-sources.js";
import { wirePartners } from "./wire-partners.js";
import { wireWorkbenches } from "./wire-workbenches.js";
import { wireJoi } from "./wire-joi.js";
import { wireRuntime } from "./wire-runtime.js";
import { wireConversations } from "./wire-conversations.js";
import { wireOperations } from "./wire-operations.js";
import { LifeFileDeletionService } from "../infrastructure/artifacts/life-file-deletion-service.js";
import { applyPendingRestore, BackupService } from "../infrastructure/operations/backup-service.js";
import { LocalSkillScanner } from "../infrastructure/skills/local-skill-scanner.js";
import { SystemSettingsService } from "../infrastructure/operations/system-settings-service.js";
import { openRuntimeDatabase, type RuntimeDatabase } from "../infrastructure/persistence/runtime-database.js";
import { emitRuntimeDiagnostic, runtimeDiagnosticErrorCode } from "../application/ports/runtime-diagnostics.js";
import { JsonLineRuntimeDiagnostics } from "../infrastructure/runtime/json-line-runtime-diagnostics.js";
import { FileRemoteAccessStore } from "../infrastructure/remote/file-remote-access-store.js";
import { IrohSidecarTransport } from "../infrastructure/remote/iroh-sidecar-transport.js";
import { RemoteAccessHost } from "../infrastructure/remote/remote-access-host.js";
import { RuntimeMarker, type StartupEvidence } from "../infrastructure/runtime/runtime-marker.js";
import {
  InMemoryBootstrapNonceStore,
  LoginRateLimiter,
  NodeSecurityPrimitives,
} from "../infrastructure/security/security-services.js";
import { createApiHandler } from "../interfaces/http/api-handler.js";
import { startRuntimeListeners, type RuntimeListeners } from "../interfaces/http/runtime-listeners.js";
import { createStaticRendererHandler } from "../interfaces/http/static-renderer-handler.js";
import { createRecoveryModeHandler } from "../interfaces/http/recovery-mode-handler.js";

import { WorkerHomeFeedRepository } from "../infrastructure/persistence/worker-home-feed-repository.js";
import type { DesktopRuntimeConfiguration, HostedRuntime, RuntimeDesktopCapabilities } from "./desktop-runtime-contract.js";
export async function createRuntimeHost(configuration: DesktopRuntimeConfiguration, desktop: RuntimeDesktopCapabilities): Promise<HostedRuntime> {
  const isTest = configuration.isTest;
  let authService: AuthService | null = null;
  let runtimeDatabase: RuntimeDatabase | null = null;
  let databaseIntegrityMonitor: ReturnType<typeof wireOperations>["integrity"] | null = null;
  let runtimeListeners: RuntimeListeners | null = null;
  let outboxTimer: NodeJS.Timeout | null = null;
  let runtimeMarker: RuntimeMarker | null = null;
  let remoteAccessHost: RemoteAccessControl | null = null;
  let startupEvidence: StartupEvidence | undefined;
  let emergencyStopAll: (() => Promise<void>) | null = null;
  let drainRuntime: (() => Promise<void>) | null = null;
  let rootTickInFlight: Promise<void> | null = null;
  let homeFeedReader: WorkerHomeFeedRepository | null = null;
  let exportJobs: ReturnType<typeof wireRuntime>["exportJobs"] | null = null;
  let closePromise: Promise<void> | undefined;
  const clock = { now: () => new Date() };
  const ids = { next: (prefix: string) => `${prefix}_${randomUUID()}` };
  async function startRuntime(): Promise<void> {
    const userDataDirectory = configuration.userDataDirectory;
    const runtimeDiagnostics = new JsonLineRuntimeDiagnostics({
      clock,
      directory: path.join(userDataDirectory, "diagnostics"),
    });
    runtimeMarker = new RuntimeMarker(userDataDirectory);
    startupEvidence = await runtimeMarker.start(clock.now());
    const migrationsDirectory = configuration.migrationsDirectory;
    await applyPendingRestore(userDataDirectory, migrationsDirectory);
    const settings = new SystemSettingsService({
      getLaunchAtLogin: () => desktop.getLaunchAtLogin(),
      getLanRuntimeState: () => runtimeListeners?.lanState(),
      reconfigureLan: async (target) => {
        if (runtimeListeners === null) {
          return target === undefined
            ? { status: "disabled" as const }
            : { status: "blocked" as const, reasonCode: "lan_runtime_unavailable", message: "LAN 监听器尚未就绪。" };
        }
        return runtimeListeners.reconfigureLan(target);
      },
      setLaunchAtLogin: (enabled) => desktop.setLaunchAtLogin(enabled),
      setUiLocale: (preference) => desktop.setUiLocale?.(preference),
      settingsPath: path.join(userDataDirectory, "settings.json"),
      validateJoiSkills: (refs) => new LocalSkillScanner().validateRefs("pi-core", refs),
    });
    const runtimeSettings = await settings.get();
    await desktop.setUiLocale?.(runtimeSettings.uiLocale ?? "system");
    const databasePath = path.join(userDataDirectory, "runtime.sqlite");
    const database = await openRuntimeDatabase({
      databasePath,
      migrationsDirectory,
    });
    runtimeDatabase = database;
    if (database.inspect().mode === "read-only-recovery") {
      const recoveryBackups = new BackupService({
        appVersion: configuration.appVersion,
        artifactsDirectory: path.join(userDataDirectory, "artifacts"),
        backupsDirectory: path.join(userDataDirectory, "backups"),
        clock,
        database,
        migrationsDirectory,
        userDataDirectory,
      });
      runtimeListeners = await startRuntimeListeners({
        handler: createRecoveryModeHandler({ backups: recoveryBackups, requestRestart: () => desktop.requestRestart(), uiLocale: runtimeSettings.uiLocale ?? "system", systemLanguages: configuration.systemLanguages ?? [], setUiLocale: async (uiLocale) => { await settings.update({ uiLocale }); } }),
        loopbackPort: isTest ? 0 : 43_130,
      });
      runtimeDatabase = database;
      return;
    }
    // Actors converge persisted state through the single root traversal.
    const noOpPublisher: SsePublisher = { publish: () => undefined };
    const auth = new AuthService({
      clock,
      nonces: new InMemoryBootstrapNonceStore(),
      rateLimiter: new LoginRateLimiter(clock),
      security: new NodeSecurityPrimitives(),
      store: database.store,
    });
    const vault = desktop.vault;
    homeFeedReader = new WorkerHomeFeedRepository(databasePath);
    const pid = String(process.pid);
    const persistence = wirePersistence({ clock, database, pid, userDataDirectory,
      runDirectory: configuration.runDirectory, homeFeedRepository: homeFeedReader,
    });
    const modelSourceStack = wireModelSources({ clock, ids, persistence, vault });
    const partnerStack = wirePartners({ clock, diagnostics: runtimeDiagnostics, ids, modelSourceStack, persistence, userDataDirectory });
    const workbenchStack = wireWorkbenches({
      artifactOpener: { open: (input) => desktop.artifactOpen(input) },
      clock, diagnostics: runtimeDiagnostics, ids, partnerStack, persistence,
    });
    const directoryPicker = () => desktop.directoryPicker();
    const joiStack = wireJoi({
      settings,
      clock,
      database,
      directoryPicker,
      transcodeBitmap: (input) => desktop.transcodeBitmap(input),
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
      exporterFactory: (jobs) => desktop.createExporter(jobs),
      workbenchStack,
    });
    const conversationStack = wireConversations({ clock,ids,database,persistence,partnerStack,modelSourceStack,workbenchStack,
      evolution: joiStack.evolution,attachments: joiStack.joiAttachmentStorage,userDataDirectory });
    await conversationStack.recover();
    exportJobs = runtimeStack.exportJobs;
    drainRuntime = async () => { await conversationStack.close(); await runtimeStack.drain(); };
    await partnerStack.partnerInstances.recoverOnBoot();
    await runtimeStack.outboxDispatcher.dispatchOnce();
    await runtimeStack.actorTree.tick(clock.now());
    const remoteAccess = new RemoteAccessHost({
      clock,
      diagnostics: runtimeDiagnostics,
      commands: new RemoteCommandService({ homeFeed: workbenchStack.joiHomeFeed, inbox: joiStack.joiInbox, workbenchRegistry: workbenchStack.workbenchRegistry,
        conversations: {
          service: conversationStack.conversations,
          catalog: async () => {
            const [workbenches,networks,partners] = await Promise.all([persistence.workbenches.listSummaries(),modelSourceStack.modelSources.list(),partnerStack.partners.list()]);
            return { workbenches,networks: networks.map(({ sourceId,displayName,status,activeModel }) => ({ sourceId,displayName,status,activeModel: { id: activeModel.id } })),
              partners: partners.filter(p => p.kind === "local-pi" && p.status === "ACTIVE").map(({ partnerId,displayName,kind,status,engine }) => ({ partnerId,displayName,kind,status,engine })) };
          },
          skills: engine => {
            if (engine !== "pi-core" && engine !== "claude-code" && engine !== "codex") return [];
            return partnerStack.partnerSkillCatalog.listForEngine(engine).map(({ id,displayName }) => ({ id,displayName }));
          },
        },
        queries: new RemoteHomeQueryService({ homeFeed: workbenchStack.joiHomeFeed, inputs: persistence.joiInboxRepository,
          agents: workbenchStack.workbenchAgents, workbenches: persistence.workbenches, partners: partnerStack.partners }),
      }),
      store: new FileRemoteAccessStore(path.join(userDataDirectory, "remote-access.json")),
      transport: new IrohSidecarTransport(configuration.remoteSidecarPath),
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
      appVersion: configuration.appVersion,
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
      conversations: conversationStack.conversations,
      conversationWorkspace: conversationStack.workspace,
      conversationGit: conversationStack.git,
      quickWorkbench: conversationStack.quickWorkbench,
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
      requestRestart: () => desktop.requestRestart(),
      remoteAccess,
      settings,
      work: workbenchStack.workRepository,
    };
    emergencyStopAll = async () => {
      await conversationStack.emergencyStop();
      joiStack.evolution.emergencyStop();
      partnerStack.partnerMemory.emergencyStop();
      modelSourceStack.recovery.stop();
      void runtimeStack.modelRecoveryDispatcher.close().catch(() => undefined);
      void runtimeStack.memoryRefreshDispatcher.close().catch(() => undefined);
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
          configuration.rendererDirectory,
        ),
        ...(runtimeSettings.lan.enabled ? { lan: { address: runtimeSettings.lan.address, port: runtimeSettings.lan.port } } : {}),
        loopbackPort: isTest ? 0 : 43_130,
      });
      authService = auth;
      runtimeDatabase = database;
      runtimeListeners = listeners;
      integrity.start();
      outboxTimer = setInterval(() => {
        if (rootTickInFlight !== null) return;
        const pass = (async () => {
          await runtimeStack.actorTree.tick(clock.now());
          await modelSourceStack.recovery.enqueueDue();
          runtimeStack.modelRecoveryDispatcher.startOnce();
          conversationStack.dispatcher.startOnce(20);
          conversationStack.gitDispatcher.startOnce();
          conversationStack.childDispatcher.startOnce(4);
          await runtimeStack.outboxDispatcher.dispatchOnce();
          runtimeStack.memoryRefreshDispatcher.startOnce();
        })();
        rootTickInFlight = pass;
        void pass
          .catch((error: unknown) => {
            // Diagnostics retain only an allowlisted error code.
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
    await rootTickInFlight?.catch(() => undefined);
    await drainRuntime?.();
    drainRuntime = null;
    databaseIntegrityMonitor?.close();
    databaseIntegrityMonitor = null;
    await homeFeedReader?.close();
    homeFeedReader = null;
    runtimeDatabase?.close();
    runtimeDatabase = null;
    authService = null;
    emergencyStopAll = null;
    await runtimeMarker?.clean();
    runtimeMarker = null;
  }

  try { await startRuntime(); }
  catch (error) { await shutdownRuntime().catch(() => undefined); throw error; }
  return {
    apiOrigin: () => { if (runtimeListeners === null) throw new Error("runtime_not_ready"); return runtimeListeners.loopback.url; },
    issueDesktopBootstrap: () => { if (authService === null) throw new Error("runtime_not_ready"); return authService.issueDesktopBootstrap(); },
    emergencyStop: async () => { await emergencyStopAll?.(); },
    exportRecord: (id) => exportJobs?.record(id) ?? null,
    exportUpdate: (id, status, filenames, error) => { exportJobs?.update(id, status, filenames, error); },
    close: () => { closePromise ??= shutdownRuntime(); return closePromise; },
  };
}
