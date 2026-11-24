import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";

it("upgrades existing model networks and preserves historical source references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joi-antigravity-upgrade-"));
  const previousMigrations = path.join(root, "migrations");
  const databasePath = path.join(root, "runtime.sqlite");
  try {
    await mkdir(previousMigrations);
    for (const filename of await readdir("resources/migrations")) {
      if (/^\d+_/u.test(filename) && Number.parseInt(filename, 10) <= 114) {
        await copyFile(path.resolve("resources/migrations", filename), path.join(previousMigrations, filename));
      }
    }
    const previous = await openRuntimeDatabase({ databasePath, migrationsDirectory: previousMigrations });
    try {
      previous.transaction((db) => db.exec(`
        INSERT INTO model_source_credentials VALUES ('fixture-credential','oauth',X'010203',1,'now');
        INSERT INTO model_sources (source_id,status,active_source_revision_id,active_model_revision_id,created_at,updated_at)
          VALUES ('fixture-source','READY','fixture-revision','fixture-model','now','now');
        INSERT INTO model_source_revisions
          (source_revision_id,source_id,kind,display_name,credential_ref,credential_version,created_at,access_mode,protocol)
          VALUES ('fixture-revision','fixture-source','codex','Fixture','fixture-credential',1,'now','coding-plan','openai');
        INSERT INTO model_source_model_revisions (model_revision_id,source_id,model_id,capability,created_at)
          VALUES ('fixture-model','fixture-source','gpt-6.1-sol','custom-unverified-tools','now');
        INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,created_at,updated_at)
          VALUES ('fixture-input','fixture-input','Fixture','CONSUMED','now','now');
        INSERT INTO joi_turns(turn_id,input_id,session_id,source_revision_id,model_revision_id,status,created_at,updated_at)
          VALUES ('fixture-turn','fixture-input','fixture-session','fixture-revision','fixture-model','COMPLETED','now','now');
      `));
    } finally { previous.close(); }
    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      upgraded.transaction((db) => {
        expect(db.prepare("SELECT filename FROM schema_migrations WHERE version >= 114 ORDER BY version").all())
          .toEqual([{ filename: "114_workbench_result_history.sql" }, { filename: "115_antigravity_subscription_model_source.sql" }]);
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_joi_inbox_workbench_result_history'").get())
          .toEqual({ name: "idx_joi_inbox_workbench_result_history" });
        expect(db.prepare("SELECT kind,protocol FROM model_source_revisions").all()).toEqual([{ kind: "codex", protocol: "openai" }]);
        expect(db.prepare("SELECT source_revision_id,model_revision_id FROM joi_turns WHERE turn_id='fixture-turn'").get())
          .toEqual({ source_revision_id: "fixture-revision", model_revision_id: "fixture-model" });
        const insert = db.prepare(`INSERT INTO model_source_revisions
          (source_revision_id,source_id,kind,display_name,credential_ref,credential_version,created_at,access_mode,protocol,base_url)
          VALUES ('anti-revision','fixture-source','antigravity','Fixture','fixture-credential',1,'now',?,?,?)`);
        expect(() => insert.run("api", "google", null)).toThrow();
        expect(() => insert.run("coding-plan", "openai", null)).toThrow();
        expect(() => insert.run("coding-plan", "google", "https://example.invalid")).toThrow();
        insert.run("coding-plan", "google", null);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(db.prepare("SELECT hex(encrypted_blob) AS blob FROM model_source_credentials").get()).toEqual({ blob: "010203" });
      });
    } finally { upgraded.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
