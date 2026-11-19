import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker } from "node:worker_threads";
import { WorkerHomeFeedRepository } from "../../src/main/infrastructure/persistence/worker-home-feed-repository";
import { WorkerRpc } from "../../src/main/infrastructure/runtime/worker-rpc";
import { DomainError } from "../../src/main/domain/errors";
import { compileWorkerFixture } from "../support/compile-worker-fixture";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture";
import { createRuntimeFixture } from "../support/runtime-fixture.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { SqliteWorkbenchAgentRepository } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-repository.js";
import { WorkbenchAgentService } from "../../src/main/application/partners/workbench-agent-service.js";
import { JoiHomeFeedService } from "../../src/main/application/joi/joi-home-feed-service.js";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import type { JoiGoalDetailDto, WorkbenchAgentCardDto } from "../../src/shared/joi.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

const LARGE_GOAL_SIZE = 1_001;
const HISTORY_SIZE = 50_000;

async function seedLargeGoal(fixture: Awaited<ReturnType<typeof createRuntimeFixture>>) {
  const bench = await fixture.workbenchRegistry.create({ name: "Fixture", personaSummary: "fixture", projectLabel: "fixture", scopeSummary: "fixture" });
  const partner = await fixture.partners.add({ capabilities: [], displayName: "Fixture", kind: "local-pi", skills: [], tools: [] });
  const now = fixture.clock.now().toISOString();
  const newer = new Date(fixture.clock.now().getTime() + 1_000).toISOString();
  const benchId = bench.workbenchId;
  fixture.database.transaction(db => {
    for (const goal of ["target", "history"]) {
      db.prepare(`INSERT INTO joi_inbox_messages (input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES (?,?,'Fixture','CONSUMED',?,?,?)`).run(goal, goal, benchId, now, now);
      db.prepare(`INSERT INTO joi_turns (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
        VALUES (?,?,?,?,'COMPLETED',?,?)`).run(`turn-${goal}`, goal, benchId, `session-${goal}`, now, now);
      db.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at)
        VALUES (?,?,'{}','{}',?)`).run(`plan-${goal}`, `turn-${goal}`, now);
    }
    db.prepare(`INSERT INTO joi_harness_maps (goal_input_id,workbench_id,created_at,updated_at) VALUES ('target',?,?,?)`).run(benchId, now, now);
    db.exec("CREATE TEMP TABLE agent_fixture (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, goal TEXT NOT NULL, stamp TEXT NOT NULL)");
    db.prepare(`INSERT INTO agent_fixture WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
      SELECT n,printf('%05d',n),CASE WHEN n<=? THEN 'target' ELSE 'history' END,CASE WHEN n<=? THEN ? ELSE ? END FROM sequence`)
      .run(LARGE_GOAL_SIZE + HISTORY_SIZE, LARGE_GOAL_SIZE, LARGE_GOAL_SIZE, now, newer);
    db.prepare(`INSERT INTO work_items (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
      SELECT 'work-'||id,?,goal,'Fixture','{}','READ','COMPLETED',stamp,stamp FROM agent_fixture`).run(benchId);
    db.prepare(`INSERT INTO partner_instances (instance_id,workbench_id,partner_id,partner_revision_id,session_policy,status,created_at,last_used_at)
      SELECT 'agent-'||id,?,?,?,'EPHEMERAL','DISPOSED',stamp,stamp FROM agent_fixture`).run(benchId, partner.partnerId, partner.partnerRevisionId);
    db.prepare(`INSERT INTO workbench_agent_sessions (agent_id,workbench_id,partner_id,partner_revision_id,backing_kind,backing_id,session_policy,created_at)
      SELECT 'agent-'||id,?,?,?,'LOCAL_INSTANCE','agent-'||id,'EPHEMERAL',stamp FROM agent_fixture`).run(benchId, partner.partnerId, partner.partnerRevisionId);
    db.prepare(`INSERT INTO dispatch_attempts (dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,instance_id,status,created_at,updated_at)
      SELECT 'attempt-'||id,'plan-'||goal,'work-'||id,?,1,'action-'||id,'agent-'||id,'COMPLETED',stamp,stamp FROM agent_fixture`).run(partner.partnerRevisionId);
    db.prepare(`INSERT INTO partner_runs (run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at)
      SELECT 'run-'||id,'attempt-'||id,'action-'||id,?,'work-'||id,?,'LOCAL_PI','external-'||id,'COMPLETED',stamp,stamp FROM agent_fixture`)
      .run(benchId, partner.partnerRevisionId);
    db.exec(`INSERT INTO joi_harness_paths (path_id,goal_input_id,layer,title,status,work_id,created_at,updated_at)
      SELECT 'path-'||id,goal,seq%32+1,'Fixture','CLOSED','work-'||id,stamp,stamp FROM agent_fixture WHERE goal='target';
      DROP TABLE agent_fixture;`);
  });
  return benchId;
}

function p95(values: number[]): number {
  return values.toSorted((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1] ?? 0;
}

describe("runtime Workers (AC-PERF-01)", () => {
  let directory: string;
  let readWorkerUrl: URL;
  let rpcUrl: URL;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "joi-worker-test-"));
    [readWorkerUrl, rpcUrl] = await compileWorkerFixture(path.join(directory, "modules"), [
      "src/main/infrastructure/persistence/home-feed-read-worker.ts",
      "src/main/infrastructure/runtime/worker-rpc.ts",
    ]) as [URL, URL];
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("serves a large goal and its history over HTTP during concurrent status writes", async () => {
    const fixture = await createRuntimeFixture();
    const reader = new WorkerHomeFeedRepository(path.join(fixture.root, "runtime.sqlite"), readWorkerUrl);
    const listeners = await startRuntimeListeners({ loopbackPort: 0, handler: createApiHandler({
      ...fixture,
      workbenchAgents: new WorkbenchAgentService({ clock: fixture.clock, repository: new SqliteWorkbenchAgentRepository(fixture.database), listRepository: reader }),
      joiHomeFeed: new JoiHomeFeedService({ clock: fixture.clock, repository: reader }),
    }) });
    const origin = listeners.loopback.url;
    let writer: ReturnType<typeof setInterval> | undefined;
    try {
      const bench = await seedLargeGoal(fixture);
      async function authenticate() {
        const bootstrap = await fixture.auth.issueDesktopBootstrap();
        const response = await fetch(`${origin}/api/v1/auth/bootstrap`, {
          method: "POST", headers: { "content-type": "application/json", origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }),
        });
        expect(response.status).toBe(200);
        const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        return { cookie };
      }
      const clientA = await authenticate();
      const clientB = await authenticate();
      const agentsUrl = `${origin}/api/v1/workbenches/${bench}/agents?goalId=target`;
      const detailUrl = `${origin}/api/v1/joi/goals/target/detail`;
      interface AgentPage { items: WorkbenchAgentCardDto[]; nextCursor?: string }
      const readAgents = async (headers: { cookie: string }, cursor?: string, limit = 100) => {
        const url = `${agentsUrl}&limit=${String(limit)}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
        const received = await fetch(url, { headers });
        expect(received.status).toBe(200);
        return await received.json() as AgentPage;
      };
      await readAgents(clientA);
      let writes = 0;
      writer = setInterval(() => {
        fixture.database.transaction(db => db.prepare("UPDATE work_items SET status=? WHERE work_id='work-00001'")
          .run(writes++ % 2 === 0 ? "RUNNING" : "COMPLETED"));
      }, 25);
      const agentTimes: number[] = [];
      const healthTimes: number[] = [];
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        const load = async (headers: { cookie: string }) => {
          const page = await readAgents(headers);
          agentTimes.push(performance.now() - started);
          return page.items.map(item => item.agentId);
        };
        const health = async () => {
          const response = await fetch(`${origin}/api/v1/health`);
          expect(response.status).toBe(200);
          await response.arrayBuffer();
          healthTimes.push(performance.now() - started);
        };
        const readSummary = async () => {
          const response = await fetch(`${detailUrl}?view=summary`, { headers: clientB });
          expect(response.status).toBe(200);
          const detail = await response.json() as JoiGoalDetailDto;
          expect(detail.harness?.paths).toEqual([]);
          expect(detail.harness?.progress?.work.total).toBe(LARGE_GOAL_SIZE);
        };
        const [left, right] = await Promise.all([load(clientA), load(clientB), health(), readSummary()]);
        expect(left).toHaveLength(100);
        expect(right).toEqual(left);
      }
      const agentP95 = p95(agentTimes);
      const healthP95 = p95(healthTimes);
      console.info(`Large-goal HTTP P95: Agent page ${agentP95.toFixed(1)} ms, health ${healthP95.toFixed(1)} ms`);
      expect(agentP95, "Agent first-page HTTP p95").toBeLessThanOrEqual(500);
      expect(healthP95, "health HTTP p95").toBeLessThanOrEqual(100);
      expect(writes).toBeGreaterThan(0);

      const agents = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await readAgents(clientA, cursor, 40);
        for (const item of page.items) {
          expect(agents.has(item.agentId)).toBe(false);
          agents.add(item.agentId);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined && agents.size <= LARGE_GOAL_SIZE);
      expect(agents.size).toBe(100);

      const paths = new Set<string>();
      let offset: number | undefined = 0;
      do {
        const response = await fetch(`${detailUrl}?view=map&limit=100&offset=${String(offset)}`, { headers: clientB });
        expect(response.status).toBe(200);
        const page = await response.json() as JoiGoalDetailDto;
        for (const item of page.harness?.paths ?? []) paths.add(item.pathId);
        offset = page.nextOffset;
      } while (offset !== undefined && offset < LARGE_GOAL_SIZE);
      expect(paths.size).toBe(LARGE_GOAL_SIZE);
    } finally { clearInterval(writer); await listeners.close(); await reader.close(); await fixture.close(); }
  }, 30_000);

  it("coalesces identical Agent page reads and sees only committed session changes", async () => {
    const fixture = await createRuntimeFixture();
    const databasePath = path.join(fixture.root, "runtime.sqlite");
    const writer = new DatabaseSync(databasePath);
    const reader = new WorkerHomeFeedRepository(databasePath, readWorkerUrl);
    try {
      const bench = await fixture.workbenchRegistry.create({ name: "Fixture", personaSummary: "fixture", projectLabel: "fixture", scopeSummary: "fixture" });
      const partner = await fixture.partners.add({ capabilities: [], displayName: "Fixture", kind: "local-pi", skills: [], tools: [] });
      const agent = await fixture.instances.ensure({ workbenchId: bench.workbenchId, partnerId: partner.partnerId, sessionPolicy: "EPHEMERAL" });
      const input = { workbenchId: bench.workbenchId, limit: 50 };
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE workbench_agent_sessions SET dismissed_at=? WHERE agent_id=?").run(fixture.clock.now().toISOString(), agent.instanceId);
      const first = reader.listAgents(input);
      expect(reader.listAgents({ ...input })).toBe(first);
      expect((await first).items.map(item => item.agentId)).toEqual([agent.instanceId]);
      writer.exec("COMMIT");
      expect(await reader.listAgents(input)).toEqual({ items: [] });
    } finally {
      if (writer.isTransaction) writer.exec("ROLLBACK");
      await reader.close(); writer.close(); await fixture.close();
    }
  });

  it("reads an unmigrated legacy question without writing, then sees its committed canonical record", async () => {
    const fixture = await createRuntimeFixture();
    const reader = new WorkerHomeFeedRepository(path.join(fixture.root, "runtime.sqlite"), readWorkerUrl);
    try {
      const bench = await fixture.workbenchRegistry.create({ name: "Fixture", personaSummary: "fixture", projectLabel: "fixture", scopeSummary: "fixture" });
      const now = fixture.clock.now();
      fixture.database.transaction(db => db.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,clarification_reason_code,clarification_prompt,created_at,updated_at)
        VALUES ('legacy','legacy','Fixture','CLARIFICATION_REQUIRED',?,'question_required','Fixture question',?,?)`)
        .run(bench.workbenchId, now.toISOString(), now.toISOString()));
      const readGoal = async () => (await reader.load(now)).goals.find(goal => goal.goalId === "legacy");
      expect(await readGoal()).toMatchObject({ clarification: { questionId: "legacy_question:legacy" } });
      expect(fixture.database.transaction(db => db.prepare("SELECT COUNT(*) AS count FROM user_questions").get())).toEqual({ count: 0 });
      await new SqliteJoiInboxRepository(fixture.database, fixture.clock).recoverOnBoot();
      expect(await readGoal()).toMatchObject({ questions: [{ questionId: "legacy_question:legacy", status: "ACTIVE" }] });
    } finally { await reader.close(); await fixture.close(); }
  });

  it("keeps cached artifact previews on their committed WAL snapshot across manifest writes", async () => {
    const fixture = await createGoalEvidenceFixture([{}]);
    const manifest = (name: string) => JSON.stringify([{ artifactRef: `workspace:${name}`, name, mimeType: "text/plain", size: 1 }]);
    fixture.database.transaction(db => db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(manifest("before.txt")));
    await fixture.inbox.completeInput(fixture.inputId, "synthesis-turn", { outcome: "RESULT_SYNTHESIZED", completionSummary: "Synthetic result", committedByTool: true });
    const databasePath = path.join(fixture.root, "runtime.sqlite");
    const writer = new DatabaseSync(databasePath);
    const reader = new WorkerHomeFeedRepository(databasePath, readWorkerUrl);
    const preview = async () => (await reader.load(new Date())).goals.find(goal => goal.goalId === "goal")?.artifacts?.[0];
    try {
      expect(await preview()).toMatchObject({ artifactId: "work_result_artifact:result-1:0", name: "before.txt" });
      expect(await preview()).toMatchObject({ name: "before.txt" });
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(manifest("within.txt"));
      expect(await preview()).toMatchObject({ name: "before.txt" });
      writer.exec("ROLLBACK");
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(manifest("commit.txt"));
      expect(await preview()).toMatchObject({ name: "before.txt" });
      writer.exec("COMMIT");
      expect(await preview()).toMatchObject({ artifactId: "work_result_artifact:result-1:0", name: "commit.txt" });
      writer.prepare("UPDATE work_results SET is_authoritative=0 WHERE result_id='result-1'").run();
      expect(await preview()).toBeUndefined();
    } finally {
      if (writer.isTransaction) writer.exec("ROLLBACK");
      await reader.close(); writer.close(); await fixture.close();
    }
  });

  it("reads committed WAL snapshots while a writer holds an uncommitted transaction", async () => {
    const databasePath = path.join(directory, "wal.sqlite");
    const database = await openRuntimeDatabaseFixture(databasePath);
    const writer = new DatabaseSync(databasePath);
    const reader = new WorkerHomeFeedRepository(databasePath, readWorkerUrl);
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,created_at,updated_at) VALUES ('goal','goal','synthetic','PENDING',?,?)")
        .run("2026-10-13T00:00:00.000Z", "2026-10-13T00:00:00.000Z");
      expect((await reader.load(new Date())).goals).toHaveLength(0);
      expect(await reader.loadGoalDetail("goal", {})).toBeNull();
      writer.exec("COMMIT");
      expect((await reader.load(new Date())).goals).toHaveLength(1);
      expect(await reader.loadGoalDetail("goal", {})).toEqual({ goalId: "goal", fullTitle: "synthetic" });
      writer.exec("BEGIN IMMEDIATE");
      const resultId = "a".repeat(32);
      writer.prepare(`INSERT INTO joi_goal_result_history(result_id,goal_input_id,source_key,completed_at,status,body)
        VALUES (?,'goal','synthetic-completion','2026-10-13T00:00:00.000Z','COMPLETED','# Frozen result')`).run(resultId);
      expect((await reader.listGoalResults("goal", {}))?.items).toEqual([]);
      expect(await reader.getGoalResult("goal", resultId)).toBeNull();
      writer.exec("COMMIT");
      expect((await reader.listGoalResults("goal", {}))?.items).toEqual([
        { resultId, completedAt: "2026-10-13T00:00:00.000Z", status: "COMPLETED" },
      ]);
      expect(await reader.getGoalResult("goal", resultId)).toMatchObject({ resultId, body: "# Frozen result" });
      expect(await reader.listGoalArtifacts("goal", {})).toEqual({ items: [] });
      expect(await reader.listGoalArtifacts("missing", {})).toBeNull();
      await expect(reader.listGoalArtifacts("goal", { limit: 0 })).rejects.toMatchObject({ code: "goal_artifact_page_invalid" });
      await expect(reader.listGoalResults("goal", { limit: 0 })).rejects.toMatchObject({ code: "goal_result_page_invalid" });
      const pending = reader.load(new Date());
      await reader.close();
      await expect(pending).resolves.toMatchObject({ goals: [expect.objectContaining({ goalId: "goal" })] });
      await expect(reader.load(new Date())).rejects.toThrow("runtime_worker_closed");
    } finally {
      if (writer.isTransaction) writer.exec("ROLLBACK");
      await reader.close(); writer.close(); database.close();
    }
  });

  it("keeps the caller responsive during Worker CPU work and rejects requests after a crash", async () => {
    const fixture = path.join(directory, "busy-worker.mjs");
    await writeFile(fixture, `import { workerData } from 'node:worker_threads';
      import { WorkerRpc } from ${JSON.stringify(rpcUrl.href)};
      new WorkerRpc(workerData.port, {
        busy: () => { const end = Date.now() + 200; while (Date.now() < end) {} return 'done'; },
        crash: () => process.exit(7),
      });`);
    const { port1, port2 } = new MessageChannel();
    const rpc = new WorkerRpc(port1);
    const worker = new Worker(fixture, { workerData: { port: port2 }, transferList: [port2] });
    worker.on("exit", () => rpc.close());
    let pulses = 0;
    const timer = setInterval(() => { pulses += 1; }, 10);
    try {
      expect(await rpc.call("busy")).toBe("done");
      expect(pulses).toBeGreaterThan(5);
      await expect(rpc.call("crash")).rejects.toThrow("runtime_worker_closed");
    } finally { clearInterval(timer); rpc.close(); await worker.terminate(); }
  });

  it("preserves safe domain codes and removes private error messages from the command channel", async () => {
    const { port1, port2 } = new MessageChannel();
    const client = new WorkerRpc(port1);
    const server = new WorkerRpc(port2, {
      conflict: () => { throw new DomainError("work_conflict", "private synthetic text"); },
      broken: () => { throw new Error("private synthetic path and SQL"); },
    });
    try {
      await expect(client.call("conflict")).rejects.toMatchObject({ code: "work_conflict", message: "work_conflict" });
      await expect(client.call("broken")).rejects.toThrow("runtime_worker_command_failed");
      await expect(client.call("constructor")).rejects.toThrow("runtime_worker_command_failed");
    } finally { client.close(); server.close(); }
  });

  it("REL-11 bounds a hung control request and ignores its late reply without corrupting later calls",async () => {
    const { port1,port2 } = new MessageChannel();let release: ((value: string) => void) | undefined;
    const client = new WorkerRpc(port1),server = new WorkerRpc(port2,{
      hang: () => new Promise<string>(resolve => { release = resolve; }),echo: value => value,
    });
    try {
      await expect(client.callWithTimeout("hang",25)).rejects.toMatchObject({ code: "runtime_worker_timed_out" });
      await vi.waitFor(() => expect(release).toBeDefined());release?.("PRIVATE_LATE_RESULT");
      await expect(client.call("echo","current")).resolves.toBe("current");
    } finally { client.close();server.close(); }
  });
});
