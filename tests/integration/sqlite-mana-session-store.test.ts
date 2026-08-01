import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationRecord, ConversationTranscriptEntry } from "@rd-efficiency/agentsdk";

import { ManaSdkConversationStore } from "../../src/main/infrastructure/mana/mana-sdk-session-store.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";

function record(id: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    backend: "claude",
    capabilities: {
      continuity: "native-state",
      mode: "native",
      nativeFork: true,
      nativeResume: true,
      residentTurns: true,
      source: "claude-session",
      streamInput: true,
      virtualReplay: false,
    },
    createdAt: "2026-07-30T10:00:00.000Z",
    historyPolicy: {},
    id,
    mode: "native",
    native: {},
    projectKey: "joi:partner_1",
    schemaVersion: 1,
    source: "claude-session",
    transcript: [],
    turns: "resident",
    updatedAt: "2026-07-30T10:00:00.000Z",
    ...overrides,
  };
}

function entry(id: string, content: string): ConversationTranscriptEntry {
  return { conversationId: "conv_1", createdAt: "2026-07-30T10:01:00.000Z", id, role: "user", turnId: "turn_1", content };
}

describe("Mana SDK conversation store", () => {
  it("round-trips records, transcripts, forks and deletion over SQLite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-mana-store-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const store = new ManaSdkConversationStore(database);
      expect(await store.get("conv_1")).toBeNull();

      const created = await store.create(record("conv_1", { model: "claude-sonnet" }));
      expect(created.id).toBe("conv_1");
      expect(await store.get("conv_1")).toMatchObject({ id: "conv_1", model: "claude-sonnet", turns: "resident" });

      const updated = await store.update("conv_1", (current) => ({ ...current, model: "claude-opus" }));
      expect(updated.model).toBe("claude-opus");
      expect((await store.get("conv_1"))?.model).toBe("claude-opus");

      const appended = await store.appendTranscript("conv_1", [entry("e1", "first"), entry("e2", "second"), entry("e3", "third")]);
      expect(appended.transcript.map((item) => item.id)).toEqual(["e1", "e2", "e3"]);
      expect((await store.get("conv_1"))?.transcript.map((item) => item.id)).toEqual(["e1", "e2", "e3"]);
      const messages = await store.listMessages("conv_1");
      expect(messages.map((message) => message.content)).toEqual(["first", "second", "third"]);
      const paged = await store.listMessages("conv_1", { limit: 2, offset: 1 });
      expect(paged.map((message) => message.id)).toEqual(["e2", "e3"]);

      const forked = await store.fork("conv_1", { id: "conv_2", projectKey: "joi:partner_2" });
      expect(forked).toMatchObject({ id: "conv_2", model: "claude-opus", projectKey: "joi:partner_2" });
      expect((await store.listMessages("conv_2")).map((message) => message.id)).toEqual(["e1", "e2", "e3"]);

      await store.delete("conv_1");
      expect(await store.get("conv_1")).toBeNull();
      expect(await store.listMessages("conv_1")).toEqual([]);
      expect((await store.get("conv_2"))?.id).toBe("conv_2");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
