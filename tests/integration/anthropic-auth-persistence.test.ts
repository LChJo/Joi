/* All databases and credentials are disposable; no Electron userData is accessed. */
/* eslint-disable @typescript-eslint/require-await */
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ModelSourceValidator } from "../../src/main/application/ports/model-source-ports.js";
import { ModelSourceService } from "../../src/main/application/model-sources/model-source-service.js";
import { ReasoningSourceSelector } from "../../src/main/application/model-sources/reasoning-source-selector.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { SqliteModelSourceRepository } from "../../src/main/infrastructure/persistence/sqlite-model-source-repository.js";
import { SqlitePiCredentialRepository } from "../../src/main/infrastructure/persistence/sqlite-pi-credential-repository.js";
import { PiModelSourceCatalog } from "../../src/main/infrastructure/pi/pi-model-source-catalog.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

const learned = { status: "READY" as const, anthropicAuthMode: "bearer" as const, validatedAt: "2026-10-12T00:00:00.000Z" };

async function fixture(validator: ModelSourceValidator) {
  const root = await mkdtemp(path.join(os.tmpdir(), "joi-auth-mode-"));
  const databasePath = path.join(root, "runtime.sqlite");
  const database = await openRuntimeDatabaseFixture(databasePath);
  const repository = new SqliteModelSourceRepository(database);
  const secrets = new SqlitePiCredentialRepository(database);
  let credentialVersion = 0;
  const service = new ModelSourceService({
    catalog: new PiModelSourceCatalog(), clock: new TestClock(), endpointPolicy: { validate: async (url) => ({ local: true, url }) },
    ids: new TestIds(), repository, secrets: { delete: (id) => secrets.delete(id), saveApiKey: async (id) => {
      await secrets.write({ encryptedBlob: new Uint8Array([1, 2, 3]), providerId: id, type: "api_key", version: ++credentialVersion });
      return credentialVersion;
    } }, validator,
  });
  const created = await service.create({
    apiKey: "fake-persistence-token", baseUrl: "http://127.0.0.1:12345/", displayName: "Auth test",
    kind: "generic-openai", modelId: "deepseek-flash", protocol: "anthropic",
  });
  return { created, database, databasePath, repository, root, service };
}

describe("learned Anthropic authentication persistence", () => {
  it("upgrades an existing health row with no learned auth rather than changing its API Key behavior", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-auth-upgrade-"));
    const migrations = path.join(root, "migrations");
    await mkdir(migrations);
    for (const file of await readdir("resources/migrations")) {
      if (/^\d+.*\.sql$/u.test(file) && Number(file.slice(0, 3)) < 72) {
        await copyFile(path.join("resources/migrations", file), path.join(migrations, file));
      }
    }
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: migrations });
    try {
      database.transaction((connection) => {
        connection.prepare("INSERT INTO model_sources (source_id, status, created_at, updated_at) VALUES ('legacy', 'DRAFT', ?, ?)").run(learned.validatedAt, learned.validatedAt);
        connection.prepare("INSERT INTO model_source_health (source_id, status, updated_at) VALUES ('legacy', 'DRAFT', ?)").run(learned.validatedAt);
      });
      database.close();
      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      expect(database.transaction((connection) => connection.prepare("SELECT anthropic_auth_mode FROM model_source_health WHERE source_id = 'legacy'").get())).toMatchObject({ anthropic_auth_mode: null });
    } finally { database.close(); await rm(root, { recursive: true, force: true }); }
  }, process.env.CI ? 60_000 : 5_000);
  it("persists a proven mode through restart and keeps it on ordinary edits and health changes", async () => {
    const f = await fixture({ validate: async () => learned });
    let closed = false;
    try {
      expect(await f.repository.get(f.created.sourceId)).not.toHaveProperty("anthropicAuthMode");
      const ready = await f.service.validate(f.created.sourceId);
      expect(ready).toMatchObject({ status: "READY", anthropicAuthMode: "bearer" });
      expect(ready.activeSourceRevisionId).toBe(f.created.activeSourceRevisionId);
      expect(ready.credential).toEqual(f.created.credential);
      expect(JSON.stringify(ready)).not.toContain("fake-persistence-token");
      f.database.close();
      closed = true;
      const reopened = await openRuntimeDatabaseFixture(f.databasePath);
      try {
        expect(await new SqliteModelSourceRepository(reopened).get(f.created.sourceId)).toMatchObject({ anthropicAuthMode: "bearer" });
      } finally { reopened.close(); }
    } finally { if (!closed) f.database.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("preserves learned auth on model/name edits and disable, but resets on endpoint or credential replacement", async () => {
    const f = await fixture({ validate: async () => learned });
    try {
      await f.service.validate(f.created.sourceId);
      expect(await f.service.update(f.created.sourceId, { displayName: "Renamed", modelId: "another-model" })).toMatchObject({ anthropicAuthMode: "bearer", status: "DRAFT" });
      expect(await f.service.disable(f.created.sourceId)).toMatchObject({ anthropicAuthMode: "bearer" });
      expect(await f.service.update(f.created.sourceId, { apiKey: "fake-replacement-token" })).not.toHaveProperty("anthropicAuthMode");
      await f.service.validate(f.created.sourceId);
      expect(await f.service.update(f.created.sourceId, { baseUrl: "http://127.0.0.1:54321/" })).not.toHaveProperty("anthropicAuthMode");
    } finally { f.database.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it.each(["edit", "disable", "delete"] as const)("rejects late Bearer success after %s", async (action) => {
    let release: (() => void) | undefined;
    const f = await fixture({ validate: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return learned;
    } });
    try {
      const pending = f.service.validate(f.created.sourceId);
      await vi.waitFor(() => expect(release).toBeDefined());
      if (action === "edit") await f.service.update(f.created.sourceId, { apiKey: "fake-replacement-token" });
      else if (action === "disable") await f.service.disable(f.created.sourceId);
      else await f.service.delete(f.created.sourceId);
      release?.();
      if (action === "delete") await expect(pending).rejects.toMatchObject({ code: "model_source_not_found" });
      else expect(await pending).toMatchObject({ status: action === "edit" ? "DRAFT" : "DISABLED" });
      const current = await f.repository.get(f.created.sourceId);
      if (current !== null) expect(current).not.toHaveProperty("anthropicAuthMode");
    } finally { f.database.close(); await rm(f.root, { recursive: true, force: true }); }
  });

  it("adopts and preserves Bearer learned during freshness and runtime auth diagnostic probes", async () => {
    const validate = vi.fn<ModelSourceValidator["validate"]>(async () => learned);
    const f = await fixture({ validate });
    try {
      const current = await f.repository.get(f.created.sourceId);
      if (current === null) throw new Error("fixture source missing");
      await f.repository.save({ ...current, source: { ...current.source, status: "READY" } });
      const selector = new ReasoningSourceSelector(f.repository, {
        clock: { now: () => new Date(learned.validatedAt) }, validator: { validate },
      });
      await selector.selectById(f.created.sourceId, "turn-test");
      expect(await f.repository.get(f.created.sourceId)).toMatchObject({ anthropicAuthMode: "bearer", source: { status: "READY" } });
      validate.mockResolvedValueOnce({ status: "NEEDS_AUTH", reasonCode: "auth_failed", validatedAt: learned.validatedAt });
      await selector.reportRunFailure(f.created.sourceId, { status: 401 });
      expect(validate.mock.calls[1]?.[0]).toMatchObject({ anthropicAuthMode: "bearer" });
      expect(await f.repository.get(f.created.sourceId)).toMatchObject({ anthropicAuthMode: "bearer", source: { status: "NEEDS_AUTH" } });
    } finally { f.database.close(); await rm(f.root, { recursive: true, force: true }); }
  });
});
