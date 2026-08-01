import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ModelSourceRecord } from "../../src/main/application/ports/model-source-ports.js";
import { createModelSource } from "../../src/main/domain/model-sources/model-source.js";
import { SqliteModelSourceRepository } from "../../src/main/infrastructure/persistence/sqlite-model-source-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";

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
});
