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
import { ActorTree } from "./application/actors/actor-tree.js";
import { JoiActor } from "./application/actors/joi-actor.js";
import { WorkbenchActor } from "./application/actors/workbench-actor.js";
import { JoiTaskComponent } from "./application/actors/components/joi-task-component.js";
import { JoiWorkbenchComponent } from "./application/actors/components/joi-workbench-component.js";
import { JoiHarnessComponent } from "./application/actors/components/joi-harness-component.js";
import { JoiRhythmComponent } from "./application/actors/components/joi-rhythm-component.js";
import { WorkbenchAgentComponent } from "./application/actors/components/workbench-agent-component.js";
import { SqliteJoiTaskReader } from "./infrastructure/persistence/sqlite-joi-task-reader.js";
import { SqliteWorkbenchAgentScan } from "./infrastructure/persistence/sqlite-workbench-agent-scan.js";
import { SqliteJoiHarnessRepository } from "./infrastructure/persistence/sqlite-joi-harness-repository.js";
import { WorkbenchRegistryService } from "./application/joi/workbench-registry-service.js";
import { WorkbenchChangeService } from "./application/joi/workbench-change-service.js";
import { WorkbenchContextAssembler } from "./application/joi/workbench-context-assembler.js";
import { WorkbenchManagementService } from "./application/joi/workbench-management-service.js";
import { JoiHomeFeedService } from "./application/joi/joi-home-feed-service.js";
import { WorkbenchAgentService } from "./application/partners/workbench-agent-service.js";
import { WorkbenchWorkspaceService } from "./application/joi/workbench-workspace-service.js";
import { PartnerRegistryService } from "./application/partners/partner-registry-service.js";
import { PartnerKnowledgeService } from "./application/partners/partner-knowledge-service.js";
import { PartnerInstanceManager } from "./application/partners/partner-instance-manager.js";
import { PartnerEngineCatalog } from "./application/partners/partner-engine-catalog.js";
import { PartnerWorkMemoryService } from "./application/partners/partner-work-memory-service.js";
import type { PartnerEngineRuntime } from "./application/ports/partner-instances.js";
import type { SsePublisher } from "./application/ports/runtime-store.js";
import { WorkOrchestrationService } from "./application/work/work-orchestration-service.js";
import { WorkResultService } from "./application/work/work-result-service.js";
import { applyPendingRestore, BackupService } from "./infrastructure/operations/backup-service.js";
import { SystemSettingsService } from "./infrastructure/operations/system-settings-service.js";
import { RuntimeMarker, type StartupEvidence } from "./infrastructure/runtime/runtime-marker.js";
import { OutboxDispatcher } from "./application/operations/outbox-dispatcher.js";
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
import { SqlitePartnerKnowledgeStore } from "./infrastructure/persistence/sqlite-partner-knowledge-store.js";
import { SqlitePartnerInstanceMessageStore } from "./infrastructure/persistence/sqlite-partner-instance-message-store.js";
import { SqlitePartnerInstanceRepository } from "./infrastructure/persistence/sqlite-partner-instance-repository.js";
import { SqlitePartnerWorkMemoryStore } from "./infrastructure/persistence/sqlite-partner-work-memory-store.js";
import { LegacyLifeStoreAdapter } from "./infrastructure/persistence/legacy-life-store-adapter.js";
import { SqliteWorkbenchChangeRepository } from "./infrastructure/persistence/sqlite-workbench-change-repository.js";
import { SqliteWorkbenchContextRepository } from "./infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqliteWorkbenchManagementRepository } from "./infrastructure/persistence/sqlite-workbench-management-repository.js";
import { SqliteWorkbenchAgentRepository } from "./infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { SqliteJoiHomeFeedRepository } from "./infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteWorkbenchWorkspaceRepository } from "./infrastructure/persistence/sqlite-workbench-workspace-repository.js";
import { WorkbenchWorkspaceProvisioner } from "./infrastructure/persistence/workbench-workspace-provisioner.js";
import { SqliteWorkResultRepository } from "./infrastructure/persistence/sqlite-work-result-repository.js";
import { WorkspaceWorkVerifier } from "./infrastructure/workspace/workspace-work-verifier.js";
import { ModelSourceNetworkPolicy } from "./infrastructure/pi/model-source-network-policy.js";
import { PiModelSourceCatalog } from "./infrastructure/pi/pi-model-source-catalog.js";
import { PiModelSourceValidator } from "./infrastructure/pi/pi-model-source-validator.js";
import { SafeStoragePiCredentialStore } from "./infrastructure/pi/pi-credential-store-adapter.js";
import { ConfiguredPiReasoningRuntime } from "./infrastructure/pi/configured-pi-reasoning-runtime.js";
import { PiWorkbenchRoutingRuntime } from "./infrastructure/pi/pi-workbench-routing-runtime.js";
import { RepositoryPiConfiguredModelResolver } from "./infrastructure/pi/pi-configured-model-resolver.js";
import { createJoiReasoningTools, goalFromInputIdPrefix, selectJoiReasoningToolsForInput } from "./infrastructure/pi/joi-reasoning-tools.js";
import { SqlitePartnerDispatchClaims, SqlitePartnerDispatchDelivery } from "./infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { PiPartnerEngineRuntime } from "./infrastructure/pi/pi-partner-engine-runtime.js";
import { PiPartnerMemorySummarizer } from "./infrastructure/pi/pi-partner-memory-summarizer.js";
import { LocalCliPartnerEngineRuntime } from "./infrastructure/mana/local-cli-partner-engine-runtime.js";
import { ManaSdkConversationStore } from "./infrastructure/mana/mana-sdk-session-store.js";
import { LocalSkillScanner } from "./infrastructure/skills/local-skill-scanner.js";
import { dialog } from "electron";
import { BuiltinPiCodingToolFactory } from "./infrastructure/pi/pi-coding-tool-factory.js";
import { PiReasoningFailureClassifier } from "./infrastructure/pi/pi-reasoning-failure-classifier.js";
import { InMemoryEventSignal } from "./infrastructure/runtime/in-memory-event-signal.js";
import { JsonLineRuntimeDiagnostics } from "./infrastructure/runtime/json-line-runtime-diagnostics.js";
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

// E2E uses an isolated userData directory and must be able to run while a developer instance is open.
const hasSingleInstanceLock = isTest || app.requestSingleInstanceLock();
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
  // SSE transport retired (ADR 0009): publishers are no-ops; actors converge state by traversal.
  const noOpPublisher: SsePublisher = { publish: () => undefined };
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
    diagnostics: runtimeDiagnostics,
    ids,
    repository: joiInboxRepository,
  });
  const partnerRepository = new SqlitePartnerRegistryRepository(database);
  const partnerPrompts = new SqlitePartnerPromptStore(database);
  const partnerKnowledge = new PartnerKnowledgeService({ clock, ids, store: new SqlitePartnerKnowledgeStore(database) });
  const partners = new PartnerRegistryService({
    clock,
    ids,
    knowledge: partnerKnowledge,
    prompts: partnerPrompts,
    repository: partnerRepository,
  });
  const workbenches = new LegacyLifeStoreAdapter(database);
  const joiHarnessRepository = new SqliteJoiHarnessRepository(database);
  const workbenchRegistry = new WorkbenchRegistryService({ clock, ids, repository: workbenches });
  const workbenchContextRepository = new SqliteWorkbenchContextRepository(database);
  const workbenchContextAssembler = new WorkbenchContextAssembler({ workbenches, clock, ids, projections: workbenchContextRepository, snapshots: workbenchContextRepository });
  const workbenchManagement = new WorkbenchManagementService({ clock, ids, repository: new SqliteWorkbenchManagementRepository(database) });
  const workbenchAgentRepository = new SqliteWorkbenchAgentRepository(database);
  const workbenchAgents = new WorkbenchAgentService({ clock, repository: workbenchAgentRepository });
  const joiHomeFeed = new JoiHomeFeedService({ clock, repository: new SqliteJoiHomeFeedRepository(database) });
  const workbenchWorkspaceRepository = new SqliteWorkbenchWorkspaceRepository(database);
  const workbenchWorkspaces = new WorkbenchWorkspaceService({ workbenches, clock, ids, repository: workbenchWorkspaceRepository });
  const workbenchWorkspaceProvisioner = new WorkbenchWorkspaceProvisioner({ database, userDataDirectory });
  const workbenchChanges = new WorkbenchChangeService({ clock, ids, repository: new SqliteWorkbenchChangeRepository(database) });
  const workRepository = new SqliteWorkPlanRepository(database);
  const work = new WorkOrchestrationService({
    clock,
    diagnostics: runtimeDiagnostics,
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
  const piCodingTools = new BuiltinPiCodingToolFactory();
  const localCliConversationStore = new ManaSdkConversationStore(database);
  const partnerSkillCatalog = new LocalSkillScanner();
  const partnerEngines = new Map<string, PartnerEngineRuntime>([
    ["pi-core", new PiPartnerEngineRuntime({ contexts: workbenchContextRepository, prompts: partnerPrompts, resolver: configuredModelResolver, sources: reasoningSources, tools: piCodingTools })],
    ["claude-code", new LocalCliPartnerEngineRuntime({ contexts: workbenchContextRepository, prompts: partnerPrompts, protocol: "claude", store: localCliConversationStore })],
    ["codex", new LocalCliPartnerEngineRuntime({ contexts: workbenchContextRepository, prompts: partnerPrompts, protocol: "codex", store: localCliConversationStore })],
  ]);
  const engineCatalog = new PartnerEngineCatalog(partnerEngines);
  const partnerInstances = new PartnerInstanceManager({
    clock,
    diagnostics: runtimeDiagnostics,
    engines: partnerEngines,
    ids,
    knowledge: partnerKnowledge,
    messages: new SqlitePartnerInstanceMessageStore(database),
    registry: partners,
    repository: new SqlitePartnerInstanceRepository(database),
    revisions: partnerRepository,
    skills: partnerSkillCatalog,
  });
  const partnerMemory = new PartnerWorkMemoryService({
    clock,
    ids,
    store: new SqlitePartnerWorkMemoryStore(database),
    summarizer: new PiPartnerMemorySummarizer({ resolver: configuredModelResolver, sources: reasoningSources }),
  });
  const workResultRepository = new SqliteWorkResultRepository(database);
  const workResults = new WorkResultService(workResultRepository);
  const joiReasoning = new ConfiguredPiReasoningRuntime({
    resolver: configuredModelResolver,
    sessionStore: new SqlitePiReasoningSessionStore(database),
    tools: (turn) => selectJoiReasoningToolsForInput(createJoiReasoningTools({
      workbenchChanges, workbenchId: turn.workbenchId, workbenchRefine: workbenchManagement, workbenches,
      clarifications: joiInboxRepository,
      goalInputId: turn.goalInputId ?? goalFromInputIdPrefix(turn.inputId),
      harness: joiHarnessRepository, inputId: turn.inputId,
      instances: partnerInstances, memory: partnerMemory, models: modelSources, partners, results: workResults,
      turnId: turn.turnId, work,
    }), turn.inputId),
  });
  const joiCoordinator = new JoiCoordinator({
    workbenches,
    workbenchRegistry,
    clock,
    diagnostics: runtimeDiagnostics,
    failureClassifier: new PiReasoningFailureClassifier(),
    ids,
    router: new PiWorkbenchRoutingRuntime({ resolver: configuredModelResolver, sources: reasoningSources }),
    runtime: joiReasoning,
    sources: reasoningSources,
    store: joiInboxRepository,
  });
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
  const events = new EventService({ clock, ids, publisher: noOpPublisher, signal: eventSignal, store: database.store });
  const lifeRuntime = new LifeRuntimeService({ clock, events, store: database.store });
  const notifyJoi = (workbenchId: string, type: string): void => {
    const signalId = ids.next("runtime_signal");
    void joiInboxRepository.enqueueSystemSignal({ workbenchId, signalId, type })
      .catch(() => process.stderr.write("A runtime signal remains available for recovery.\n"));
  };
  const legacyRunControl = {
    emergencyStop: (workbenchId: string): void => { void lifeRuntime.emergencyStop(workbenchId); },
    notify: (workbenchId: string): void => notifyJoi(workbenchId, "legacy.user_requested"),
  };
  const delegations = new DelegationService({
    artifacts: artifactStorage,
    clock,
    events,
    gateway: a2aGateway,
    notify: (workbenchId) => notifyJoi(workbenchId, "partner.delegation_changed"),
    store: database.store,
  });
  const interactions = new InteractionService({ events, gateway: a2aGateway, notify: (workbenchId) => notifyJoi(workbenchId, "partner.interaction_changed"), store: database.store });
  const budgets = new BudgetService({
    clock,
    events,
    notify: (workbenchId) => notifyJoi(workbenchId, "budget.changed"),
    store: database.store,
  });
  const idleExploration = new IdleExplorationScheduler({
    clock,
    events,
    notify: (workbenchId) => notifyJoi(workbenchId, "idle.exploration_due"),
    store: database.store,
  });
  const alarmScheduler = new AlarmScheduler({
    clock,
    ids,
    notify: (workbenchId) => notifyJoi(workbenchId, "schedule.alarm_due"),
    publisher: noOpPublisher,
    store: database.store,
  });
  const scheduleScheduler = new ScheduleScheduler({
    clock,
    ids,
    notify: (workbenchId) => notifyJoi(workbenchId, "schedule.rhythm_due"),
    publisher: noOpPublisher,
    store: database.store,
  });
  const todoScheduler = new TodoScheduler({
    clock,
    ids,
    notify: (workbenchId) => notifyJoi(workbenchId, "todo.due"),
    publisher: noOpPublisher,
    store: database.store,
  });
  const expressionDelivery = new ExpressionDeliveryScheduler({ clock, publisher: noOpPublisher, store: database.store });
  const workbenchAgentScan = new SqliteWorkbenchAgentScan(database);
  const workspaceLeases = new SqliteWorkspaceLeaseManager({ clock, database, owner: `partner_${String(process.pid)}` });
  const partnerDispatchClaims = new SqlitePartnerDispatchClaims(database);
  const partnerDispatchDelivery = new SqlitePartnerDispatchDelivery({
    agentConversations: workbenchAgentRepository,
    clock,
    contextAssembler: workbenchContextAssembler,
    contexts: workbenchContextRepository,
    database,
    diagnostics: runtimeDiagnostics,
    gateway: a2aGateway,
    instances: partnerInstances,
    leases: workspaceLeases,
    partners: partnerRepository,
    results: workResultRepository,
    verifier: new WorkspaceWorkVerifier({ contexts: workbenchContextRepository }),
  });
  const actorTree = new ActorTree({
    clock,
    diagnostics: runtimeDiagnostics,
    roots: [new JoiActor({
      workbenchComponent: new JoiWorkbenchComponent({ workbenches }),
      components: [
        new JoiTaskComponent({
          driver: { handle: (inputId) => joiCoordinator.handle(inputId) },
          gate: { hasReadySource: () => modelSources.hasReadySource() },
          inbox: new SqliteJoiTaskReader({
            cancel: async (inputId) => { await joiInboxRepository.cancel(inputId); },
            database,
            failTurn: (inputId, turnId) => joiInboxRepository.failTurn(inputId, turnId),
          }),
        }),
        new JoiHarnessComponent({
          reviewEnabled: true,
          scan: joiHarnessRepository,
          writer: joiHarnessRepository,
        }),
        new JoiRhythmComponent({
          services: [
            { name: "alarm", tick: () => alarmScheduler.tick() },
            { name: "schedule", tick: () => scheduleScheduler.tick() },
            { name: "todo", tick: () => todoScheduler.tick() },
            { name: "expression", tick: () => expressionDelivery.tick() },
            { name: "budgets", tick: () => budgets.tick() },
            { name: "idle-exploration", tick: () => idleExploration.tick() },
          ],
        }),
      ],
      createChild: (workbenchId) => {
        const agentComponent = new WorkbenchAgentComponent({
          workbenchId,
          dispatch: {
            claims: partnerDispatchClaims,
            delivery: partnerDispatchDelivery,
            outbox: database.store,
            owner: `agent_${workbenchId}_${String(process.pid)}`,
          },
          instances: partnerInstances,
          memory: partnerMemory,
          scan: workbenchAgentScan,
          synthesis: joiInboxRepository,
        });
        return new WorkbenchActor({
          workbenchId,
          children: () => agentComponent.agentActors,
          components: [agentComponent],
        });
      },
    })],
  });
  const outboxDispatcher = new OutboxDispatcher({
    clock,
    diagnostics: runtimeDiagnostics,
    excludeKinds: ["partner.dispatch"],
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
      "workbench.workspace.provision": (record) => workbenchWorkspaceProvisioner.handle(record),
      "partner.cancel": async (record) => {
        const actionId = record.payload.actionId;
        if (typeof actionId !== "string") throw new Error("partner_cancel_payload_invalid");
        const invocation = database.transaction((connection) => connection.prepare(
          "SELECT invocation_id FROM invocations WHERE message_id = ?",
        ).get(actionId)) as { invocation_id?: unknown } | undefined;
        if (typeof invocation?.invocation_id === "string") await a2aGateway.cancel(invocation.invocation_id);
      },
    },
    onError: () => process.stderr.write("An outbox delivery will be retried.\n"),
    owner: `outbox_${String(process.pid)}`,
    store: database.store,
  });
  drainRuntime = async () => {
    for (let batch = 0; batch < 10; batch += 1) {
      if (await outboxDispatcher.dispatchOnce(100) === 0) break;
    }
    await actorTree.tick(clock.now());
  };
  await partnerInstances.recoverOnBoot();
  await outboxDispatcher.dispatchOnce();
  await actorTree.tick(clock.now());
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
    workbenchChanges,
    workbenchManagement,
    workbenchAgents,
    workbenchRegistry,
    workbenchWorkspaces,
    workbenches,
    budgets,
    continuity: new ContinuityService({ clock, publisher: noOpPublisher, store: database.store }),
    events,
    globalEmergencyStop: async () => { await emergencyStopAll?.(); },
    engines: engineCatalog,
    instances: partnerInstances,
    interactions,
    joiActivity: joiInboxRepository,
    joiHomeFeed,
    joiAttachments: joiAttachmentStorage,
    joiInbox,
    knowledge: partnerKnowledge,
    lifeRuntime,
    lives,
    memory: partnerMemory,
    directoryPicker: async () => {
      try {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "绑定 Workbench 工作目录" });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0] ?? null;
      } catch {
        return null;
      }
    },
    skills: partnerSkillCatalog,
    modelSources,
    operations,
    partners,
    requestRestart: () => requestApplicationRestart(),
    settings,
    wakeCoordinator: legacyRunControl,
    work: workRepository,
  };
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
    let rootTickInFlight: Promise<void> | null = null;
    outboxTimer = setInterval(() => {
      if (rootTickInFlight !== null) return;
      const pass = (async () => {
        await actorTree.tick(clock.now());
        await outboxDispatcher.dispatchOnce();
      })();
      rootTickInFlight = pass;
      void pass
        .catch(() => process.stderr.write("Runtime background dispatch cycle failed.\n"))
        .finally(() => {
          if (rootTickInFlight === pass) rootTickInFlight = null;
        });
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
