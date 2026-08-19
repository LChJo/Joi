import type { Clock, IdGenerator } from "../application/ports/runtime-store.js";
import type { RuntimeDiagnostics } from "../application/ports/runtime-diagnostics.js";
import { WorkbenchRegistryService } from "../application/joi/workbench-registry-service.js";
import { WorkbenchChangeService } from "../application/joi/workbench-change-service.js";
import { WorkbenchContextAssembler } from "../application/joi/workbench-context-assembler.js";
import { WorkbenchManagementService } from "../application/joi/workbench-management-service.js";
import { WorkbenchWorkspaceService } from "../application/joi/workbench-workspace-service.js";
import { JoiHomeFeedService } from "../application/joi/joi-home-feed-service.js";
import { WorkbenchAgentService } from "../application/partners/workbench-agent-service.js";
import { WorkOrchestrationService } from "../application/work/work-orchestration-service.js";
import { WorkResultService } from "../application/work/work-result-service.js";
import type { PartnerBundle } from "./wire-partners.js";
import type { PersistenceBundle } from "./wire-persistence.js";

export function wireWorkbenches(input: {
  clock: Clock;
  diagnostics: RuntimeDiagnostics;
  ids: IdGenerator;
  partnerStack: PartnerBundle;
  persistence: PersistenceBundle;
}) {
  const { clock, diagnostics, ids, partnerStack, persistence } = input;
  const workRepository = persistence.workPlanRepository;
  return {
    joiHomeFeed: new JoiHomeFeedService({ clock, repository: persistence.joiHomeFeedRepository }),
    work: new WorkOrchestrationService({
      clock,
      diagnostics,
      ids,
      partners: partnerStack.partners,
      policy: persistence.policyGate,
      reassignment: workRepository,
      repository: workRepository,
    }),
    workbenchAgents: new WorkbenchAgentService({ clock, repository: persistence.workbenchAgentRepository }),
    workbenchChanges: new WorkbenchChangeService({ clock, ids, repository: persistence.workbenchChangeRepository }),
    workbenchContextAssembler: new WorkbenchContextAssembler({
      clock,
      ids,
      projections: persistence.workbenchContextRepository,
      snapshots: persistence.workbenchContextRepository,
      workbenches: persistence.workbenches,
    }),
    workbenchManagement: new WorkbenchManagementService({ clock, ids, repository: persistence.workbenchManagementRepository }),
    workbenchRegistry: new WorkbenchRegistryService({ clock, ids, repository: persistence.workbenches }),
    workbenchWorkspaces: new WorkbenchWorkspaceService({
      clock,
      ids,
      repository: persistence.workbenchWorkspaceRepository,
      workbenches: persistence.workbenches,
    }),
    workRepository,
    workResults: new WorkResultService(persistence.workResultRepository),
  };
}

export type WorkbenchBundle = ReturnType<typeof wireWorkbenches>;
