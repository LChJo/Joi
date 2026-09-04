import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("SQLite partner registry", () => {
  it("persists immutable revisions and restores the active revision after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partners-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      let service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const first = await service.add({ capabilities: ["research"], displayName: "Local Pi", kind: "local-pi", skills: ["web"], tools: ["read"] });
      const second = await service.update(first.partnerId, { capabilities: ["research", "write"], displayName: "Local Pi", skills: ["web"], tools: ["read", "edit"] });
      await service.disable(first.partnerId);
      expect((await new SqlitePartnerRegistryRepository(database).getRevision(first.partnerRevisionId))?.status).toBe("ACTIVE");
      expect((await new SqlitePartnerRegistryRepository(database).getRevision(second.partnerRevisionId))?.status).toBe("ACTIVE");
      database.close();

      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      await expect(service.pinForDispatch(first.partnerId)).rejects.toMatchObject({ code: "partner_not_available" });
      expect(database.transaction((connection) => connection.prepare("SELECT COUNT(*) AS count FROM partner_revisions WHERE partner_id = ?").get(first.partnerId)))
        .toEqual({ count: 3 });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists explicit Codex permissions and derives compatibility permissions only for legacy rows", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-codex-permissions-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const safe = await service.add({ capabilities: [], displayName: "Safe Codex", engine: "codex", kind: "local-pi", skills: [], tools: [] });
      expect(safe.codexPermissions).toEqual({ approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "workspace-write", webSearchMode: "live" });

      const legacyEmpty = await service.add({ capabilities: [], displayName: "Legacy empty", engine: "codex", kind: "local-pi", skills: [], tools: [] });
      const legacyRead = await service.add({ capabilities: [], displayName: "Legacy read", engine: "codex", kind: "local-pi", skills: [], tools: ["web_search"] });
      database.transaction((connection) => {
        connection.prepare("UPDATE partner_revisions SET engine_config_json = NULL WHERE partner_revision_id IN (?, ?)").run(legacyEmpty.partnerRevisionId, legacyRead.partnerRevisionId);
      });
      const repository = new SqlitePartnerRegistryRepository(database);
      expect((await repository.getRevision(legacyEmpty.partnerRevisionId))?.codexPermissions)
        .toEqual({ approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "workspace-write", webSearchMode: "live" });
      expect((await repository.getRevision(legacyRead.partnerRevisionId))?.codexPermissions)
        .toEqual({ approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "read-only", webSearchMode: "live" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists ALL/CUSTOM in execution policy JSON and infers legacy rows without rewriting them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-tool-policy-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const all = await service.add({ capabilities: [], displayName: "All", kind: "local-pi", skills: [], toolPolicyMode: "ALL", tools: ["read"] });
      const none = await service.add({ capabilities: [], displayName: "None", kind: "local-pi", skills: [], toolPolicyMode: "CUSTOM", tools: [] });
      const stored = database.transaction((connection) => connection.prepare("SELECT execution_policy_json FROM partner_revisions WHERE partner_revision_id = ?").get(none.partnerRevisionId)) as { execution_policy_json: string };
      expect(JSON.parse(stored.execution_policy_json)).toMatchObject({ toolPolicyMode: "CUSTOM" });

      database.transaction((connection) => {
        connection.prepare("UPDATE partner_revisions SET execution_policy_json = json_remove(execution_policy_json, '$.toolPolicyMode') WHERE partner_revision_id IN (?, ?)")
          .run(all.partnerRevisionId, none.partnerRevisionId);
      });
      const repository = new SqlitePartnerRegistryRepository(database);
      await expect(repository.getRevision(all.partnerRevisionId)).resolves.toMatchObject({ toolPolicyMode: "CUSTOM", tools: ["read"] });
      await expect(repository.getRevision(none.partnerRevisionId)).resolves.toMatchObject({ toolPolicyMode: "ALL", tools: [] });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("repairs a claimed migration version when the engine config column is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partner-engine-config-repair-"));
    const legacyMigrations = path.join(root, "legacy-migrations");
    const databasePath = path.join(root, "runtime.sqlite");
    await cp(path.resolve("resources/migrations"), legacyMigrations, { recursive: true });
    await Promise.all([
      rm(path.join(legacyMigrations, "047_partner_engine_config.sql")),
      rm(path.join(legacyMigrations, "048_repair_partner_engine_config.sql")),
    ]);
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: legacyMigrations });
    try {
      const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const legacy = await service.add({ capabilities: [], displayName: "Legacy Codex", engine: "codex", kind: "local-pi", skills: [], tools: ["web_search"] });
      database.transaction((connection) => {
        connection.prepare("INSERT INTO schema_migrations (version, filename, applied_at) VALUES (47, '047_previous.sql', ?)")
          .run("2026-08-31T00:00:00.000Z");
      });
      database.close();

      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      expect(database.inspect()).toMatchObject({ mode: "read-write", schemaVersion: 51 });
      expect(database.transaction((connection) => connection.prepare("PRAGMA table_info(partner_revisions)").all()))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "engine_config_json" })]));
      await expect(new SqlitePartnerRegistryRepository(database).getActive(legacy.partnerId)).resolves.toMatchObject({
        codexPermissions: { approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "read-only", webSearchMode: "live" },
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
