import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { PartnerWorkMemoryService } from "../../src/main/application/partners/partner-work-memory-service.js";
import { PARTNER_MEMORY_REFRESH_KIND } from "../../src/main/application/ports/partner-memory.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqlitePartnerWorkMemoryStore } from "../../src/main/infrastructure/persistence/sqlite-partner-work-memory-store.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

describe("SQLite partner work memory store", () => {
  it("upgrades a bounded legacy ledger with a conservative coverage baseline and stable receipts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-memory-upgrade-"));
    const legacyMigrations = path.join(root, "migrations");
    await mkdir(legacyMigrations);
    for (const filename of await readdir(path.resolve("resources/migrations"))) {
      if (/^\d+_.+\.sql$/u.test(filename) && filename.localeCompare("078_") < 0) {
        await copyFile(path.resolve("resources/migrations", filename), path.join(legacyMigrations, filename));
      }
    }
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: legacyMigrations });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench_legacy', 'A', 'persona_legacy', 'persona', 'scope', 'project', 'memory_legacy', 'ACTIVE', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run());
      const registry = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const partner = await registry.add({ capabilities: [], displayName: "Legacy", kind: "local-pi", skills: [], tools: [] });
      for (let index = 0; index < 10; index += 1) {
        database.transaction((connection) => connection.prepare(`INSERT INTO workbench_partner_work_memories
          (memory_id, workbench_id, partner_id, session_data_source, outcome, title, created_at) VALUES (?, 'workbench_legacy', ?, ?, 'COMPLETED', ?, ?)`)
          .run(`legacy_${String(index)}`, partner.partnerId, `legacy:${String(index)}`, `legacy ${String(index)}`, `2026-07-29T10:0${String(index)}:00.000Z`));
      }
      database.transaction((connection) => connection.prepare(`INSERT INTO workbench_partner_work_memory_summaries
        (workbench_id, partner_id, summary, entry_count, updated_at) VALUES ('workbench_legacy', ?, 'legacy summary', 8, '2026-07-29T10:07:00.000Z')`).run(partner.partnerId));
      database.close();
      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      expect(database.inspect().mode).toBe("read-write");
      const store = new SqlitePartnerWorkMemoryStore(database);
      expect(await store.loadSummary("workbench_legacy", partner.partnerId)).toMatchObject({ coveredSequence: 7, summary: "legacy summary" });
      const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store });
      await service.recordResult({ workbenchId: "workbench_legacy", partnerId: partner.partnerId, outcome: "COMPLETED", at: "2026-07-29T11:00:00.000Z",
        sessionDataSource: "legacy:0", title: "duplicate old result" });
      expect(await store.listEntries("workbench_legacy", partner.partnerId, 100)).toHaveLength(10);
      for (let index = 11; index <= 16; index += 1) {
        await service.recordResult({ workbenchId: "workbench_legacy", partnerId: partner.partnerId, resultId: `result_${String(index)}`, outcome: "COMPLETED",
          at: "2026-07-29T11:00:00.000Z", sessionDataSource: "shared_session", title: `new ${String(index)}` });
      }
      expect((await store.listEntries("workbench_legacy", partner.partnerId, 1))[0]?.title).toBe("new 16");
      const pending = await store.loadNextRefresh("workbench_legacy", partner.partnerId, 16);
      expect(pending?.sequence).toBe(16);
      expect(pending?.entries.map((entry) => entry.title)).toEqual(["new 16", "new 15", "new 14", "new 13", "new 12", "new 11", "legacy 9", "legacy 8", "legacy 7"]);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  }, process.env.CI ? 60_000 : 5_000);

  it("commits cumulative cadence, durable deduplication, bounded snapshots and monotonic summary coverage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-work-memory-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const database = await openRuntimeDatabaseFixture(databasePath);
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench_test', 'A', 'persona_test', 'persona', 'scope', 'project', 'memory_test', 'ACTIVE', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run());
      const partners = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const partner = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
      const store = new SqlitePartnerWorkMemoryStore(database);

      for (let index = 0; index < 40; index += 1) {
        await store.recordResult({
          workbenchId: "workbench_test",
          createdAt: `2026-07-29T10:${String(index).padStart(2, "0")}:00.000Z`,
          memoryId: `memory_${String(index)}`,
          outcome: index % 5 === 4 ? "FAILED" : "COMPLETED",
          partnerId: partner.partnerId,
          sessionDataSource: `local_pi:action_${String(index)}`,
          title: `task ${String(index)}`,
        }, { entryLimit: 32, resultKey: `result_${String(index)}`, summaryCadence: 8 });
      }
      expect(await store.listEntries("workbench_test", partner.partnerId, 100)).toHaveLength(32);

      const newest = await store.listEntries("workbench_test", partner.partnerId, 3);
      expect(newest.map((entry) => entry.title)).toEqual(["task 39", "task 38", "task 37"]);

      const counts = await store.outcomeCounts("workbench_test", partner.partnerId);
      expect(counts.total).toBe(32);
      expect(counts.completed).toBeLessThan(32);

      expect(await store.loadSummary("workbench_test", partner.partnerId)).toBeNull();
      const outbox = database.transaction((connection) => connection.prepare("SELECT payload_json FROM outbox WHERE kind = ? ORDER BY created_at").all(PARTNER_MEMORY_REFRESH_KIND)) as { payload_json: string }[];
      expect(outbox.map((row) => (JSON.parse(row.payload_json) as { throughSequence: number }).throughSequence)).toEqual([1, 8, 16, 24, 32, 40]);
      expect(outbox.every((row) => !row.payload_json.includes("task ") && !row.payload_json.includes("action_"))).toBe(true);
      expect((await store.loadNextRefresh("workbench_test", partner.partnerId, 40))?.entries.map((entry) => entry.title)).toEqual(["task 0"]);

      // A trimmed result remains receipted when the store is reconstructed.
      const restarted = new SqlitePartnerWorkMemoryStore(database);
      await restarted.recordResult({ workbenchId: "workbench_test", createdAt: "2026-07-29T12:00:00.000Z", memoryId: "duplicate_memory",
        outcome: "COMPLETED", partnerId: partner.partnerId, sessionDataSource: "local_pi:action_0", title: "duplicate" },
      { entryLimit: 32, resultKey: "result_0", summaryCadence: 8 });
      const progress = database.transaction((connection) => connection.prepare("SELECT total_count FROM workbench_partner_work_memory_summaries WHERE workbench_id = ? AND partner_id = ?").get("workbench_test", partner.partnerId));
      expect(progress).toMatchObject({ total_count: 40 });
      expect(await restarted.listEntries("workbench_test", partner.partnerId, 100)).toHaveLength(32);

      let calls = 0;
      const service = new PartnerWorkMemoryService({ clock: new TestClock(), ids: new TestIds(), store: restarted,
        summarizer: { summarize: () => { calls += 1; return Promise.resolve(`summary ${String(calls)}`); } } });
      await service.refreshSummary({ workbenchId: "workbench_test", partnerId: partner.partnerId, throughSequence: 40 });
      expect(calls).toBe(6);
      await service.refreshSummary({ workbenchId: "workbench_test", partnerId: partner.partnerId, throughSequence: 40 });
      expect(calls).toBe(6);
      expect(await restarted.loadNextRefresh("workbench_test", partner.partnerId, 40)).toBeNull();
      await store.saveSummary({ workbenchId: "workbench_test", coveredSequence: 24, entryCount: 24, partnerId: partner.partnerId,
        summary: "stale", updatedAt: "2026-07-29T11:00:00.000Z" });
      expect(await store.loadSummary("workbench_test", partner.partnerId)).toMatchObject({ coveredSequence: 40, entryCount: 32, summary: "summary 6" });

      for (let index = 41; index <= 47; index += 1) {
        await service.recordResult({ workbenchId: "workbench_test", partnerId: partner.partnerId, resultId: `result_${String(index)}`,
          outcome: "COMPLETED", at: "2026-07-29T12:00:00.000Z", sessionDataSource: "shared_session", title: `task ${String(index)}` });
      }
      database.transaction((connection) => connection.exec(`CREATE TRIGGER reject_memory_outbox BEFORE INSERT ON outbox
        WHEN NEW.kind = 'partner.memory.refresh' BEGIN SELECT RAISE(ABORT, 'test_outbox_failure'); END`));
      const last = { workbenchId: "workbench_test", partnerId: partner.partnerId, resultId: "result_48", outcome: "COMPLETED" as const,
        at: "2026-07-29T12:00:00.000Z", sessionDataSource: "shared_session", title: "task 48" };
      await expect(service.recordResult(last)).rejects.toThrow("test_outbox_failure");
      expect(database.transaction((connection) => connection.prepare("SELECT total_count FROM workbench_partner_work_memory_summaries WHERE workbench_id = ? AND partner_id = ?").get("workbench_test", partner.partnerId))).toMatchObject({ total_count: 47 });
      database.transaction((connection) => connection.exec("DROP TRIGGER reject_memory_outbox"));
      await service.recordResult(last);
      expect((await store.listEntries("workbench_test", partner.partnerId, 1))[0]?.title).toBe("task 48");
      expect((await store.loadNextRefresh("workbench_test", partner.partnerId, 48))?.sequence).toBe(48);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
