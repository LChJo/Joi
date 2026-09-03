import path from "node:path";
import { lookup } from "node:dns/promises";

import type { Clock, IdGenerator, SsePublisher } from "../application/ports/runtime-store.js";
import type { RuntimeDiagnostics } from "../application/ports/runtime-diagnostics.js";
import { ActorTree } from "../application/actors/actor-tree.js";
import { JoiActor } from "../application/actors/joi-actor.js";
import { WorkbenchActor } from "../application/actors/workbench-actor.js";
import { JoiTaskComponent } from "../application/actors/components/joi-task-component.js";
import { JoiAutomationComponent } from "../application/actors/components/joi-automation-component.js";
import { JoiWorkbenchComponent } from "../application/actors/components/joi-workbench-component.js";
import { JoiHarnessComponent } from "../application/actors/components/joi-harness-component.js";
import { JoiRhythmComponent } from "../application/actors/components/joi-rhythm-component.js";
import { WorkbenchAgentComponent } from "../application/actors/components/workbench-agent-component.js";
import { SqliteJoiTaskReader } from "../infrastructure/persistence/sqlite-joi-task-reader.js";
import { SqliteWorkbenchAttentionReconciler } from "../infrastructure/persistence/sqlite-workbench-attention-reconciler.js";
import { A2aGatewayService } from "../application/a2a/a2a-gateway-service.js";
import { AgentOnboardingService } from "../application/agents/agent-onboarding-service.js";
import { DelegationService } from "../application/agents/delegation-service.js";
import { InteractionService } from "../application/agents/interaction-service.js";
import { ContinuityService } from "../application/continuity/continuity-service.js";
import { EventService } from "../application/events/event-service.js";
import { LifeRuntimeService } from "../application/lives/life-runtime-service.js";
import { OutboxDispatcher } from "../application/operations/outbox-dispatcher.js";
import { AlarmScheduler } from "../application/rhythm/alarm-scheduler.js";
import { ScheduleScheduler } from "../application/rhythm/schedule-scheduler.js";
import { BudgetService } from "../application/rhythm/budget-service.js";
import { IdleExplorationScheduler } from "../application/rhythm/idle-exploration-scheduler.js";
import { ExpressionDeliveryScheduler } from "../application/rhythm/expression-delivery-scheduler.js";
import { TodoScheduler } from "../application/rhythm/todo-scheduler.js";
import { ArtifactService } from "../infrastructure/artifacts/artifact-service.js";
import { A2aAgentDiscovery } from "../infrastructure/a2a/a2a-agent-discovery.js";
import { OutboundNetworkPolicy } from "../infrastructure/a2a/outbound-network-policy.js";
import { SdkA2aInvocationTransport } from "../infrastructure/a2a/sdk-a2a-invocation-transport.js";
import { SecureArtifactDownloader } from "../infrastructure/a2a/secure-artifact-downloader.js";
import { SqlitePartnerDispatchDelivery } from "../infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import { InMemoryEventSignal } from "../infrastructure/runtime/in-memory-event-signal.js";
import { WorkspaceWorkVerifier } from "../infrastructure/workspace/workspace-work-verifier.js";
import { WorkAttachmentStager } from "../infrastructure/workspace/workspace-attachment-stager.js";
import type { ElectronCredentialVault } from "../infrastructure/security/electron-credential-vault.js";
import type { RuntimeDatabase } from "../infrastructure/persistence/runtime-database.js";
import type { JoiBundle } from "./wire-joi.js";
import type { ModelSourceBundle } from "./wire-model-sources.js";
import type { PartnerBundle } from "./wire-partners.js";
import type { PersistenceBundle } from "./wire-persistence.js";
import type { WorkbenchBundle } from "./wire-workbenches.js";

export function wireRuntime(input: {
  clock: Clock;
  database: RuntimeDatabase;
  diagnostics: RuntimeDiagnostics;
  ids: IdGenerator;
  joiStack: JoiBundle;
  modelSourceStack: ModelSourceBundle;
  partnerStack: PartnerBundle;
  persistence: PersistenceBundle;
  publisher: SsePublisher;
  userDataDirectory: string;
  vault: ElectronCredentialVault;
  workbenchStack: WorkbenchBundle;
}) {
  const { clock, database, diagnostics, ids, joiStack, modelSourceStack, partnerStack, persistence, publisher, userDataDirectory, vault, workbenchStack } = input;
  const artifactsDirectory = path.join(userDataDirectory, "artifacts");
  const policy = new OutboundNetworkPolicy({
    resolve: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((record) => record.address),
  });
  const artifactStorage = new ArtifactService({ rootDirectory: artifactsDirectory, store: database.store });
  const agentOnboarding = new AgentOnboardingService({
    clock,
    discovery: new A2aAgentDiscovery({ policy }),
    ids,
    store: database.store,
    vault,
  });
  const a2aGateway = new A2aGatewayService({
    artifactDownloader: new SecureArtifactDownloader({ policy, rootDirectory: artifactsDirectory }),
    clock,
    ids,
    store: database.store,
    transport: new SdkA2aInvocationTransport({ policy }),
    vault,
  });
  const events = new EventService({ clock, ids, publisher, signal: new InMemoryEventSignal(), store: database.store });
  const lifeRuntime = new LifeRuntimeService({ clock, events, store: database.store });
  const notifyJoi = (workbenchId: string, type: string): void => {
    const signalId = ids.next("runtime_signal");
    void persistence.joiInboxRepository.enqueueSystemSignal({ workbenchId, signalId, type })
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
  const interactions = new InteractionService({
    events,
    gateway: a2aGateway,
    notify: (workbenchId) => notifyJoi(workbenchId, "partner.interaction_changed"),
    store: database.store,
  });
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
  const alarmScheduler = new AlarmScheduler({ clock, ids, notify: (workbenchId) => notifyJoi(workbenchId, "schedule.alarm_due"), publisher, store: database.store });
  const scheduleScheduler = new ScheduleScheduler({ clock, ids, notify: (workbenchId) => notifyJoi(workbenchId, "schedule.rhythm_due"), publisher, store: database.store });
  const todoScheduler = new TodoScheduler({ clock, ids, notify: (workbenchId) => notifyJoi(workbenchId, "todo.due"), publisher, store: database.store });
  const expressionDelivery = new ExpressionDeliveryScheduler({ clock, publisher, store: database.store });
  const partnerDispatchDelivery = new SqlitePartnerDispatchDelivery({
    agentConversations: persistence.workbenchAgentRepository,
    attachmentStager: new WorkAttachmentStager({ attachments: joiStack.joiAttachmentStorage, database }),
    clarifications: persistence.joiInboxRepository,
    clock,
    contextAssembler: workbenchStack.workbenchContextAssembler,
    contexts: persistence.workbenchContextRepository,
    database,
    diagnostics,
    gateway: a2aGateway,
    instances: partnerStack.partnerInstances,
    leases: persistence.workspaceLeases,
    partners: persistence.partnerRegistryRepository,
    results: persistence.workResultRepository,
    verifier: new WorkspaceWorkVerifier({ contexts: persistence.workbenchContextRepository }),
  });
  const actorTree = new ActorTree({
    clock,
    diagnostics,
    roots: [new JoiActor({
      workbenchComponent: new JoiWorkbenchComponent({ workbenches: persistence.workbenches }),
      components: [
        new JoiAutomationComponent({ store: persistence.automationStore }),
        new JoiTaskComponent({
          driver: { handle: (inputId, signal) => joiStack.joiCoordinator.handle(inputId, signal) },
          gate: { hasReadySource: () => modelSourceStack.modelSources.hasReadySource() },
          inbox: new SqliteJoiTaskReader({
            database,
            failTurn: (inputId, turnId) => persistence.joiInboxRepository.failTurn(inputId, turnId),
            park: async (inputId, failure) => { await persistence.joiInboxRepository.park(inputId, failure); },
          }),
        }),
        new JoiHarnessComponent({
          reviewEnabled: true,
          scan: persistence.joiHarnessRepository,
          writer: persistence.joiHarnessRepository,
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
          attention: new SqliteWorkbenchAttentionReconciler(database),
          workbenchId,
          dispatch: {
            claims: persistence.dispatchClaims,
            delivery: partnerDispatchDelivery,
            outbox: database.store,
            owner: `agent_${workbenchId}_${String(process.pid)}`,
          },
          instances: partnerStack.partnerInstances,
          memory: partnerStack.partnerMemory,
          scan: persistence.workbenchAgentScan,
          synthesis: persistence.joiInboxRepository,
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
    diagnostics,
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
      "workbench.workspace.provision": (record) => persistence.workbenchWorkspaceProvisioner.handle(record),
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
  return {
    a2aGateway,
    actorTree,
    agentOnboarding,
    artifactStorage,
    budgets,
    continuity: new ContinuityService({ clock, publisher, store: database.store }),
    delegations,
    drain: async () => {
      for (let batch = 0; batch < 10; batch += 1) {
        if (await outboxDispatcher.dispatchOnce(100) === 0) break;
      }
      await actorTree.tick(clock.now());
    },
    events,
    interactions,
    legacyRunControl,
    lifeRuntime,
    outboxDispatcher,
  };
}

export type RuntimeBundle = ReturnType<typeof wireRuntime>;
