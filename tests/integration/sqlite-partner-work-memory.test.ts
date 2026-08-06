import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { SqlitePartnerWorkMemoryStore } from "../../src/main/infrastructure/persistence/sqlite-partner-work-memory-store.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("SQLite partner work memory store", () => {
  it("appends outcomes, trims to the newest rows, counts outcomes and upserts the rolling summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-work-memory-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench_test', 'A', 'persona_test', 'persona', 'scope', 'project', 'memory_test', 'ACTIVE', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run());
      const partners = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const partner = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
      const store = new SqlitePartnerWorkMemoryStore(database);

      for (let index = 0; index < 40; index += 1) {
        await store.append({
          workbenchId: "workbench_test",
          createdAt: `2026-07-29T10:${String(index).padStart(2, "0")}:00.000Z`,
          memoryId: `memory_${String(index)}`,
          outcome: index % 5 === 4 ? "FAILED" : "COMPLETED",
          partnerId: partner.partnerId,
          sessionDataSource: `local_pi:action_${String(index)}`,
          title: `task ${String(index)}`,
        });
      }
      await store.trim("workbench_test", partner.partnerId, 32);
      expect(await store.count("workbench_test", partner.partnerId)).toBe(32);

      const newest = await store.listEntries("workbench_test", partner.partnerId, 3);
      expect(newest.map((entry) => entry.title)).toEqual(["task 39", "task 38", "task 37"]);

      const counts = await store.outcomeCounts("workbench_test", partner.partnerId);
      expect(counts.total).toBe(32);
      expect(counts.completed).toBeLessThan(32);

      expect(await store.loadSummary("workbench_test", partner.partnerId)).toBeNull();
      await store.saveSummary({ workbenchId: "workbench_test", entryCount: 32, partnerId: partner.partnerId, summary: "first summary", updatedAt: "2026-07-29T11:00:00.000Z" });
      await store.saveSummary({ workbenchId: "workbench_test", entryCount: 32, partnerId: partner.partnerId, summary: "second summary", updatedAt: "2026-07-29T12:00:00.000Z" });
      expect(await store.loadSummary("workbench_test", partner.partnerId)).toMatchObject({ entryCount: 32, summary: "second summary" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
