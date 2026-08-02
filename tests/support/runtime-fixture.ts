import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentService } from "../../src/main/application/agents/agent-service";
import { AuthService } from "../../src/main/application/auth/auth-service";
import { LifeService } from "../../src/main/application/lives/life-service";
import { OperationsService } from "../../src/main/application/operations/operations-service";
import { PartnerEngineCatalog } from "../../src/main/application/partners/partner-engine-catalog";
import { AvatarRegistryService } from "../../src/main/application/joi/avatar-registry-service";
import { AvatarManagementService } from "../../src/main/application/joi/avatar-management-service";
import { AvatarWorkspaceService } from "../../src/main/application/joi/avatar-workspace-service";
import { PartnerInstanceManager } from "../../src/main/application/partners/partner-instance-manager";
import { PartnerKnowledgeService } from "../../src/main/application/partners/partner-knowledge-service";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service";
import { PartnerWorkMemoryService } from "../../src/main/application/partners/partner-work-memory-service";
import { SseService } from "../../src/main/application/sse/sse-service";
import { InMemorySseBroker } from "../../src/main/infrastructure/http/in-memory-sse-broker";
import { openRuntimeDatabase, type RuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";
import { SqlitePartnerInstanceMessageStore } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-message-store";
import { SqlitePartnerInstanceRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-repository";
import { SqlitePartnerKnowledgeStore } from "../../src/main/infrastructure/persistence/sqlite-partner-knowledge-store";
import { SqlitePartnerPromptStore } from "../../src/main/infrastructure/persistence/sqlite-partner-prompt-store";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository";
import { SqlitePartnerWorkMemoryStore } from "../../src/main/infrastructure/persistence/sqlite-partner-work-memory-store";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter";
import { SqliteAvatarManagementRepository } from "../../src/main/infrastructure/persistence/sqlite-avatar-management-repository";
import { SqliteAvatarWorkspaceRepository } from "../../src/main/infrastructure/persistence/sqlite-avatar-workspace-repository";
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
  agents: AgentService;
  auth: AuthService;
  avatarManagement: AvatarManagementService;
  avatarRegistry: AvatarRegistryService;
  avatarWorkspaces: AvatarWorkspaceService;
  avatars: LegacyLifeStoreAdapter;
  broker: InMemorySseBroker;
  clock: TestClock;
  close(): Promise<void>;
  database: RuntimeDatabase;
  engines: PartnerEngineCatalog;
  ids: TestIds;
  instances: PartnerInstanceManager;
  knowledge: PartnerKnowledgeService;
  lives: LifeService;
  memory: PartnerWorkMemoryService;
  operations: OperationsService;
  partners: PartnerRegistryService;
  root: string;
  skills: LocalSkillScanner;
  directoryPicker: () => Promise<string | null>;
  sse: SseService;
}

export async function createRuntimeFixture(): Promise<RuntimeFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "joi-runtime-"));
  const database = await openRuntimeDatabase({
    databasePath: path.join(root, "runtime.sqlite"),
    migrationsDirectory: path.resolve("resources/migrations"),
  });
  const clock = new TestClock();
  const ids = new TestIds();
  const broker = new InMemorySseBroker();
  const sse = new SseService({ broker, clock, store: database.store });
  const avatars = new LegacyLifeStoreAdapter(database);
  const avatarRegistry = new AvatarRegistryService({ clock, ids, repository: avatars });
  const avatarManagement = new AvatarManagementService({ clock, ids, repository: new SqliteAvatarManagementRepository(database) });
  const avatarWorkspaces = new AvatarWorkspaceService({ avatars, clock, ids, repository: new SqliteAvatarWorkspaceRepository(database) });
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
  const partners = new PartnerRegistryService({
    clock,
    ids,
    knowledge,
    prompts: new SqlitePartnerPromptStore(database),
    repository: partnerRepository,
  });
  const skills = new LocalSkillScanner();
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
    agents,
    auth,
    avatarManagement,
    avatarRegistry,
    avatarWorkspaces,
    avatars,
    broker,
    clock,
    async close() {
      database.close();
      await rm(root, { force: true, recursive: true });
    },
    database,
    engines,
    ids,
    instances,
    knowledge,
    lives,
    memory,
    operations,
    partners,
    root,
    skills,
    directoryPicker: () => Promise.resolve("/stub/workdir"),
    sse,
  };
}
