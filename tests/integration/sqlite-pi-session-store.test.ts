import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { SqlitePiReasoningSessionStore } from "../../src/main/infrastructure/persistence/sqlite-pi-reasoning-session-store.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";

describe("Pi SQLite session restore", () => {
  it("restores an Avatar-scoped message tree and pinned source/model revisions after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-pi-session-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
        VALUES ('avatar-1', '研究', 'persona-1', '研究人格', '研究范围', '研究工程', 'memory-1', '', 'ACTIVE', ?, ?)`).run(
        "2026-07-28T10:00:00.000Z", "2026-07-28T10:00:00.000Z",
      ));
      const snapshot: JoiReasoningSessionSnapshot = {
        avatarId: "avatar-1",
        messages: [{ content: "scoped sentinel", role: "user", timestamp: 1 }],
        modelRevisionId: "model-revision-1",
        sessionId: "session-1",
        sourceRevisionId: "source-revision-1",
        systemPrompt: "global joi policy",
        updatedAt: "2026-07-28T10:01:00.000Z",
      };
      await new SqlitePiReasoningSessionStore(database).save(snapshot);
      database.close();

      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      expect(await new SqlitePiReasoningSessionStore(database).load("session-1")).toEqual(snapshot);
      expect(await new SqlitePiReasoningSessionStore(database).load("missing")).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
