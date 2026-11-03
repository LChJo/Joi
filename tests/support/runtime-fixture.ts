import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRuntimeDatabaseFixture } from "./runtime-database-fixture";

import { AgentService } from "../../src/main/application/agents/agent-service";
import { AuthService } from "../../src/main/application/auth/auth-service";
import { LifeService } from "../../src/main/application/lives/life-service";
import { OperationsService } from "../../src/main/application/operations/operations-service";
import { PartnerEngineCatalog } from "../../src/main/application/partners/partner-engine-catalog";
import { WorkbenchRegistryService } from "../../src/main/application/joi/workbench-registry-service";
import { WorkbenchManagementService } from "../../src/main/application/joi/workbench-management-service";
import { WorkbenchWorkspaceService } from "../../src/main/application/joi/workbench-workspace-service";
import { JoiHomeFeedService } from "../../src/main/application/joi/joi-home-feed-service";
import { WorkbenchAgentService } from "../../src/main/application/partners/workbench-agent-service";
import { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager";
import { PartnerKnowledgeService } from "../../src/main/application/partners/partner-knowledge-service";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service";
import { ScenarioPackService } from "../../src/main/application/partners/scenario-pack-service";
import { PartnerWorkMemoryService } from "../../src/main/application/partners/partner-work-memory-service";
import type { SsePublisher } from "../../src/main/application/ports/runtime-store";
import type { WorkbenchArtifactOpenMode } from "../../src/main/application/ports/workbench-artifacts";
import type { RuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";
import { SqlitePartnerInstanceMessageStore } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-message-store";
import { SqlitePartnerInstanceRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-repository";
import { SqlitePartnerKnowledgeStore } from "../../src/main/infrastructure/persistence/sqlite-partner-knowledge-store";
import { SqlitePartnerPromptStore } from "../../src/main/infrastructure/persistence/sqlite-partner-prompt-store";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository";
import { SqliteScenarioPackRepository } from "../../src/main/infrastructure/persistence/sqlite-scenario-pack-repository";
import { SqlitePartnerWorkMemoryStore } from "../../src/main/infrastructure/persistence/sqlite-partner-work-memory-store";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter";
import { SqliteWorkbenchManagementRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-management-repository";
import { SqliteWorkbenchWorkspaceRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-workspace-repository";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository";
import {
  InMemoryBootstrapNonceStore,
  LoginRateLimiter,
  NodeSecurityPrimitives,
} from "../../src/main/infrastructure/security/security-services";
import { LocalSkillScanner } from "../../src/main/infrastructure/skills/local-skill-scanner";

export class TestClock {
  private current: Date;

  constructor(initial = "2026-07-15T12:00:00.000Z") {
    this.current = new Date(initial);
  }

  advance(milliseconds: number) {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  now = () => new Date(this.current);
}

export class TestIds {
  private sequence = 0;

  next = (prefix: string) => `${prefix}_test_${String(++this.sequence).padStart(4, "0")}`;
}

export interface RuntimeFixture {
  artifactOpenCalls: { kind: "DIRECTORY" | "FILE"; mode: WorkbenchArtifactOpenMode; targetPath: string }[];
  agents: AgentService;
  auth: AuthService;
  workbenchManagement: WorkbenchManagementService;
  workbenchAgents: WorkbenchAgentService;
  workbenchRegistry: WorkbenchRegistryService;
  workbenchWorkspaces: WorkbenchWorkspaceService;
  workbenches: LegacyLifeStoreAdapter;
  clock: TestClock;
  close(): Promise<void>;
  database: RuntimeDatabase;
  engines: PartnerEngineCatalog;
  ids: TestIds;
  instances: PartnerInstanceManager;
  joiHomeFeed: JoiHomeFeedService;
  knowledge: PartnerKnowledgeService;
  lives: LifeService;
  memory: PartnerWorkMemoryService;
  operations: OperationsService;
  partners: PartnerRegistryService;
  scenarioPacks: ScenarioPackService;
  root: string;
  skills: LocalSkillScanner;
  directoryPicker: () => Promise<string | null>;
  sse: SsePublisher;
}

export async function createRuntimeFixture(): Promise<RuntimeFixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joi-runtime-")));
  const databasePath = path.join(root, "runtime.sqlite");
  const database = await openRuntimeDatabaseFixture(databasePath);
  const clock = new TestClock();
  const ids = new TestIds();
  // SSE transport retired (ADR 0009); fixture keeps a no-op publisher for legacy service ports.
  const sse: SsePublisher = { publish: () => undefined };
  const workbenches = new LegacyLifeStoreAdapter(database);
  const workbenchRegistry = new WorkbenchRegistryService({ clock, ids, repository: workbenches });
  const workbenchManagement = new WorkbenchManagementService({ clock, ids, repository: new SqliteWorkbenchManagementRepository(database) });
  const artifactOpenCalls: RuntimeFixture["artifactOpenCalls"] = [];
  const workbenchAgents = new WorkbenchAgentService({
    clock,
    opener: { open: (input) => { artifactOpenCalls.push(input); return Promise.resolve(); } },
    repository: new SqliteWorkbenchAgentRepository(database),
  });
  const joiHomeFeed = new JoiHomeFeedService({ clock, repository: new SqliteJoiHomeFeedRepository(database) });
  const workbenchWorkspaces = new WorkbenchWorkspaceService({ workbenches, clock, ids, repository: new SqliteWorkbenchWorkspaceRepository(database) });
  const lives = new LifeService({ clock, ids, publisher: sse, store: database.store });
  const agents = new AgentService({ clock, ids, store: database.store });
  const auth = new AuthService({
    clock,
    nonces: new InMemoryBootstrapNonceStore(),
    rateLimiter: new LoginRateLimiter(clock),
    security: new NodeSecurityPrimitives({ scryptCost: 1024 }),
    store: database.store,
  });
  const operations = new OperationsService({ clock, store: database.store });
  const knowledge = new PartnerKnowledgeService({ clock, ids, store: new SqlitePartnerKnowledgeStore(database) });
  const partnerRepository = new SqlitePartnerRegistryRepository(database);
  const skills = new LocalSkillScanner();
  const partners = new PartnerRegistryService({
    clock,
    ids,
    knowledge,
    prompts: new SqlitePartnerPromptStore(database),
    repository: partnerRepository,
  });
  const scenarioPacks = new ScenarioPackService({ clock, ids, partners, repository: new SqliteScenarioPackRepository(database), skills });
  const instances = new PartnerInstanceManager({
    clock,
    engines: new Map(),
    ids,
    knowledge,
    messages: new SqlitePartnerInstanceMessageStore(database),
    registry: partners,
    repository: new SqlitePartnerInstanceRepository(database),
    revisions: partnerRepository,
    skills,
  });
  const memory = new PartnerWorkMemoryService({ clock, ids, store: new SqlitePartnerWorkMemoryStore(database) });
  const engines = new PartnerEngineCatalog(new Map());

  return {
    artifactOpenCalls,
    agents,
    auth,
    workbenchManagement,
    workbenchAgents,
    workbenchRegistry,
    workbenchWorkspaces,
    workbenches,
    clock,
    async close() {
      database.close();
      await rm(root, { force: true, recursive: true });
    },
    database,
    engines,
    ids,
    instances,
    joiHomeFeed,
    knowledge,
    lives,
    memory,
    operations,
    partners,
    scenarioPacks,
    root,
    skills,
    directoryPicker: () => Promise.resolve("/stub/workdir"),
    sse,
  };
}
