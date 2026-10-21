import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { WorkbenchRegistryService } from "../../src/main/application/joi/workbench-registry-service.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("goal binding migration", () => {
  it("upgrades existing data and accepts only turns from the same goal and workbench", async () => {
    const fixture = await createRuntimeFixture();
    const migrations = path.join(fixture.root, "upgrade-migrations");
    await mkdir(migrations);
    for (const file of await readdir("resources/migrations")) {
      if (/^\d+.*\.sql$/u.test(file) && Number(file.slice(0, 3)) <= 81) {
        await copyFile(path.join("resources/migrations", file), path.join(migrations, file));
      }
    }
    const databasePath = path.join(fixture.root, "upgrade.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: migrations });
    try {
      const registry = new WorkbenchRegistryService({ clock: fixture.clock, ids: fixture.ids, repository: new LegacyLifeStoreAdapter(database) });
      const first = await registry.create({ name: "First", personaSummary: "Fixture", projectLabel: "Fixture", scopeSummary: "First" });
      const second = await registry.create({ name: "Second", personaSummary: "Fixture", projectLabel: "Fixture", scopeSummary: "Second" });
      const now = fixture.clock.now().toISOString();
      const inbox = new SqliteJoiInboxRepository(database, fixture.clock);
      for (const inputId of ["original", "other-goal", "direct"]) await inbox.create({ inputId, idempotencyKey: inputId,
        body: "Fixture", workbenchId: first.workbenchId, status: "PENDING", createdAt: now, updatedAt: now });
      await inbox.create({ inputId: "recovery", idempotencyKey: "recovery", body: "Fixture recovery",
        workbenchId: first.workbenchId, status: "PENDING", createdAt: now, updatedAt: now });
      database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET goal_input_id = 'original' WHERE input_id = 'recovery'").run());
      await inbox.createTurn({ inputId: "recovery", turnId: "recovery-turn", workbenchId: first.workbenchId, sessionId: "recovery-session", createdAt: now });
      const insert = (id: string, inputId: string, workbenchId = first.workbenchId) => database.transaction(db => db.prepare(`INSERT INTO work_items
        (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
        VALUES (?, ?, ?, 'Fixture', '{}', 'READ', 'READY', ?, ?)`)
        .run(id, workbenchId, inputId, now, now));
      expect(() => insert("before-upgrade", "original")).toThrow("work_goal_binding_invalid");
      database.close();
      await copyFile("resources/migrations/082_derived_turn_goal_binding.sql", path.join(migrations, "082_derived_turn_goal_binding.sql"));
      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: migrations });
      expect(() => insert("valid", "original")).not.toThrow();
      expect(() => insert("wrong-goal", "other-goal")).toThrow("work_goal_binding_invalid");
      expect(() => insert("wrong-workbench", "original", second.workbenchId)).toThrow("work_goal_binding_invalid");
      expect(() => database.transaction(db => db.prepare("UPDATE work_items SET input_id = 'other-goal' WHERE work_id = 'valid'").run()))
        .toThrow("work_goal_binding_invalid");
      expect(() => database.transaction(db => db.prepare("UPDATE work_items SET workbench_id = ? WHERE work_id = 'valid'").run(second.workbenchId)))
        .toThrow("work_goal_binding_invalid");
      await new SqliteJoiInboxRepository(database, fixture.clock).createTurn({ inputId: "direct", turnId: "direct-turn",
        workbenchId: first.workbenchId, sessionId: "direct-session", createdAt: now });
      expect(() => insert("valid-direct", "direct")).not.toThrow();
      expect(database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_turns WHERE input_id = 'original'").get())).toEqual({ n: 0 });
      expect(database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM joi_inbox_messages").get())).toEqual({ n: 4 });
    } finally { database.close(); await fixture.close(); }
  });
});
