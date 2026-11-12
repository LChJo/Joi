import { createRuntimeFixture } from "../support/runtime-fixture";
import { SqliteConversationStore } from "../../src/main/infrastructure/persistence/sqlite-conversation-store";

describe("normal conversation persistence", () => {
  it("CHAT-24 pages every retained turn and resumes payload-free events with a conversation-bound cursor",async () => {
    const f = await createRuntimeFixture();
    try {
      const wb = await f.workbenchRegistry.create({ name: "Pages",personaSummary: "Help",projectLabel: "Pages",scopeSummary: "Help" });
      const store = new SqliteConversationStore(f.database);
      const config = { partnerId: "p",partnerName: "Helper",networkId: "s",networkName: "Network",modelName: "m",skills: [],attachmentIds: [] };
      for (let index = 0;index < 57;index++) {
        const id = `page_${String(index)}`;
        await store.submit({ conversationId: "paged",workbenchId: wb.workbenchId,turnId: id,requestId: id,text: `Private text ${String(index)}`,config,at: f.clock.now().toISOString() });
        await store.begin(id);await store.update(id,{ status: "COMPLETED",entries: [],artifacts: [] });
      }
      const page = await store.get("paged");expect(page?.turns).toHaveLength(50);expect(page?.historyCursor).toBeDefined();
      const older = await store.page("paged",page?.historyCursor,50);expect(older.items).toHaveLength(7);expect(older.nextCursor).toBeNull();
      expect(older.items[0]?.text).toBe("Private text 0");
      const cursor = page?.eventCursor;
      expect((await store.events("paged",cursor)).items).toHaveLength(0);
      await store.submit({ conversationId: "paged",workbenchId: wb.workbenchId,turnId: "new",requestId: "new",text: "PRIVATE_EVENT_BODY",config,at: f.clock.now().toISOString() });
      const events = await store.events("paged",cursor);expect(events.items).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("PRIVATE_EVENT_BODY");
      await store.submit({ conversationId: "other",workbenchId: wb.workbenchId,turnId: "other",requestId: "other",text: "Foreign",config,at: f.clock.now().toISOString() });
      await expect(store.events("other",cursor)).rejects.toMatchObject({ code: "conversation_cursor_invalid" });
      await expect(store.page("other",page?.historyCursor,50)).rejects.toMatchObject({ code: "conversation_cursor_invalid" });
    } finally { await f.close(); }
  });
  it("CHAT-15 releases legacy admission backoff only for conversation turns that never started", async () => {
    const f = await createRuntimeFixture();
    try {
      const wb = await f.workbenchRegistry.create({ name: "Queue",personaSummary: "Help",projectLabel: "Queue",scopeSummary: "Help" });
      const store = new SqliteConversationStore(f.database);
      const input = { workbenchId: wb.workbenchId,text: "Fixture",at: f.clock.now().toISOString(),config: { partnerId: "joi-chat",partnerName: "joi",networkId: "net",networkName: "Network",modelName: "Model",skills: [],attachmentIds: [] } };
      for (const id of ["queued","running","stopped"]) await store.submit({ ...input,conversationId: id,turnId: id,requestId: id });
      await store.begin("running");await store.stop("stopped");
      f.database.transaction(db => db.prepare("UPDATE outbox SET available_at='2099-01-01T00:00:00Z'").run());
      await store.recoverInterrupted(input.at);
      const rows = f.database.transaction(db => db.prepare("SELECT outbox_id,available_at FROM outbox ORDER BY outbox_id").all());
      expect(rows.find(row => row.outbox_id === "conversation:queued")?.available_at).toBe(input.at);
      for (const id of ["running","stopped"]) expect(rows.find(row => row.outbox_id === `conversation:${id}`)?.available_at).toBe("2099-01-01T00:00:00Z");
      expect((await store.get("running"))?.turns[0]?.status).toBe("INTERRUPTED");
    } finally { await f.close(); }
  });
  it("CHAT-13/14 archives, restores and deletes without replay; active turns and deleted identities stay protected", async () => {
    const f = await createRuntimeFixture();
    try {
      const wb = await f.workbenchRegistry.create({ name: "Archive", personaSummary: "Help", projectLabel: "Archive", scopeSummary: "Help" });
      const store = new SqliteConversationStore(f.database);
      const input = { conversationId: "archive-chat",turnId: "archive-turn",requestId: "archive-request",workbenchId: wb.workbenchId,text: "Archive fixture",at: f.clock.now().toISOString(),config: { partnerId: "joi-chat",partnerName: "joi",networkId: "network",networkName: "Network",modelName: "Model",skills: [],attachmentIds: [] } };
      await store.submit(input);
      for (const state of ["ARCHIVED","DELETED"] as const) await expect(store.setState(input.conversationId,state,input.at)).rejects.toMatchObject({ code: "conversation_busy" });
      await store.begin(input.turnId);
      await expect(store.setState(input.conversationId,"ARCHIVED",input.at)).rejects.toMatchObject({ code: "conversation_busy" });
      await store.update(input.turnId,{ status: "COMPLETED",entries: [],artifacts: [] });
      const original = await store.get(input.conversationId);
      const outboxCount = f.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox").get()?.n);
      await store.setState(input.conversationId,"ARCHIVED",input.at);
      await store.setState(input.conversationId,"ARCHIVED","2026-11-12T00:00:00Z");
      expect((await store.list()).items).toEqual([]);
      expect((await store.list(true)).items[0]).toMatchObject({ archivedAt: input.at,conversationId: input.conversationId });
      await expect(store.submit({ ...input,turnId: "blocked",requestId: "blocked" })).rejects.toMatchObject({ code: "conversation_archived" });
      await store.setState(input.conversationId,"ACTIVE",input.at);
      await store.setState(input.conversationId,"ACTIVE",input.at);
      expect(await store.get(input.conversationId)).toEqual(original);
      expect((await store.list(true)).items).toEqual([]);
      await store.setState(input.conversationId,"DELETED",input.at);
      await store.setState(input.conversationId,"DELETED",input.at);
      expect(await store.get(input.conversationId)).toBeNull();
      expect((await store.list()).items).toEqual([]);
      await expect(store.setState(input.conversationId,"ACTIVE",input.at)).rejects.toMatchObject({ code: "conversation_not_found" });
      await expect(store.submit({ ...input,turnId: "reuse",requestId: "reuse" })).rejects.toMatchObject({ code: "conversation_not_found" });
      await expect(store.submit(input)).rejects.toMatchObject({ code: "conversation_not_found" });
      expect(f.database.transaction(db => db.prepare("SELECT COUNT(*) AS n FROM outbox").get()?.n)).toBe(outboxCount);
    } finally { await f.close(); }
  });
  it("CHAT-02/04/05 atomically locks the workbench and deduplicates the first turn", async () => {
    const f = await createRuntimeFixture();
    try {
      const wb = await f.workbenchRegistry.create({ name: "Chat", personaSummary: "Help", projectLabel: "Chat", scopeSummary: "General assistance" });
      const other = await f.workbenchRegistry.create({ name: "Other", personaSummary: "Help", projectLabel: "Other", scopeSummary: "Other" });
      const store = new SqliteConversationStore(f.database);
      const revision = (await f.partners.add({ capabilities: [], displayName: "Helper", kind: "local-pi", skills: [], tools: [] }));
      const request = { conversationId: "chat-fixture", turnId: "turn-fixture", requestId: "request-fixture", workbenchId: wb.workbenchId,
        text: "Explain this project", at: f.clock.now().toISOString(), config: { partnerId: revision.partnerId, partnerName: "Helper", networkId: "network", networkName: "Local network", modelName: "Configured model", skills: [], attachmentIds: [] } };
      const first = await store.submit(request);
      expect(await store.submit({ ...request, turnId: "duplicate-turn" })).toEqual(first);
      await expect(store.submit({ ...request,turnId: "conflicting-duplicate",text: "Different message" })).rejects.toMatchObject({ code: "conversation_request_conflict" });
      expect((await store.list()).items).toHaveLength(1);
      await expect(store.submit({ ...request, requestId: "another", turnId: "another", workbenchId: other.workbenchId })).rejects.toMatchObject({ code: "conversation_workbench_locked" });
      await expect(store.submit({ ...request, requestId: "parallel", turnId: "parallel" })).rejects.toMatchObject({ code: "conversation_busy" });
      expect((await store.get("chat-fixture"))?.turns[0]?.text).toBe("Explain this project");
      expect(await store.begin("turn-fixture")).toBe(true);
      expect(await store.begin("turn-fixture")).toBe(false);
      await store.recoverInterrupted(f.clock.now().toISOString());
      expect((await store.get("chat-fixture"))?.turns[0]?.status).toBe("INTERRUPTED");
      expect(await store.begin("turn-fixture")).toBe(false);
      for (let index = 0; index < 501;index++) {
        const turnId = `later-${String(index)}`;
        await store.submit({ ...request,turnId,requestId: turnId,text: `Message ${String(index)}` });
        await store.begin(turnId);await store.update(turnId,{ status: "COMPLETED",entries: [],artifacts: [] });
      }
      expect((await store.get("chat-fixture"))?.turns.at(-1)?.text).toBe("Message 500");
    } finally { await f.close(); }
  }, process.env.CI ? 60_000 : 20_000);
});
