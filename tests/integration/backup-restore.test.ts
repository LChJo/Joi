import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { BackupService, applyPendingRestore } from "../../src/main/infrastructure/operations/backup-service";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("consistent backup and quarantine restore", () => {
  it("publishes a verified snapshot and restores it without replaying ambiguous work", async () => {
    const fixture = await createRuntimeFixture();
    const artifactsDirectory = path.join(fixture.root, "artifacts");
    const backupsDirectory = path.join(fixture.root, "backups");
    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(path.join(artifactsDirectory, "result.txt"), "trusted artifact", "utf8");
    fixture.database.transaction((database) => {
      database.prepare("INSERT INTO agent_connections (agent_connection_id, name, card_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("agent_restore", "Restore Agent", "http://192.168.1.20/card", "ACTIVE", fixture.clock.now().toISOString(), fixture.clock.now().toISOString());
      database.prepare("INSERT INTO invocations (invocation_id, agent_connection_id, message_id, request_json, status, send_attempts, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run("inv_restore", "agent_restore", "message_restore", JSON.stringify({ parts: [{ kind: "text", text: "redacted in diagnostics" }] }), "WORKING", 1, fixture.clock.now().toISOString(), fixture.clock.now().toISOString(), fixture.clock.now().toISOString());
      database.prepare("INSERT INTO web_sessions (session_hash, csrf_hash, ip_hash, kind, created_at, last_activity_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run("session_restore", "csrf_restore", "ip_restore", "lan", fixture.clock.now().toISOString(), fixture.clock.now().toISOString(), "2026-07-16T12:00:00.000Z", "2026-07-22T12:00:00.000Z");
      database.prepare(`INSERT INTO model_source_credentials
        (provider_id, credential_type, encrypted_blob, credential_version, updated_at) VALUES ('joi-source:backup-test', 'api_key', ?, 1, ?)`)
        .run(new Uint8Array([9, 8, 7, 6]), fixture.clock.now().toISOString());
    });
    const service = new BackupService({ appVersion: "0.1.0", artifactsDirectory, backupsDirectory, clock: fixture.clock, database: fixture.database, userDataDirectory: fixture.root });
    const backup = await service.create();
    expect(backup.backupId).toMatch(/^backup_/);
    expect((await service.list())[0]).toMatchObject({ backupId: backup.backupId, schemaVersion: 18 });
    const backupDatabase = new DatabaseSync(path.join(backupsDirectory, backup.backupId, "runtime.sqlite"), { readOnly: true });
    try {
      expect(backupDatabase.prepare("SELECT length(encrypted_blob) AS size FROM model_source_credentials WHERE provider_id = 'joi-source:backup-test'").get()).toEqual({ size: 0 });
    } finally {
      backupDatabase.close();
    }
    await expect(service.stageRestore(backup.backupId)).rejects.toMatchObject({ code: "restore_runtime_active" });
    fixture.database.transaction((database) => database.prepare(
      "UPDATE invocations SET status = 'COMPLETED' WHERE invocation_id = 'inv_restore'").run());
    await service.stageRestore(backup.backupId);
    await writeFile(path.join(artifactsDirectory, "result.txt"), "mutated after backup", "utf8");
    fixture.database.close();

    expect(await applyPendingRestore(fixture.root)).toEqual({ backupId: backup.backupId, restored: true });
    const reopened = await openRuntimeDatabase({ databasePath: path.join(fixture.root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const restored = reopened.transaction((database) => ({
        agent: database.prepare("SELECT status, token_required FROM agent_connections WHERE agent_connection_id = 'agent_restore'").get() as Record<string, unknown>,
        invocation: database.prepare("SELECT status FROM invocations WHERE invocation_id = 'inv_restore'").get() as Record<string, unknown>,
        session: database.prepare("SELECT revoked_at FROM web_sessions WHERE session_hash = 'session_restore'").get() as Record<string, unknown>,
      }));
      expect(restored.agent.status).toBe("RECONFIRM_REQUIRED");
      expect(restored.agent.token_required).toBe(1);
      expect(await reopened.store.getPublicAgentConnection("agent_restore")).toMatchObject({ status: "TOKEN_REQUIRED" });
      expect(restored.invocation.status).toBe("UNKNOWN_REQUIRES_REVIEW");
      expect(restored.session.revoked_at).toEqual(expect.any(String));
      expect(await readFile(path.join(artifactsDirectory, "result.txt"), "utf8")).toBe("trusted artifact");
    } finally {
      reopened.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
