import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { SqlitePiReasoningSessionStore } from "../../src/main/infrastructure/persistence/sqlite-pi-reasoning-session-store.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

describe("Pi SQLite session restore", () => {
  it("moves legacy archives out of metadata and only writes changed rows across append, compaction and rollback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-pi-incremental-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    try {
      database.transaction(connection => {
        connection.prepare(`INSERT INTO workbenches
          (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
          VALUES ('wb', '研究', 'p', '', '', '', 'm', '', 'ACTIVE', 'now', 'now')`).run();
        connection.exec(`CREATE TABLE session_mutation_audit (kind TEXT NOT NULL);
          CREATE TRIGGER session_insert AFTER INSERT ON joi_session_messages BEGIN INSERT INTO session_mutation_audit VALUES ('insert'); END;
          CREATE TRIGGER session_update AFTER UPDATE ON joi_session_messages BEGIN INSERT INTO session_mutation_audit VALUES ('update'); END;
          CREATE TRIGGER session_delete AFTER DELETE ON joi_session_messages BEGIN INSERT INTO session_mutation_audit VALUES ('delete'); END;
          CREATE TRIGGER archive_insert AFTER INSERT ON joi_session_archived_messages BEGIN INSERT INTO session_mutation_audit VALUES ('archive-insert'); END;
          CREATE TRIGGER archive_update AFTER UPDATE ON joi_session_archived_messages BEGIN INSERT INTO session_mutation_audit VALUES ('archive-update'); END;
          CREATE TRIGGER archive_delete AFTER DELETE ON joi_session_archived_messages BEGIN INSERT INTO session_mutation_audit VALUES ('archive-delete'); END;`);
      });
      const archived = Array.from({ length: 1000 }, (_, index) => ({ role: "user", content: `archived-${String(index)}`, timestamp: index }));
      const snapshot: JoiReasoningSessionSnapshot = { workbenchId: "wb", sessionId: "incremental", modelRevisionId: "mr", sourceRevisionId: "sr", systemPrompt: "policy", updatedAt: "now",
        archivedMessages: archived, messages: [{ role: "user", content: "anchor", timestamp: 1 }], compaction: {
          compactedMessages: archived.length, count: 1, summary: "private checkpoint", lastCompactedAt: "now",
          coverage: { checkpointId: "checkpoint-1", coveredFrom: 0, coveredTo: archived.length, transcriptId: "incremental" },
        } };
      // An old database record embeds the complete archive in its metadata row.
      database.transaction(connection => connection.prepare(`INSERT INTO joi_session_messages
        (message_id, session_id, workbench_id, sequence, message_json, created_at) VALUES (?, ?, ?, 0, ?, ?)`)
        .run("incremental:metadata", "incremental", "wb", JSON.stringify(snapshot), "now"));
      const store = new SqlitePiReasoningSessionStore(database);
      const legacy = await store.load("incremental");
      expect(legacy?.archivedMessages).toEqual(archived);
      await store.save(snapshot);
      const persisted = database.transaction(connection => ({
        metadata: connection.prepare("SELECT message_json FROM joi_session_messages WHERE session_id = ? AND sequence = 0").get("incremental") as { message_json: string },
        archives: connection.prepare("SELECT COUNT(*) AS count FROM joi_session_archived_messages WHERE session_id = ?").get("incremental") as { count: number },
      }));
      expect(JSON.parse(persisted.metadata.message_json)).not.toHaveProperty("archivedMessages");
      expect(persisted.archives.count).toBe(1000);
      expect(await new SqlitePiReasoningSessionStore(database).load("incremental")).toEqual(snapshot);
      database.transaction(connection => connection.prepare("DELETE FROM session_mutation_audit").run());
      const stringify = vi.spyOn(JSON, "stringify");
      await store.save(snapshot);
      expect(database.transaction(connection => connection.prepare("SELECT kind FROM session_mutation_audit").all())).toEqual([]);
      const appended = { ...snapshot, updatedAt: "later", messages: [...snapshot.messages, { role: "assistant", content: [], timestamp: 2 }] };
      await store.save(appended);
      expect(database.transaction(connection => connection.prepare("SELECT kind FROM session_mutation_audit ORDER BY rowid").all())).toEqual([{ kind: "update" }, { kind: "insert" }]);
      expect(stringify.mock.calls.filter(([value]) => archived.includes(value as typeof archived[number]))).toHaveLength(0);
      stringify.mockRestore();
      await store.save(snapshot);
      expect(await new SqlitePiReasoningSessionStore(database).load("incremental")).toEqual(snapshot);
      const advanced: JoiReasoningSessionSnapshot = { ...snapshot, updatedAt: "advanced", archivedMessages: [...archived, { role: "user", content: "new archive", timestamp: 1000 }],
        compaction: { compactedMessages: 1001, count: 2, summary: "new checkpoint", lastCompactedAt: "advanced",
          coverage: { checkpointId: "checkpoint-2", coveredFrom: 0, coveredTo: 1001, transcriptId: "incremental" } } };
      database.transaction(connection => connection.exec(`CREATE TRIGGER archive_fail BEFORE INSERT ON joi_session_archived_messages
        WHEN NEW.sequence = 1000 BEGIN SELECT RAISE(ABORT, 'archive failure'); END;`));
      await expect(store.save(advanced)).rejects.toThrow("archive failure");
      expect(await new SqlitePiReasoningSessionStore(database).load("incremental")).toEqual(snapshot);
      database.transaction(connection => connection.exec("DROP TRIGGER archive_fail"));
      await store.save(advanced);
      expect(await new SqlitePiReasoningSessionStore(database).load("incremental")).toEqual(advanced);
      await store.save(snapshot);
      expect(await new SqlitePiReasoningSessionStore(database).load("incremental")).toEqual(snapshot);
      const invalid = { ...snapshot, compaction: { compactedMessages: 1000, count: 1, lastCompactedAt: "now", summary: "invalid checkpoint",
        coverage: { checkpointId: "bad", coveredFrom: 0, coveredTo: 999, transcriptId: "another-session" } } };
      await expect(store.save(invalid)).rejects.toThrow("pi_session_record_invalid");
      expect(await new SqlitePiReasoningSessionStore(database).load("incremental")).toEqual(snapshot);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
  it("restores a workbench-scoped message tree and pinned source/model revisions after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-pi-session-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabaseFixture(databasePath);
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, task_summary, status, created_at, updated_at)
        VALUES ('workbench-1', '研究', 'persona-1', '研究人格', '研究范围', '研究工程', 'memory-1', '', 'ACTIVE', ?, ?)`).run(
        "2026-07-28T10:00:00.000Z", "2026-07-28T10:00:00.000Z",
      ));
      const snapshot: JoiReasoningSessionSnapshot = {
        workbenchId: "workbench-1",
        archivedMessages: [{ role: "user", content: "retained source evidence", timestamp: 0 }],
        compaction: {
          compactedMessages: 18,
          count: 2,
          lastCompactedAt: "2026-07-28T10:00:30.000Z",
          summary: "earlier bounded context",
        },
        messages: [{ content: "scoped sentinel", role: "user", timestamp: 1 }],
        modelRevisionId: "model-revision-1",
        sessionId: "session-1",
        sourceRevisionId: "source-revision-1",
        systemPrompt: "global joi policy",
        updatedAt: "2026-07-28T10:01:00.000Z",
      };
      await new SqlitePiReasoningSessionStore(database).save(snapshot);
      database.close();

      database = await openRuntimeDatabaseFixture(databasePath);
      expect(await new SqlitePiReasoningSessionStore(database).load("session-1")).toEqual(snapshot);
      expect(await new SqlitePiReasoningSessionStore(database).load("missing")).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
