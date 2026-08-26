import path from "node:path";

import type { Clock, IdGenerator } from "../application/ports/runtime-store.js";
import type { RuntimeDiagnostics } from "../application/ports/runtime-diagnostics.js";
import { JoiInboxService } from "../application/joi/joi-inbox-service.js";
import { JoiCoordinator } from "../application/joi/joi-coordinator.js";
import { ConfiguredPiReasoningRuntime } from "../infrastructure/pi/configured-pi-reasoning-runtime.js";
import { PiWorkbenchRoutingRuntime } from "../infrastructure/pi/pi-workbench-routing-runtime.js";
import { PiReasoningFailureClassifier } from "../infrastructure/pi/pi-reasoning-failure-classifier.js";
import { JoiAttachmentService } from "../infrastructure/artifacts/joi-attachment-service.js";
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
  workbenchStack: WorkbenchBundle;
}) {
  const { clock, database, diagnostics, directoryPicker, ids, modelSourceStack, partnerStack, persistence, userDataDirectory, workbenchStack } = input;
  const joiInbox = new JoiInboxService({
    clock,
    diagnostics,
    ids,
    partners: partnerStack.partners,
    repository: persistence.joiInboxRepository,
  });
  // Constructed before the reasoning runtime and coordinator: both consume it (TDZ otherwise).
  const joiAttachmentStorage = new JoiAttachmentService({
    clock,
    database,
    ids,
    rootDirectory: path.join(userDataDirectory, "artifacts"),
  });
  const joiReasoning = new ConfiguredPiReasoningRuntime({
    resolver: modelSourceStack.configuredModelResolver,
    sessionStore: persistence.piReasoningSessionStore,
    tools: (turn) => selectJoiReasoningToolsForInput(createJoiReasoningTools({
      workbenchChanges: workbenchStack.workbenchChanges,
      workbenchId: turn.workbenchId,
      workbenchRefine: workbenchStack.workbenchManagement,
      workbenchWorkspaces: workbenchStack.workbenchWorkspaces,
      directoryPicker,
      workbenches: persistence.workbenches,
      ...(turn.attachmentIds === undefined ? {} : { attachmentIds: turn.attachmentIds }),
      attachments: joiAttachmentStorage,
      clarifications: persistence.joiInboxRepository,
      diagnostics,
      goalInputId: turn.goalInputId ?? goalFromInputIdPrefix(turn.inputId),
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
    attachments: joiAttachmentStorage,
    clock,
    diagnostics,
    failureClassifier: new PiReasoningFailureClassifier(),
    ids,
    router: new PiWorkbenchRoutingRuntime({
      resolver: modelSourceStack.configuredModelResolver,
      sources: modelSourceStack.reasoningSources,
    }),
    runtime: joiReasoning,
    sources: modelSourceStack.reasoningSources,
    store: persistence.joiInboxRepository,
    work: workbenchStack.work,
    workbenchRegistry: workbenchStack.workbenchRegistry,
    workbenches: persistence.workbenches,
  });
  return { joiAttachmentStorage, joiCoordinator, joiInbox, joiReasoning };
}

export type JoiBundle = ReturnType<typeof wireJoi>;
