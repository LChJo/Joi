import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { latestMigrationVersion, openRuntimeDatabase, type RuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

/** Seeds the foreign-key chain a dispatch attempt needs: workbench -> inbox -> turn -> plan -> work. */
function seedDispatchableWork(database: RuntimeDatabase, partnerRevisionId: string, status: string): void {
  database.transaction((connection) => {
    connection.prepare(`INSERT INTO workbenches
      (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
      VALUES ('workbench_seed', 'A', 'persona_1', 'summary', 'scope', 'project', 'memory_namespace_1', 'ACTIVE', '2026-07-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO joi_inbox_messages (input_id, idempotency_key, body, status, workbench_id, created_at, updated_at)
      VALUES ('input_seed', 'idem_seed', 'body', 'ROUTED', 'workbench_seed', '2026-07-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO joi_turns (turn_id, input_id, workbench_id, session_id, status, created_at, updated_at)
      VALUES ('turn_seed', 'input_seed', 'workbench_seed', 'joi_session:workbench_seed', 'RUNNING', '2026-07-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO dispatch_plans (dispatch_plan_id, turn_id, candidate_json, policy_result_json, created_at)
      VALUES ('plan_seed', 'turn_seed', '{}', '{}', '2026-07-15T12:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO work_items (work_id, workbench_id, input_id, title, intent_json, access_mode, status, created_at, updated_at)
      VALUES ('work_seed', 'workbench_seed', 'input_seed', 'the task', '{}', 'WRITE', 'READY', '2026-07-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z')`).run();
    connection.prepare(`INSERT INTO dispatch_attempts
      (dispatch_attempt_id, dispatch_plan_id, work_id, partner_revision_id, registry_revision, action_id, status, created_at, updated_at)
      VALUES ('attempt_seed', 'plan_seed', 'work_seed', ?, 1, 'action_seed', ?, '2026-07-15T12:00:00.000Z', '2026-07-15T12:00:00.000Z')`)
      .run(partnerRevisionId, status);
  });
}

describe("SQLite partner registry", () => {
  it("persists immutable revisions and restores the active revision after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partners-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabaseFixture(databasePath);
    try {
      let service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const first = await service.add({ capabilities: ["research"], displayName: "Local Pi", kind: "local-pi", skills: ["web"], tools: ["read"] });
      const second = await service.update(first.partnerId, { capabilities: ["research", "write"], displayName: "Local Pi", skills: ["web"], tools: ["read", "edit"] });
      await service.disable(first.partnerId);
      expect((await new SqlitePartnerRegistryRepository(database).getRevision(first.partnerRevisionId))?.status).toBe("ACTIVE");
      expect((await new SqlitePartnerRegistryRepository(database).getRevision(second.partnerRevisionId))?.status).toBe("ACTIVE");
      database.close();

      database = await openRuntimeDatabaseFixture(databasePath);
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
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
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
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
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

  it("keeps the directory in creation order across enable, disable and edit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partner-order-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      const clock = new TestClock();
      const service = new PartnerRegistryService({ clock, ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const first = await service.add({ capabilities: [], displayName: "First", kind: "local-pi", skills: [], tools: ["read"] });
      clock.advance(1_000);
      const second = await service.add({ capabilities: [], displayName: "Second", kind: "local-pi", skills: [], tools: ["read"] });
      clock.advance(1_000);
      const third = await service.add({ capabilities: [], displayName: "Third", kind: "local-pi", skills: [], tools: ["read"] });
      const names = async () => (await service.list()).map((partner) => partner.displayName);
      await expect(names()).resolves.toEqual(["First", "Second", "Third"]);

      // Each of these appends a revision with a higher registry_revision for that partner.
      await service.disable(first.partnerId);
      await expect(names()).resolves.toEqual(["First", "Second", "Third"]);
      await service.enable(first.partnerId);
      await expect(names()).resolves.toEqual(["First", "Second", "Third"]);
      await service.update(second.partnerId, { capabilities: [], displayName: "Second", skills: [], tools: ["read", "edit"] });
      await service.disable(third.partnerId);
      await expect(names()).resolves.toEqual(["First", "Second", "Third"]);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("treats an UNKNOWN dispatch attempt as settled so a disabled partner can still be deleted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partner-unknown-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      const repository = new SqlitePartnerRegistryRepository(database);
      const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
      const partner = await service.add({ capabilities: [], displayName: "Draining", kind: "local-pi", skills: [], tools: [] });
      await service.disable(partner.partnerId);
      seedDispatchableWork(database, partner.partnerRevisionId, "RUNNING");

      // A genuinely in-flight attempt still holds the partner in drain.
      await expect(repository.countInFlight(partner.partnerId)).resolves.toBe(1);
      await expect(service.delete(partner.partnerId)).rejects.toMatchObject({ code: "partner_delete_in_flight" });

      database.transaction((connection) => {
        connection.prepare("UPDATE dispatch_attempts SET status = 'UNKNOWN' WHERE dispatch_attempt_id = 'attempt_seed'").run();
      });
      await expect(repository.countInFlight(partner.partnerId)).resolves.toBe(0);
      await expect(service.delete(partner.partnerId)).resolves.toMatchObject({ status: "DELETED" });
      await expect(service.list()).resolves.toEqual([]);
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
      expect(database.inspect()).toMatchObject({ mode: "read-write", schemaVersion: await latestMigrationVersion(path.resolve("resources/migrations")) });
      expect(database.transaction((connection) => connection.prepare("PRAGMA table_info(partner_revisions)").all()))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "engine_config_json" })]));
      await expect(new SqlitePartnerRegistryRepository(database).getActive(legacy.partnerId)).resolves.toMatchObject({
        codexPermissions: { approvalPolicy: "never", networkAccessEnabled: true, sandboxMode: "read-only", webSearchMode: "live" },
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  }, process.env.CI ? 60_000 : 5_000);
});
