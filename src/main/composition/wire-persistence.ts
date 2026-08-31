import type { Clock } from "../application/ports/runtime-store.js";
import { LegacyLifeStoreAdapter } from "../infrastructure/persistence/legacy-life-store-adapter.js";
import { SqliteDispatchPolicyGate } from "../infrastructure/persistence/sqlite-dispatch-policy-gate.js";
import { SqliteJoiHarnessRepository } from "../infrastructure/persistence/sqlite-joi-harness-repository.js";
import { SqliteJoiHomeFeedRepository } from "../infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { SqliteJoiInboxRepository } from "../infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteModelSourceRepository } from "../infrastructure/persistence/sqlite-model-source-repository.js";
import { SqlitePartnerInstanceMessageStore } from "../infrastructure/persistence/sqlite-partner-instance-message-store.js";
import { SqlitePartnerInstanceRepository } from "../infrastructure/persistence/sqlite-partner-instance-repository.js";
import { SqlitePartnerKnowledgeStore } from "../infrastructure/persistence/sqlite-partner-knowledge-store.js";
import { SqlitePartnerPromptStore } from "../infrastructure/persistence/sqlite-partner-prompt-store.js";
import { SqlitePartnerRegistryRepository } from "../infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqliteScenarioPackRepository } from "../infrastructure/persistence/sqlite-scenario-pack-repository.js";
import { SqlitePartnerWorkMemoryStore } from "../infrastructure/persistence/sqlite-partner-work-memory-store.js";
import { SqlitePiCredentialRepository } from "../infrastructure/persistence/sqlite-pi-credential-repository.js";
import { SqlitePiReasoningSessionStore } from "../infrastructure/persistence/sqlite-pi-reasoning-session-store.js";
import { SqliteWorkbenchAgentRepository } from "../infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { SqliteWorkbenchAgentScan } from "../infrastructure/persistence/sqlite-workbench-agent-scan.js";
import { SqliteWorkbenchChangeRepository } from "../infrastructure/persistence/sqlite-workbench-change-repository.js";
import { SqliteWorkbenchContextRepository } from "../infrastructure/persistence/sqlite-workbench-context-repository.js";
import { SqliteWorkbenchManagementRepository } from "../infrastructure/persistence/sqlite-workbench-management-repository.js";
import { SqliteWorkbenchWorkspaceRepository } from "../infrastructure/persistence/sqlite-workbench-workspace-repository.js";
import { SqliteWorkPlanRepository } from "../infrastructure/persistence/sqlite-work-plan-repository.js";
import { SqliteWorkResultRepository } from "../infrastructure/persistence/sqlite-work-result-repository.js";
import { SqliteWorkspaceLeaseManager } from "../infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { WorkbenchWorkspaceProvisioner } from "../infrastructure/persistence/workbench-workspace-provisioner.js";
import { SqlitePartnerDispatchClaims } from "../infrastructure/a2a/partner-dispatch-delivery-adapter.js";
import type { RuntimeDatabase } from "../infrastructure/persistence/runtime-database.js";

/**
 * Constructs every SQLite-backed repository and store. The composition root
 * never instantiates persistence classes directly (composition contract test).
 */
export function wirePersistence(input: {
  clock: Clock;
  database: RuntimeDatabase;
  pid: string;
  userDataDirectory: string;
}) {
  const { clock, database, pid, userDataDirectory } = input;
  return {
    dispatchClaims: new SqlitePartnerDispatchClaims(database),
    joiHarnessRepository: new SqliteJoiHarnessRepository(database),
    joiHomeFeedRepository: new SqliteJoiHomeFeedRepository(database),
    joiInboxRepository: new SqliteJoiInboxRepository(database),
    modelSourceRepository: new SqliteModelSourceRepository(database),
    partnerInstanceMessageStore: new SqlitePartnerInstanceMessageStore(database),
    partnerInstanceRepository: new SqlitePartnerInstanceRepository(database),
    partnerKnowledgeStore: new SqlitePartnerKnowledgeStore(database),
    partnerPromptStore: new SqlitePartnerPromptStore(database),
    partnerRegistryRepository: new SqlitePartnerRegistryRepository(database),
    scenarioPackRepository: new SqliteScenarioPackRepository(database),
    partnerWorkMemoryStore: new SqlitePartnerWorkMemoryStore(database),
    piCredentialRepository: new SqlitePiCredentialRepository(database),
    piReasoningSessionStore: new SqlitePiReasoningSessionStore(database),
    policyGate: new SqliteDispatchPolicyGate({ clock, database }),
    workbenchAgentRepository: new SqliteWorkbenchAgentRepository(database),
    workbenchAgentScan: new SqliteWorkbenchAgentScan(database),
    workbenchChangeRepository: new SqliteWorkbenchChangeRepository(database),
    workbenchContextRepository: new SqliteWorkbenchContextRepository(database),
    workbenchManagementRepository: new SqliteWorkbenchManagementRepository(database),
    workbenchWorkspaceProvisioner: new WorkbenchWorkspaceProvisioner({ database, userDataDirectory }),
    workbenchWorkspaceRepository: new SqliteWorkbenchWorkspaceRepository(database),
    workbenches: new LegacyLifeStoreAdapter(database),
    workPlanRepository: new SqliteWorkPlanRepository(database),
    workResultRepository: new SqliteWorkResultRepository(database),
    workspaceLeases: new SqliteWorkspaceLeaseManager({ clock, database, owner: `partner_${pid}` }),
  };
}

export type PersistenceBundle = ReturnType<typeof wirePersistence>;
