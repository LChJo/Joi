import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MessageChannel, Worker } from "node:worker_threads";
import { WorkerHomeFeedRepository } from "../../src/main/infrastructure/persistence/worker-home-feed-repository";
import { WorkerRpc } from "../../src/main/infrastructure/runtime/worker-rpc";
import { DomainError } from "../../src/main/domain/errors";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";
import { compileWorkerFixture } from "../support/compile-worker-fixture";

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

  it("reads committed WAL snapshots while a writer holds an uncommitted transaction", async () => {
    const databasePath = path.join(directory, "wal.sqlite");
    const database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    const writer = new DatabaseSync(databasePath);
    const reader = new WorkerHomeFeedRepository(databasePath, readWorkerUrl);
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare("INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,created_at,updated_at) VALUES ('goal','goal','synthetic','PENDING',?,?)")
        .run("2026-10-13T00:00:00.000Z", "2026-10-13T00:00:00.000Z");
      expect((await reader.load(new Date())).goals).toHaveLength(0);
      writer.exec("COMMIT");
      expect((await reader.load(new Date())).goals).toHaveLength(1);
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
});
