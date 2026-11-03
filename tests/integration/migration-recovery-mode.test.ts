import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";

describe("migration recovery mode", () => {
  it("rolls back the failed migration and reopens the database query-only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-migration-recovery-"));
    const migrations = path.join(root, "migrations");
    await cp(path.resolve("resources/migrations"), migrations, { recursive: true });
    await writeFile(path.join(migrations, "018_broken.sql"), "CREATE TABLE half_applied (id TEXT); THIS IS NOT SQL;", "utf8");
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: migrations });
    try {
      expect(database.inspect()).toMatchObject({
        migrationFailure: "migration_failed", mode: "read-only-recovery", queryOnly: true, schemaVersion: 17,
      });
      expect(() => database.transaction((connection) => connection.prepare("SELECT * FROM half_applied").all())).toThrow();
      expect(() => database.transaction((connection) => connection.prepare("INSERT INTO sse_events (event_type, entity_id, payload_json, created_at) VALUES ('x', 'x', '{}', '2026-07-16T00:00:00Z')").run()))
        .toThrow();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
