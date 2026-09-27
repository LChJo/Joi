import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ModelSourceRecord } from "../../src/main/application/ports/model-source-ports.js";
import { createModelSource, reviseModelSource } from "../../src/main/domain/model-sources/model-source.js";
import { SqliteModelSourceRepository } from "../../src/main/infrastructure/persistence/sqlite-model-source-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { ModelSourceService } from "../../src/main/application/model-sources/model-source-service.js";
import { SqlitePiCredentialRepository } from "../../src/main/infrastructure/persistence/sqlite-pi-credential-repository.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

function record(sourceId: string, order: number): ModelSourceRecord {
  const createdAt = order === 0 ? "2026-07-28T10:00:00.000Z" : "2026-07-28T10:00:01.000Z";
  return {
    local: false,
    order,
    presetVersion: "2026-07-28",
    primary: order === 0,
    source: createModelSource({
      accessMode: order === 0 ? "coding-plan" : "api",
      createdAt,
      credentialRef: `joi-source:${sourceId}`,
      credentialVersion: 1,
      displayName: sourceId,
      kind: order === 0 ? "kimi" : "deepseek",
      modelCapability: "release-tested",
      modelId: order === 0 ? "kimi-k2.5" : "deepseek-chat",
      modelRevisionId: `model-${sourceId}`,
      protocol: order === 0 ? "anthropic" : "openai",
      sourceId,
      sourceRevisionId: `revision-${sourceId}`,
    }),
  };
}

describe("SqliteModelSourceRepository", () => {
  it("deletes a used source and its secret without changing historical turn revisions after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-source-delete-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const credentials = new SqlitePiCredentialRepository(database);
      const repository = new SqliteModelSourceRepository(database);
      for (const [index, sourceId] of ["used", "backup"].entries()) {
        await credentials.write({ encryptedBlob: new Uint8Array([1, 2, 3]), providerId: `joi-source:${sourceId}`, type: "api_key", version: 1 });
        await repository.create(record(sourceId, index));
      }
      const now = "2026-09-21T06:00:00.000Z";
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO joi_inbox_messages
          (input_id, idempotency_key, body, status, created_at, updated_at)
          VALUES ('input-delete', 'input-delete', '', 'CONSUMED', ?, ?)`).run(now, now);
        connection.prepare(`INSERT INTO joi_turns
          (turn_id, input_id, session_id, source_revision_id, model_revision_id, status, created_at, updated_at)
          VALUES ('turn-delete', 'input-delete', 'session-delete', 'revision-used', 'model-used', 'COMPLETED', ?, ?)`).run(now, now);
      });
      const service = new ModelSourceService({
        catalog: { resolve: () => { throw new Error("unexpected catalog call"); } },
        clock: new TestClock(), endpointPolicy: { validate: () => { throw new Error("unexpected endpoint call"); } }, ids: new TestIds(), repository,
        secrets: { delete: (providerId) => credentials.delete(providerId), saveApiKey: () => { throw new Error("unexpected secret write"); } },
        validator: { validate: () => { throw new Error("unexpected validation"); } },
      });
      await service.delete("used");
      expect(await service.list()).toMatchObject([{ sourceId: "backup", primary: true, order: 0 }]);
      expect(await repository.get("used")).toBeNull();
      expect(await credentials.read("joi-source:used")).toBeNull();
      expect(await credentials.list()).toEqual([{ providerId: "joi-source:backup", type: "api_key", version: 1 }]);
      // A late validation result must not resurrect the removed source.
      const deleted = record("used", 0);
      expect(await repository.saveHealthIfCurrent({ ...deleted, source: { ...deleted.source, status: "READY" } }, {
        credentialVersion: 1, modelRevisionId: "model-used", sourceRevisionId: "revision-used", sourceUpdatedAt: deleted.source.updatedAt,
      })).toBe(false);
      expect(await repository.get("used")).toBeNull();
      database.close();
      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      expect(await new SqliteModelSourceRepository(database).list()).toHaveLength(1);
      expect(await new SqlitePiCredentialRepository(database).read("joi-source:used")).toBeNull();
      database.transaction((connection) => {
        expect(connection.prepare(`SELECT t.source_revision_id, t.model_revision_id, t.status
          FROM joi_turns t JOIN model_source_revisions sr ON sr.source_revision_id = t.source_revision_id
          JOIN model_source_model_revisions mr ON mr.model_revision_id = t.model_revision_id
          WHERE turn_id = 'turn-delete'`).get()).toEqual({ source_revision_id: "revision-used", model_revision_id: "model-used", status: "COMPLETED" });
        expect(connection.prepare("SELECT length(encrypted_blob) AS size FROM model_source_credentials WHERE provider_id = 'joi-source:used'").get()).toEqual({ size: 0 });
        expect(connection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("removes unreferenced credentials and treats repeated deletion as empty", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-credential-delete-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const credentials = new SqlitePiCredentialRepository(database);
      await credentials.write({ encryptedBlob: new Uint8Array([1]), providerId: "orphan", type: "api_key", version: 1 });
      await credentials.delete("orphan");
      await credentials.delete("orphan");
      expect(await credentials.read("orphan")).toBeNull();
      expect(await credentials.list()).toEqual([]);
      expect(database.transaction((connection) => connection.prepare("SELECT provider_id FROM model_source_credentials").all())).toEqual([]);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("persists the dedicated token-plan access mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-token-plan-source-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO model_source_credentials
        (provider_id, credential_type, encrypted_blob, credential_version, updated_at) VALUES (?, 'api_key', ?, 1, ?)`)
        .run("joi-source:token-plan", new Uint8Array([1]), "2026-08-02T12:00:00.000Z"));
      const source = record("token-plan", 0);
      source.source.activeSourceRevision.accessMode = "token-plan";
      source.source.activeSourceRevision.kind = "qwen";
      await new SqliteModelSourceRepository(database).create(source);
      expect((await new SqliteModelSourceRepository(database).get("token-plan"))?.source.activeSourceRevision.accessMode).toBe("token-plan");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("remembers a tool capability proof for the active revision pair only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-tool-proof-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO model_source_credentials
        (provider_id, credential_type, encrypted_blob, credential_version, updated_at) VALUES (?, 'api_key', ?, 1, ?)`)
        .run("joi-source:proof", new Uint8Array([1]), "2026-08-02T12:00:00.000Z"));
      const repository = new SqliteModelSourceRepository(database);
      await repository.create(record("proof", 0));
      expect((await repository.get("proof"))?.source.toolProofAt).toBeUndefined();
      await repository.recordToolProof({ modelRevisionId: "model-proof", provenAt: "2026-08-06T10:00:00.000Z", sourceRevisionId: "revision-proof" });
      await repository.recordToolProof({ modelRevisionId: "model-proof", provenAt: "2026-08-06T11:00:00.000Z", sourceRevisionId: "revision-proof" });
      expect((await repository.get("proof"))?.source.toolProofAt).toBe("2026-08-06T10:00:00.000Z");
      const current = await repository.get("proof");
      if (current === null) throw new Error("source missing");
      await repository.revise({
        ...current,
        source: reviseModelSource(current.source, {
          credentialVersion: 2, modelCapability: "release-tested", modelId: "kimi-k2.5",
          modelRevisionId: "model-proof-2", sourceRevisionId: "revision-proof-2", updatedAt: "2026-08-06T12:00:00.000Z",
        }),
      });
      expect((await repository.get("proof"))?.source.toolProofAt).toBeUndefined();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("restores sources, health and deterministic order after a process restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-model-sources-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => {
        const statement = connection.prepare(`INSERT INTO model_source_credentials
          (provider_id, credential_type, encrypted_blob, credential_version, updated_at) VALUES (?, 'api_key', ?, 1, ?)`);
        statement.run("joi-source:source-a", new Uint8Array([1]), "2026-07-28T10:00:00.000Z");
        statement.run("joi-source:source-b", new Uint8Array([2]), "2026-07-28T10:00:01.000Z");
      });
      const repository = new SqliteModelSourceRepository(database);
      await repository.create(record("source-a", 0));
      await repository.create(record("source-b", 1));
      const sourceA = await repository.get("source-a");
      if (sourceA === null) throw new Error("fixture_missing");
      await repository.save({
        ...sourceA,
        lastValidatedAt: "2026-07-28T10:01:00.000Z",
        source: { ...sourceA.source, status: "READY", updatedAt: "2026-07-28T10:01:00.000Z" },
      });
      await repository.setOrder(["source-b", "source-a"]);
      database.close();

      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      const restored = await new SqliteModelSourceRepository(database).list();
      expect(restored).toHaveLength(2);
      expect(restored[0]?.source.sourceId).toBe("source-b");
      expect(restored[0]?.order).toBe(0);
      expect(restored[0]?.primary).toBe(true);
      expect(restored[1]?.source.sourceId).toBe("source-a");
      expect(restored[1]?.source.status).toBe("READY");
      expect(restored[1]?.source.activeSourceRevision.accessMode).toBe("coding-plan");
      expect(restored[1]?.source.activeSourceRevision.protocol).toBe("anthropic");
      expect(restored[1]?.lastValidatedAt).toBe("2026-07-28T10:01:00.000Z");
      expect(restored[1]?.order).toBe(1);
      expect(restored[1]?.primary).toBe(false);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("round-trips configured limits without rewriting the revision they replaced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-source-limits-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteModelSourceRepository(database);
      const sourceId = "source-limits";
      // The revision row references its credential, so the credential has to exist first.
      await new SqlitePiCredentialRepository(database).write({
        encryptedBlob: new Uint8Array([1, 2, 3]), providerId: `joi-source:${sourceId}`, type: "api_key", version: 1,
      });
      const limits = { compactionThresholdPercent: 70, contextWindow: 400_000, maxOutputTokens: 65_536 };
      const source = createModelSource({
        accessMode: "api",
        createdAt: "2026-07-28T10:00:00.000Z",
        credentialRef: `joi-source:${sourceId}`,
        credentialVersion: 1,
        displayName: "GLM",
        kind: "glm",
        modelCapability: "release-tested",
        modelId: "glm-5.2",
        modelRevisionId: "model-limits-1",
        protocol: "openai",
        sourceId,
        sourceRevisionId: "revision-limits-1",
        ...limits,
      });
      await repository.create({ local: false, order: 0, primary: true, source });
      expect((await repository.get(sourceId))?.source.activeModelRevision).toMatchObject(limits);

      // The table is append-only, so the revision this one replaced must keep its own values —
      // that is what makes an edit leave the previous configuration readable in history.
      const revised = reviseModelSource(source, {
        compactionThresholdPercent: 60,
        contextWindow: 400_000,
        credentialVersion: 2,
        maxOutputTokens: 65_536,
        modelCapability: "release-tested",
        modelId: "glm-5.2",
        modelRevisionId: "model-limits-2",
        sourceRevisionId: "revision-limits-2",
        updatedAt: "2026-07-28T11:00:00.000Z",
      });
      await repository.revise({ local: false, order: 0, primary: true, source: revised });
      expect((await repository.get(sourceId))?.source.activeModelRevision)
        .toMatchObject({ compactionThresholdPercent: 60, contextWindow: 400_000, maxOutputTokens: 65_536 });
      expect(database.transaction((connection) => connection.prepare(
        `SELECT model_revision_id, compaction_threshold_percent, context_window
           FROM model_source_model_revisions WHERE source_id = ? ORDER BY created_at, model_revision_id`,
      ).all(sourceId))).toEqual([
        { compaction_threshold_percent: 70, context_window: 400_000, model_revision_id: "model-limits-1" },
        { compaction_threshold_percent: 60, context_window: 400_000, model_revision_id: "model-limits-2" },
      ]);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects health writes from an obsolete source revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-model-source-health-race-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO model_source_credentials
        (provider_id, credential_type, encrypted_blob, credential_version, updated_at) VALUES (?, 'api_key', ?, 1, ?)`)
        .run("joi-source:race", new Uint8Array([1]), "2026-09-03T10:00:00.000Z"));
      const repository = new SqliteModelSourceRepository(database);
      const initial = record("race", 0);
      await repository.create(initial);
      const revised: ModelSourceRecord = {
        ...initial,
        source: {
          ...initial.source,
          activeSourceRevision: { ...initial.source.activeSourceRevision, sourceRevisionId: "revision-race-2", credentialVersion: 2 },
          activeModelRevision: { ...initial.source.activeModelRevision, modelRevisionId: "model-race-2", modelId: "deepseek-chat-v2" },
          status: "DRAFT",
          updatedAt: "2026-09-03T10:01:00.000Z",
        },
      };
      await repository.revise(revised);

      await expect(repository.saveHealthIfCurrent({
        ...initial,
        lastValidatedAt: "2026-09-03T10:02:00.000Z",
        source: { ...initial.source, status: "READY", updatedAt: "2026-09-03T10:02:00.000Z" },
      }, {
        credentialVersion: initial.source.activeSourceRevision.credentialVersion,
        modelRevisionId: initial.source.activeModelRevision.modelRevisionId,
        sourceRevisionId: initial.source.activeSourceRevision.sourceRevisionId,
        sourceUpdatedAt: initial.source.updatedAt,
      })).resolves.toBe(false);
      expect(await repository.get("race")).toMatchObject({ source: { status: "DRAFT", activeSourceRevision: { sourceRevisionId: "revision-race-2" } } });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
