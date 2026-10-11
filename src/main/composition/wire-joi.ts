import path from "node:path";
import { EvolutionService } from "../application/evolution/evolution-service.js";
import { EvolutionDryRun } from "../application/evolution/evolution-dry-run.js";
import { SqliteEvolutionStore } from "../infrastructure/persistence/sqlite-evolution-store.js";
import { PiEvolutionModel } from "../infrastructure/pi/pi-evolution-model.js";
import { ReasoningSourceSelector } from "../application/model-sources/reasoning-source-selector.js";
import type { SystemSettingsPort } from "../application/ports/system-settings.js";
import { JoiSkillRuntime } from "../infrastructure/pi/joi-skill-runtime.js";

import type { Clock, IdGenerator } from "../application/ports/runtime-store.js";
import type { RuntimeDiagnostics } from "../application/ports/runtime-diagnostics.js";
import { JoiInboxService } from "../application/joi/joi-inbox-service.js";
import { AutomationService } from "../application/automation/automation-service.js";
import { JoiCoordinator } from "../application/joi/joi-coordinator.js";
import { ConfiguredPiReasoningRuntime } from "../infrastructure/pi/configured-pi-reasoning-runtime.js";
import { PiWorkbenchRoutingRuntime } from "../infrastructure/pi/pi-workbench-routing-runtime.js";
import { PiReasoningFailureClassifier } from "../infrastructure/pi/pi-reasoning-failure-classifier.js";
import { JoiAttachmentService } from "../infrastructure/artifacts/joi-attachment-service.js";
import { transcodeBitmapToPng } from "../infrastructure/artifacts/bitmap-transcoder.js";
import {
  createJoiReasoningTools,
  goalFromInputIdPrefix,
  selectJoiReasoningToolsForInput,
} from "../infrastructure/pi/joi-reasoning-tools.js";
import type { ModelSourceBundle } from "./wire-model-sources.js";
import type { PartnerBundle } from "./wire-partners.js";
import type { PersistenceBundle } from "./wire-persistence.js";
import type { WorkbenchBundle } from "./wire-workbenches.js";
import type { RuntimeDatabase } from "../infrastructure/persistence/runtime-database.js";

export function wireJoi(input: {
  clock: Clock;
  database: RuntimeDatabase;
  directoryPicker: () => Promise<string | null>;
  diagnostics: RuntimeDiagnostics;
  ids: IdGenerator;
  modelSourceStack: ModelSourceBundle;
  partnerStack: PartnerBundle;
  persistence: PersistenceBundle;
  userDataDirectory: string;
  settings: SystemSettingsPort;
  workbenchStack: WorkbenchBundle;
}) {
  const { clock, database, diagnostics, directoryPicker, ids, modelSourceStack, partnerStack, persistence, userDataDirectory, workbenchStack } = input;
  const evolution = new EvolutionService({ store: new SqliteEvolutionStore(database), diagnostics,
    // Read-only selection: freshness probes would spend unreserved calls outside evolution's outbox.
    model: new PiEvolutionModel({ resolver: modelSourceStack.configuredModelResolver,
      sources: new ReasoningSourceSelector(persistence.modelSourceRepository, { diagnostics }),
      usage: modelSourceStack.statistics }),
    now: () => clock.now().toISOString(), id: () => ids.next("evolution") });
  // Shares the clock and id source with the real service but none of its dependencies: a dry run
  // builds its own stand-in model and in-memory store, so it can never reach a provider or this database.
  const evolutionDryRun = new EvolutionDryRun({ now: () => clock.now().toISOString(), id: () => ids.next("evolution-dry-run") });
  const joiInbox = new JoiInboxService({
    clock,
    diagnostics,
    ids,
    partners: partnerStack.partners,
    repository: persistence.joiInboxRepository,
  });
  const automation = new AutomationService({
    clock,
    ids,
    partners: partnerStack.partners,
    store: persistence.automationStore,
    workbenches: persistence.workbenches,
    workspaces: persistence.workbenchWorkspaceRepository,
  });
  // Constructed before the reasoning runtime and coordinator: both consume it (TDZ otherwise).
  const joiAttachmentStorage = new JoiAttachmentService({
    clock,
    database,
    ids,
    rootDirectory: path.join(userDataDirectory, "artifacts"),
    transcodeBitmap: transcodeBitmapToPng,
  });
  const joiReasoning = new ConfiguredPiReasoningRuntime({
    diagnostics,
    usage: modelSourceStack.statistics,
    skills: new JoiSkillRuntime({ catalog: partnerStack.partnerSkillCatalog, settings: input.settings }),
    resolver: modelSourceStack.configuredModelResolver,
    sessionStore: persistence.piReasoningSessionStore,
    tools: (turn) => selectJoiReasoningToolsForInput(createJoiReasoningTools({
      automation,
      workbenchChanges: workbenchStack.workbenchChanges,
      workbenchId: turn.workbenchId,
      workbenchWorkspaces: workbenchStack.workbenchWorkspaces,
      directoryPicker,
      workbenches: persistence.workbenches,
      ...(turn.attachmentIds === undefined ? {} : { attachmentIds: turn.attachmentIds }),
      attachments: joiAttachmentStorage,
      clarifications: persistence.joiInboxRepository,
      diagnostics,
      goalInputId: turn.goalInputId ?? goalFromInputIdPrefix(turn.inputId),
      requirements: persistence.goalRequirements,
      harness: persistence.joiHarnessRepository,
      inputId: turn.inputId,
      instances: partnerStack.partnerInstances,
      memory: partnerStack.partnerMemory,
      models: modelSourceStack.modelSources,
      partners: partnerStack.partners,
      results: workbenchStack.workResults,
      skills: partnerStack.partnerSkillCatalog,
      turnId: turn.turnId,
      work: workbenchStack.work,
    }), turn.inputId),
  });
  const joiCoordinator = new JoiCoordinator({
    requirements: persistence.goalRequirements,
    evolution,
    automation,
    attachments: joiAttachmentStorage,
    clock,
    diagnostics,
    failureClassifier: new PiReasoningFailureClassifier(),
    ids,
    router: new PiWorkbenchRoutingRuntime({
      usage: modelSourceStack.statistics,
      resolver: modelSourceStack.configuredModelResolver,
      sources: modelSourceStack.reasoningSources,
    }),
    runtime: joiReasoning,
    sources: modelSourceStack.reasoningSources,
    store: persistence.joiInboxRepository,
    work: workbenchStack.work,
    workbenchRegistry: workbenchStack.workbenchRegistry,
    workbenches: persistence.workbenches,
    workspaces: workbenchStack.workbenchWorkspaces,
  });
  return { automation, evolution, evolutionDryRun, joiAttachmentStorage, joiCoordinator, joiInbox, joiReasoning };
}

export type JoiBundle = ReturnType<typeof wireJoi>;
