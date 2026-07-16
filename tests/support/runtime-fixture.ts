import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentService } from "../../src/main/application/agents/agent-service";
import { AuthService } from "../../src/main/application/auth/auth-service";
import { LifeService } from "../../src/main/application/lives/life-service";
import { OperationsService } from "../../src/main/application/operations/operations-service";
import { SseService } from "../../src/main/application/sse/sse-service";
import { InMemorySseBroker } from "../../src/main/infrastructure/http/in-memory-sse-broker";
import { openRuntimeDatabase, type RuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";
import {
  InMemoryBootstrapNonceStore,
  LoginRateLimiter,
  NodeSecurityPrimitives,
} from "../../src/main/infrastructure/security/security-services";

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
  broker: InMemorySseBroker;
  clock: TestClock;
  close(): Promise<void>;
  database: RuntimeDatabase;
  ids: TestIds;
  lives: LifeService;
  operations: OperationsService;
  root: string;
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

  return {
    agents,
    auth,
    broker,
    clock,
    async close() {
      database.close();
      await rm(root, { force: true, recursive: true });
    },
    database,
    ids,
    lives,
    operations,
    root,
    sse,
  };
}
